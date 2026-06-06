"use strict";
/*
 * PromptForge inline button. Injects a floating "✨ Forge" button on
 * chatgpt.com / claude.ai / gemini.google.com. Reads whatever you've typed in
 * the chat composer, sends it to the background worker to run the forge
 * pipeline, and writes the engineered prompt back into the composer.
 *
 * Per-site DOM is inherently fragile - selectors are best-effort with a generic
 * fallback (largest visible editable). If a site changes its markup, update
 * findComposer() / the SELECTORS map.
 */
(function () {
  const HOST = location.host;

  const SELECTORS = {
    "chatgpt.com": ["#prompt-textarea", "form textarea", 'div[contenteditable="true"]'],
    "chat.openai.com": ["#prompt-textarea", "form textarea", 'div[contenteditable="true"]'],
    "claude.ai": ['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"]'],
    "gemini.google.com": ['.ql-editor[contenteditable="true"]', "rich-textarea .ql-editor", '[contenteditable="true"]'],
  };

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 80 && r.height > 16 && getComputedStyle(el).visibility !== "hidden";
  }

  // Find the chat composer: try site selectors, then fall back to the largest
  // visible textarea / contenteditable on the page.
  function findComposer() {
    const sels = SELECTORS[HOST] || [];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (visible(el)) return el;
    }
    const cands = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible);
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return cands[0];
  }

  function readText(el) {
    if (!el) return "";
    return el.tagName === "TEXTAREA" ? el.value : el.innerText;
  }

  // Write text in a way the site's framework (React / ProseMirror / Quill) notices.
  function setText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // contenteditable: select all, then insertText (fires the right input events)
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      const ok = document.execCommand("insertText", false, text);
      if (!ok) throw new Error("execCommand failed");
    } catch (_) {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  /* ---------- UI ---------- */

  let fab, busy = false;

  function ensureFab() {
    if (fab && document.body.contains(fab)) return;
    fab = document.createElement("button");
    fab.id = "pf-fab";
    fab.type = "button";
    fab.textContent = "✦ Forge";
    fab.title = "Optimize what you typed with PromptForge";
    fab.addEventListener("click", onForge);
    document.body.appendChild(fab);
  }

  function setFab(state, label) {
    if (!fab) return;
    fab.dataset.state = state || "";
    fab.textContent = label;
    fab.disabled = state === "busy";
  }

  function flash(label, state) {
    setFab(state || "", label);
    setTimeout(() => { if (!busy) setFab("", "✦ Forge"); }, 1600);
  }

  function onForge() {
    if (busy) return;
    const composer = findComposer();
    if (!composer) { flash("Click into the chat box first", "warn"); return; }
    const raw = readText(composer).trim();
    if (!raw) { flash("Type a rough prompt first", "warn"); return; }

    busy = true;
    setFab("busy", "Forging…");
    chrome.runtime.sendMessage({ type: "pf-forge", raw }, (resp) => {
      busy = false;
      if (chrome.runtime.lastError) { flash("Extension reloaded - refresh page", "warn"); return; }
      if (!resp || !resp.ok) {
        if (resp && resp.error === "nokey") flash("Add your Anthropic key in the popup", "warn");
        else flash((resp && resp.error) ? resp.error.slice(0, 40) : "Forge failed", "warn");
        return;
      }
      const target = findComposer() || composer;
      setText(target, resp.prompt);
      flash("Forged ✓", "ok");
    });
  }

  // A prompt sent from the popup ("Open in ChatGPT/Claude/Gemini") is parked in
  // storage; insert it into the composer once this site's composer exists.
  function tryInsertPending() {
    if (!chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(["pf_pending"], (d) => {
      const p = d && d.pf_pending;
      if (!p || !p.prompt) return;
      if (Date.now() - (p.ts || 0) > 60000) { chrome.storage.local.remove("pf_pending"); return; }
      let tries = 0;
      const timer = setInterval(() => {
        const c = findComposer();
        if (c) {
          clearInterval(timer);
          chrome.storage.local.remove("pf_pending");
          setText(c, p.prompt);
          flash("Inserted ✓", "ok");
        } else if (++tries > 24) {
          clearInterval(timer); // ~12s; leave pf_pending so a manual reload can retry
        }
      }, 500);
    });
  }

  // Inject once the page is ready, and keep it present across SPA navigation.
  function boot() {
    ensureFab();
    setInterval(ensureFab, 3000);
    setTimeout(tryInsertPending, 400);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
