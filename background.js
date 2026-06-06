"use strict";
/*
 * PromptForge background service worker.
 * Runs the forge pipeline for the inline content-script button (chatgpt.com /
 * claude.ai / gemini.google.com). The API call lives here (not in the content
 * script) so it isn't blocked by each site's Content-Security-Policy.
 *
 * The pipeline itself is the shared engine - single source of truth with the popup.
 */

importScripts("engine.js");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "pf-forge") return;
  (async () => {
    try {
      const cfg = await new Promise((resolve) =>
        chrome.storage.local.get(["apiKey", "model", "persona", "context", "useContext"], resolve)
      );
      const apiKey = (cfg.apiKey || "").trim();
      if (!apiKey) { sendResponse({ ok: false, error: "nokey" }); return; }
      const model = cfg.model || DEFAULT_MODEL;
      const persona =
        msg.persona && PERSONAS[msg.persona] ? msg.persona
        : cfg.persona && PERSONAS[cfg.persona] ? cfg.persona
        : "prompt_engineer";
      const context = cfg.useContext !== false && cfg.context ? String(cfg.context).trim() : "";
      const { best } = await runForgePipeline({ apiKey, model, raw: String(msg.raw || ""), persona, context });
      sendResponse({ ok: true, prompt: best.prompt, score: best.score, persona, personaLabel: PERSONAS[persona].label });
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || "Forge failed" });
    }
  })();
  return true; // keep the message channel open for the async response
});
