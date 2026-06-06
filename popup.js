"use strict";

// Pipeline (constants, DECODE_SYSTEM, PERSONAS, buildStructureSystem, VERDICT_SCHEMA,
// SCORE_DIMS, callClaude, parseRound, decode, message builders…) lives in engine.js,
// loaded before this script. This file is the popup UI + orchestration only.

// One-line "what & when" shown live under the expert selector.
const PERSONA_HINTS = {
  prompt_engineer: "Recommended. A clean natural-language prompt, best for most tasks. Start here.",
  context_engineer: "Structured sections (Role · Context · Task · Constraints · Output). Best for complex or reusable prompts.",
  json_prompter: "The prompt as a JSON object. Best when code, an API, or a template will consume it.",
};

// Heuristic: suggest a non-default expert when the input clearly calls for one.
function suggestPersona(text) {
  const t = (text || "").toLowerCase();
  if (/\b(json|api|schema|endpoint|payload|programmatic|tool call|function call|structured output|webhook|sdk|parse|integrat)/.test(t)) return "json_prompter";
  if (/\b(system prompt|agent|persona|guidelines|policy|rubric|multi-step|workflow|knowledge base|\brag\b|instructions for|onboarding)/.test(t) || t.length > 320) return "context_engineer";
  return "prompt_engineer";
}

const els = {};
function $(id) { return document.getElementById(id); }

let history = [];      // [{round, critique, prompt, score, done}]
let activeIndex = 0;
let finalized = false;
let selectedPersona = "prompt_engineer";

document.addEventListener("DOMContentLoaded", init);

function init() {
  [
    "forgeView", "settingsView", "historyView",
    "settingsBtn", "historyBtn", "backBtn", "historyBackBtn",
    "raw", "forgeBtn", "keyBtn", "status", "personaHint", "personaSuggest",
    "contextBar", "useContext", "editContextBtn",
    "understood", "understoodText", "reintentBtn",
    "convergence", "output", "outputLabel", "scoreBreakdown", "outputText", "sendRow", "changeSummary",
    "copyBtn", "redoBtn",
    "historyList", "clearHistoryBtn",
    "apiKey", "model", "userContext", "saveSettingsBtn", "settingsStatus",
  ].forEach((id) => (els[id] = $(id)));

  els.settingsBtn.addEventListener("click", () => showView("settings"));
  els.backBtn.addEventListener("click", () => showView("forge"));
  els.historyBtn.addEventListener("click", () => { renderHistory(); showView("history"); });
  els.historyBackBtn.addEventListener("click", () => showView("forge"));
  els.clearHistoryBtn.addEventListener("click", clearHistory);
  els.saveSettingsBtn.addEventListener("click", saveSettings);
  els.forgeBtn.addEventListener("click", forge);
  els.redoBtn.addEventListener("click", forge);
  els.reintentBtn.addEventListener("click", structureFromEditedIntent);
  els.copyBtn.addEventListener("click", () => copyText(els.outputText.textContent, els.copyBtn));
  els.keyBtn.addEventListener("click", () => {
    showView("settings");
    setTimeout(() => els.apiKey.focus(), 50);
  });
  els.editContextBtn.addEventListener("click", () => {
    showView("settings");
    setTimeout(() => els.userContext.focus(), 50);
  });
  els.useContext.addEventListener("change", () => {
    if (hasStorage()) store.set({ useContext: els.useContext.checked });
  });

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => setPersona(btn.dataset.persona, true));
  });

  els.raw.addEventListener("input", onRawInput);

  document.querySelectorAll(".send-btn").forEach((b) => {
    b.addEventListener("click", () => sendTo(b.dataset.target, b));
  });

  setPersona(selectedPersona, false); // initialize the hint line
  loadState();
}

function showView(which) {
  els.forgeView.hidden = which !== "forge";
  els.settingsView.hidden = which !== "settings";
  els.historyView.hidden = which !== "history";
}

/* ----------------------------- storage ----------------------------- */

function hasChromeStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
}
function hasStorage() {
  return hasChromeStorage() || typeof localStorage !== "undefined";
}

// Storage abstraction: chrome.storage.local inside the installed extension,
// localStorage when running as a plain page (e.g. served on localhost). Same
// async-callback shape either way so call sites don't care which is active.
const store = {
  get(keys, cb) {
    if (hasChromeStorage()) return chrome.storage.local.get(keys, cb);
    const out = {};
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
      const v = localStorage.getItem("pf_" + k);
      if (v != null) { try { out[k] = JSON.parse(v); } catch (_) { out[k] = v; } }
    });
    cb(out);
  },
  set(obj, cb) {
    if (hasChromeStorage()) return chrome.storage.local.set(obj, cb);
    Object.keys(obj).forEach((k) => localStorage.setItem("pf_" + k, JSON.stringify(obj[k])));
    if (cb) cb();
  },
};

function loadState() {
  if (!hasStorage()) return;
  store.get(["apiKey", "model", "persona", "context", "useContext"], (data) => {
    if (data.apiKey) els.apiKey.value = data.apiKey;
    els.model.value = data.model || DEFAULT_MODEL;
    if (data.context) els.userContext.value = data.context;
    els.useContext.checked = data.useContext !== false;
    if (data.persona && PERSONAS[data.persona]) setPersona(data.persona, false);
    updateContextBar();
    if (!data.apiKey) showView("settings");
  });
}

// Show the "personalize with your context" toggle only when a context is saved.
function updateContextBar() {
  if (!hasStorage()) { els.contextBar.hidden = true; return; }
  store.get(["context", "useContext"], (d) => {
    const has = !!(d.context && d.context.trim());
    els.contextBar.hidden = !has;
    if (has) els.useContext.checked = d.useContext !== false;
  });
}

function setPersona(key, persist) {
  if (!PERSONAS[key]) return;
  selectedPersona = key;
  document.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.persona === key)
  );
  if (els.personaHint) els.personaHint.textContent = PERSONA_HINTS[key] || "";
  updatePersonaSuggest();
  if (persist && hasStorage()) store.set({ persona: key });
}

let suggestTimer = null;
function onRawInput() {
  if (suggestTimer) clearTimeout(suggestTimer);
  suggestTimer = setTimeout(updatePersonaSuggest, 250);
}

// Proactively nudge toward a better-fitting expert (never auto-switches).
function updatePersonaSuggest() {
  if (!els.personaSuggest) return;
  const s = suggestPersona(els.raw.value);
  if (!els.raw.value.trim() || s === "prompt_engineer" || s === selectedPersona) {
    els.personaSuggest.hidden = true;
    els.personaSuggest.innerHTML = "";
    return;
  }
  const label = (PERSONAS[s] || {}).label || s;
  els.personaSuggest.innerHTML = "";
  const pre = document.createElement("span");
  pre.textContent = "Looks like a fit for ";
  const link = document.createElement("button");
  link.type = "button";
  link.className = "suggest-link";
  link.textContent = label;
  link.addEventListener("click", () => setPersona(s, true));
  const post = document.createElement("span");
  post.textContent = " (tap to switch).";
  els.personaSuggest.append(pre, link, post);
  els.personaSuggest.hidden = false;
}

function saveSettings() {
  if (!hasStorage()) {
    setStatus(els.settingsStatus, "Storage unavailable - load this as an installed extension.", "error");
    return;
  }
  store.set(
    { apiKey: els.apiKey.value.trim(), model: els.model.value, context: els.userContext.value.trim() },
    () => {
      setStatus(els.settingsStatus, "Saved.", "ok");
      updateContextBar();
      setTimeout(() => { hideStatus(els.settingsStatus); showView("forge"); }, 700);
    }
  );
}

function getSettings() {
  return new Promise((resolve) => {
    if (!hasStorage()) return resolve({ apiKey: "", model: DEFAULT_MODEL, context: "" });
    store.get(["apiKey", "model", "context"], (d) =>
      resolve({
        apiKey: (d.apiKey || "").trim(),
        model: d.model || DEFAULT_MODEL,
        context: (d.context || "").trim(),
      })
    );
  });
}

/* ----------------------------- refine loop ----------------------------- */

// Full pipeline: decode the raw input, then run the structure loop.
async function forge() {
  const raw = els.raw.value.trim();
  if (!raw) { setStatus(els.status, "Type something first.", "error"); return; }

  const { apiKey, model, context } = await getSettings();
  if (!apiKey) {
    showView("settings");
    setStatus(els.settingsStatus, "Add your Anthropic API key first.", "error");
    setTimeout(() => els.apiKey.focus(), 50);
    return;
  }
  const ctx = activeContext(context);

  resetForgeOutputs();
  els.understood.hidden = true;
  els.understoodText.value = "";
  setBusy(true);

  // STAGE A - decode the gibberish into clear English intent.
  let intent;
  try {
    setStatus(els.status, '<span class="spinner"></span>Understanding what you mean…', "loading");
    intent = await decode({ apiKey, model, raw });
  } catch (err) {
    setStatus(els.status, friendlyError(err), "error");
    setBusy(false);
    return;
  }
  if (!intent) {
    setStatus(els.status, "Couldn't read that - try again.", "error");
    setBusy(false);
    return;
  }
  els.understoodText.value = intent;
  els.understood.hidden = false;

  // STAGE B - structure + refine.
  await runStructureLoop({ apiKey, model, intent, ctx, raw });
}

// Re-run only the structure loop using the (possibly edited) Understood intent - // skips decode, so user corrections to the intent take effect directly.
async function structureFromEditedIntent() {
  const intent = els.understoodText.value.trim();
  if (!intent) { setStatus(els.status, "The intent is empty - type one or forge from scratch.", "error"); return; }

  const { apiKey, model, context } = await getSettings();
  if (!apiKey) {
    showView("settings");
    setStatus(els.settingsStatus, "Add your Anthropic API key first.", "error");
    setTimeout(() => els.apiKey.focus(), 50);
    return;
  }
  resetForgeOutputs();
  await runStructureLoop({ apiKey, model, intent, ctx: activeContext(context), raw: els.raw.value.trim() });
}

// The expert builds + self-critiques the prompt over rounds.
async function runStructureLoop({ apiKey, model, intent, ctx, raw }) {
  setBusy(true);
  try {
    const system = buildStructureSystem(selectedPersona);
    const expert = (PERSONAS[selectedPersona] || PERSONAS.prompt_engineer).label;

    let round = 0, best = null;
    while (round < MAX_ROUNDS) {
      round++;
      setStatus(els.status, `<span class="spinner"></span>Forging with ${expert}… round ${round} of up to ${MAX_ROUNDS}`, "loading");

      const userPrompt = round === 1 ? draftMessage(intent, raw, ctx) : refineMessage(intent, best, ctx);
      const text = await callClaudeForVerdict({ apiKey, model, system, userPrompt });
      const parsed = parseRound(text, round);
      if (!parsed) throw new Error("Couldn't read the model's response. Try again.");

      history.push(parsed);
      best = parsed;
      els.output.hidden = false;
      setActive(history.length - 1);
      renderTrail();

      if (round >= MIN_ROUNDS && (parsed.done || parsed.score >= CONVERGE_SCORE)) break;
    }
    finalize();
    renderTrail();
    saveForge(raw);
    hideStatus(els.status);
  } catch (err) {
    setStatus(els.status, friendlyError(err), "error");
  } finally {
    setBusy(false);
  }
}

function activeContext(context) {
  return (!els.contextBar.hidden && els.useContext.checked) ? context : "";
}

function resetForgeOutputs() {
  history = [];
  activeIndex = 0;
  finalized = false;
  els.convergence.innerHTML = "";
  els.convergence.hidden = true;
  els.output.hidden = true;
  els.changeSummary.hidden = true;
  els.scoreBreakdown.hidden = true;
}

function setBusy(busy) {
  els.forgeBtn.disabled = busy;
  els.redoBtn.disabled = busy;
  els.reintentBtn.disabled = busy;
}

/* ----------------------------- render ----------------------------- */

function bestIndex() {
  let bi = 0, bs = -1;
  history.forEach((h, i) => {
    const sc = h.score == null ? -0.5 : h.score;
    if (sc >= bs) { bs = sc; bi = i; } // ties → latest round
  });
  return bi;
}

// Show one round's prompt in the output card and rebuild the convergence strip.
function setActive(i) {
  activeIndex = i;
  const h = history[i];
  els.outputText.textContent = h.prompt;
  renderBreakdown(h);

  if (finalized) {
    const n = history.length;
    els.outputLabel.textContent = `Final prompt · refined over ${n} round${n > 1 ? "s" : ""}`;
  } else {
    els.outputLabel.textContent = `Refining · round ${h.round}`;
  }

  renderConvergence();
}

// Per-dimension score bars for the active round - makes the headline number explainable.
function renderBreakdown(h) {
  const el = els.scoreBreakdown;
  el.innerHTML = "";
  if (!h || !h.scores) { el.hidden = true; return; }
  el.hidden = false;
  SCORE_DIMS.forEach(([key, label]) => {
    const v = h.scores[key];
    if (v == null) return;
    const row = document.createElement("div");
    row.className = "sb-row";
    const name = document.createElement("span");
    name.className = "sb-name";
    name.textContent = label;
    const track = document.createElement("span");
    track.className = "sb-track";
    const fill = document.createElement("span");
    fill.className = "sb-fill";
    fill.style.width = v + "%";
    fill.style.background = v >= 90 ? "var(--ok)" : v >= 70 ? "var(--accent)" : "#e0a23c";
    track.appendChild(fill);
    const num = document.createElement("span");
    num.className = "sb-num";
    num.textContent = v;
    row.append(name, track, num);
    el.appendChild(row);
  });
}

// The "what changed & why" trail - one line per round's critique, built live.
function renderTrail() {
  const rows = history.filter((h) => h.critique);
  els.changeSummary.innerHTML = "";
  if (!rows.length) { els.changeSummary.hidden = true; return; }
  els.changeSummary.hidden = false;

  const head = document.createElement("div");
  head.className = "summary-head";
  head.textContent = finalized ? "What improved" : "Refining…";
  els.changeSummary.appendChild(head);

  history.forEach((h) => {
    if (!h.critique) return;
    const row = document.createElement("div");
    row.className = "summary-row";
    const tag = document.createElement("span");
    tag.className = "summary-tag";
    tag.textContent = "R" + h.round + (h.score != null ? " · " + h.score : "");
    const txt = document.createElement("span");
    txt.textContent = h.critique;
    row.append(tag, txt);
    els.changeSummary.appendChild(row);
  });
}

function renderConvergence() {
  els.convergence.hidden = history.length === 0;
  els.convergence.innerHTML = "";
  const bi = finalized ? bestIndex() : -1;

  history.forEach((h, i) => {
    if (i > 0) {
      const arrow = document.createElement("span");
      arrow.className = "conv-arrow";
      arrow.textContent = "→";
      els.convergence.appendChild(arrow);
    }
    const chip = document.createElement("button");
    chip.className =
      "round-chip" + (i === activeIndex ? " active" : "") + (i === bi ? " best" : "");
    chip.title = "Model's self-rated quality for this round";
    chip.innerHTML =
      `R${h.round}` + (h.score != null ? ` · <span class="rc-score">${h.score}</span>` : "");
    chip.addEventListener("click", () => setActive(i));
    els.convergence.appendChild(chip);
  });
}

function finalize() {
  finalized = true;
  setActive(bestIndex());
}

// Open the target AI and drop the prompt into its composer. Primary path: hand
// the prompt to our content script via storage, which inserts it on the site
// (reliable, since URL ?q= params aren't honored consistently). Clipboard is the
// guaranteed fallback so you can always paste.
function sendTo(target, btn) {
  const prompt = els.outputText.textContent || "";
  if (!prompt) return;
  const urls = {
    chatgpt: "https://chatgpt.com/",
    claude: "https://claude.ai/new",
    gemini: "https://gemini.google.com/app",
  };
  const url = urls[target] || urls.chatgpt;

  // Hand off to the content script (installed extension only - content scripts
  // don't run on a localhost web page, where clipboard paste is the path).
  if (hasChromeStorage()) store.set({ pf_pending: { prompt, ts: Date.now() } });
  if (navigator.clipboard) navigator.clipboard.writeText(prompt).catch(() => {});
  window.open(url, "_blank", "noopener");

  if (btn) {
    const prev = btn.textContent;
    btn.textContent = "Sent";
    btn.classList.add("sent");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("sent"); }, 1300);
  }
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const prev = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove("copied");
    }, 1300);
  });
}

/* ----------------------------- history ----------------------------- */

const HISTORY_CAP = 50;

// Persist the just-finished forge (best round) to chrome.storage.local.
function saveForge(input) {
  if (!hasStorage() || !history.length) return;
  const best = history[bestIndex()];
  const p = PERSONAS[selectedPersona] || PERSONAS.prompt_engineer;
  const entry = {
    id: String(Date.now()) + "-" + history.length,
    ts: Date.now(),
    input,
    personaKey: selectedPersona,
    personaLabel: p.label,
    prompt: best.prompt,
    score: best.score,
    rounds: history.length,
    starred: false,
  };
  store.get(["forges"], (d) => {
    const list = Array.isArray(d.forges) ? d.forges : [];
    list.unshift(entry);
    store.set({ forges: trimForges(list) });
  });
}

// Cap the log, but never drop starred entries.
function trimForges(list, cap = HISTORY_CAP) {
  if (list.length <= cap) return list;
  const starredCount = list.filter((e) => e.starred).length;
  let keptUnstarred = 0;
  return list.filter((e) => {
    if (e.starred) return true;
    if (keptUnstarred < Math.max(0, cap - starredCount)) { keptUnstarred++; return true; }
    return false;
  });
}

function renderHistory() {
  els.historyList.innerHTML = "";
  if (!hasStorage()) {
    els.historyList.appendChild(emptyRow("History needs the installed extension - storage isn't available here."));
    return;
  }
  store.get(["forges"], (d) => {
    const list = (Array.isArray(d.forges) ? d.forges.slice() : []);
    if (!list.length) {
      els.historyList.appendChild(emptyRow("No forges yet. Forge a prompt and it'll show up here."));
      return;
    }
    list.sort((a, b) => (Number(b.starred) - Number(a.starred)) || (b.ts - a.ts));
    list.forEach((e) => els.historyList.appendChild(historyCard(e)));
  });
}

function emptyRow(msg) {
  const div = document.createElement("div");
  div.className = "history-empty";
  div.textContent = msg;
  return div;
}

function historyCard(e) {
  const card = document.createElement("div");
  card.className = "hist-card";

  const top = document.createElement("div");
  top.className = "hist-top";

  const star = document.createElement("button");
  star.className = "hist-star" + (e.starred ? " on" : "");
  star.innerHTML = e.starred
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.6l2.7 6 6.6.5-5 4.3 1.5 6.4L12 16.9 6.2 19.8l1.5-6.4-5-4.3 6.6-.5z"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.2l2.6 5.6 6.1.5-4.6 4 1.4 6L12 16.6 6.1 19.3l1.4-6-4.6-4 6.1-.5z"/></svg>';
  star.title = e.starred ? "Unstar" : "Star";
  star.addEventListener("click", () => toggleStar(e.id));

  const meta = document.createElement("span");
  meta.className = "hist-meta";
  const scoreStr = e.score != null ? `${e.score}/100` : "-";
  meta.textContent = `${e.personaLabel} · ${scoreStr} · ${e.rounds} round${e.rounds > 1 ? "s" : ""} · ${relTime(e.ts)}`;

  top.append(star, meta);

  const inp = document.createElement("div");
  inp.className = "hist-input";
  inp.textContent = e.input;
  inp.title = e.input;

  const actions = document.createElement("div");
  actions.className = "hist-actions";

  const copyB = document.createElement("button");
  copyB.className = "hist-btn";
  copyB.textContent = "Copy";
  copyB.addEventListener("click", () => copyText(e.prompt, copyB));

  const reB = document.createElement("button");
  reB.className = "hist-btn";
  reB.textContent = "Re-forge";
  reB.addEventListener("click", () => reforge(e));

  const delB = document.createElement("button");
  delB.className = "hist-btn danger";
  delB.textContent = "Delete";
  delB.addEventListener("click", () => deleteForge(e.id));

  actions.append(copyB, reB, delB);
  card.append(top, inp, actions);
  return card;
}

function toggleStar(id) {
  if (!hasStorage()) return;
  store.get(["forges"], (d) => {
    const list = (d.forges || []).map((e) => (e.id === id ? { ...e, starred: !e.starred } : e));
    store.set({ forges: list }, renderHistory);
  });
}

function deleteForge(id) {
  if (!hasStorage()) return;
  store.get(["forges"], (d) => {
    const list = (d.forges || []).filter((e) => e.id !== id);
    store.set({ forges: list }, renderHistory);
  });
}

function clearHistory() {
  if (!hasStorage()) return;
  if (typeof confirm === "function" && !confirm("Clear all saved forges? Starred ones too.")) return;
  store.set({ forges: [] }, renderHistory);
}

// Load a past forge back into the editor and run it again.
function reforge(e) {
  els.raw.value = e.input;
  setPersona(e.personaKey, true);
  showView("forge");
  forge();
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

/* ----------------------------- helpers ----------------------------- */

function setStatus(el, html, kind) {
  el.innerHTML = html;
  el.className = "status" + (kind ? " " + kind : "");
  el.hidden = false;
}
function hideStatus(el) { el.hidden = true; el.innerHTML = ""; }

function friendlyError(err) {
  const s = err.status;
  if (s === 401) return "Invalid API key. Check it in Settings.";
  if (s === 429) return "Rate limited or out of credits. Try again shortly.";
  if (s === 400) return "Request rejected: " + (err.message || "bad request") + ".";
  if (s >= 500) return "Anthropic API error. Try again in a moment.";
  if (err.message && /Failed to fetch/i.test(err.message)) return "Network error - couldn't reach the API.";
  return err.message || "Something went wrong.";
}
