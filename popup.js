"use strict";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Refinement loop bounds.
const MIN_ROUNDS = 2;       // always show at least one visible improvement
const MAX_ROUNDS = 4;       // hard cap on API calls per forge
const CONVERGE_SCORE = 95;  // stop early once the prompt self-scores this high

// STAGE A — decode: turn gibberish/voice into a clean English statement of intent.
const DECODE_SYSTEM = `You are an expert at understanding intent. The user gives you a raw, messy, broken-English description of what they want from an AI. Rewrite it as a clear, grammatical, plain-English statement of exactly what they want.

Fix typos, gibberish, and broken phrasing. Preserve every concrete requirement, constraint, fact, name, and number. Do NOT add requirements they did not state, do NOT answer or fulfil the request, and do NOT write a prompt yet — only restate their intent clearly and completely.

Output only the clarified intent as plain prose, with no preamble.`;

// STAGE B — the three selectable experts that structure the clean intent.
const PERSONAS = {
  prompt_engineer: {
    label: "Prompt Engineer",
    role: "You are a world-class prompt engineer.",
    style:
      "Produce a clean, natural-language prompt that follows best practices. Lead with the core task stated specifically; assign a role only when it measurably helps. Use light structure (short labeled sections or delimiters) only when the task is complex enough to warrant it.",
  },
  context_engineer: {
    label: "Context Engineer",
    role: "You are a world-class context engineer.",
    style:
      "Curate the minimal set of high-signal context the model needs — every section must earn its place; cut anything that does not change behavior (attention budget). Use clearly labeled sections via XML tags or markdown headers, in this order: Role, Background/Context, Task, Constraints, Output format, and — only if they genuinely help — 2 to 4 diverse canonical Examples. Front-load the most important context. Aim for the right altitude: specific enough to steer behavior, but provide strong heuristics rather than brittle if/else rules or vague hand-waving. Prefer a few canonical examples over exhaustive lists of edge cases.",
  },
  json_prompter: {
    label: "JSON Prompter",
    role: "You are an expert at authoring structured JSON prompts for programmatic use.",
    style:
      'Produce the prompt as a single valid JSON object. Use clear, descriptive keys with explicit value types; include only the fields that apply, such as "role", "context", "task", "constraints", "output_format", and "examples". Keep the structure flat — avoid deep nesting, which raises failure rates. For constrained fields use enums (e.g. "tone": "formal | casual"). Order fields so reasoning/context comes before the task and final output. Specify a sensible default or null for anything that may be missing, and add a short description to non-obvious fields. The JSON object itself is the deliverable prompt — emit only valid JSON.',
  },
};

// One-line "what & when" shown live under the expert selector.
const PERSONA_HINTS = {
  prompt_engineer: "✓ Recommended — a clean natural-language prompt. Best for most tasks; start here.",
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

// Build the round-based, self-critiquing system prompt for the chosen expert.
function buildStructureSystem(personaKey) {
  const p = PERSONAS[personaKey] || PERSONAS.prompt_engineer;
  const promptFieldNote =
    personaKey === "json_prompter"
      ? " (which, for you, means ONLY the JSON object — still emitted as a JSON string inside this field)"
      : "";
  return `${p.role} You refine prompts through iterative self-critique.

You are given a clarified statement of what a user wants from an AI, and — after round 1 — your own previous best prompt. Each round you must:
1. Critique the CURRENT prompt (on round 1, critique how best to turn the intent into a prompt). Be specific and honest about what is vague, missing, redundant, or poorly structured.
2. Produce an improved version of the prompt that fixes those issues. If it is already excellent, make only minimal changes rather than padding it.
3. Score the improved prompt on four dimensions, each 0–100 and honestly differentiated (do not give everything the same number):
   - clarity: unambiguous and easy for the target AI to follow.
   - specificity: concrete task, audience, and definition of done — not vague.
   - structure: organized appropriately for this task (role, sections, output format as needed).
   - completeness: captures every requirement, constraint, and the desired output — nothing missing, nothing invented.
4. Set done = true when further changes would only be cosmetic.

${p.style}

Always: make implicit requirements explicit; resolve ambiguity with the most reasonable interpretation and never ask the user questions; cut filler and stay token-efficient; specify output format, length, or structure when it matters; preserve every concrete requirement, constraint, fact, name, and number from the intent, and never invent specifics; address the executing AI in the second person.

The "prompt" field must contain ONLY the prompt itself${promptFieldNote} — no preamble, no surrounding commentary, no markdown code fences.

Respond with ONLY a JSON object, no other text:
{"critique": "<what you improved and why, one or two sentences>", "prompt": "<the improved prompt>", "scores": {"clarity": <0-100>, "specificity": <0-100>, "structure": <0-100>, "completeness": <0-100>}, "done": <true|false>}`;
}

// JSON Schema for the per-round verdict — passed to Structured Outputs so the
// response is guaranteed to parse. (score range isn't expressible in the schema,
// so it's clamped in parseRound.)
const SCORE_DIMS = [
  ["clarity", "Clarity"],
  ["specificity", "Specificity"],
  ["structure", "Structure"],
  ["completeness", "Completeness"],
];

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    critique: { type: "string" },
    prompt: { type: "string" },
    scores: {
      type: "object",
      properties: {
        clarity: { type: "integer" },
        specificity: { type: "integer" },
        structure: { type: "integer" },
        completeness: { type: "integer" },
      },
      required: ["clarity", "specificity", "structure", "completeness"],
      additionalProperties: false,
    },
    done: { type: "boolean" },
  },
  required: ["critique", "prompt", "scores", "done"],
  additionalProperties: false,
};

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
  pre.textContent = "💡 Looks like a fit for ";
  const link = document.createElement("button");
  link.type = "button";
  link.className = "suggest-link";
  link.textContent = label;
  link.addEventListener("click", () => setPersona(s, true));
  const post = document.createElement("span");
  post.textContent = " — tap to switch.";
  els.personaSuggest.append(pre, link, post);
  els.personaSuggest.hidden = false;
}

function saveSettings() {
  if (!hasStorage()) {
    setStatus(els.settingsStatus, "Storage unavailable — load this as an installed extension.", "error");
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

  // STAGE A — decode the gibberish into clear English intent.
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
    setStatus(els.status, "Couldn't read that — try again.", "error");
    setBusy(false);
    return;
  }
  els.understoodText.value = intent;
  els.understood.hidden = false;

  // STAGE B — structure + refine.
  await runStructureLoop({ apiKey, model, intent, ctx, raw });
}

// Re-run only the structure loop using the (possibly edited) Understood intent —
// skips decode, so user corrections to the intent take effect directly.
async function structureFromEditedIntent() {
  const intent = els.understoodText.value.trim();
  if (!intent) { setStatus(els.status, "The intent is empty — type one or forge from scratch.", "error"); return; }

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

async function decode({ apiKey, model, raw }) {
  const text = await callClaude({ apiKey, model, system: DECODE_SYSTEM, userPrompt: raw });
  return cleanOutput(text);
}

function contextBlock(ctx) {
  return ctx
    ? `Standing context about the user and their work (use it to tailor role, tone, terminology, and constraints where relevant; do NOT add requirements that conflict with the intent, and ignore parts that aren't relevant):\n"""\n${ctx}\n"""\n\n`
    : "";
}

function draftMessage(intent, raw, ctx) {
  return (
    contextBlock(ctx) +
    `Clarified user intent:\n"""\n${intent}\n"""\n\n` +
    `(Original raw words, for reference only: ${raw})\n\n` +
    `This is round 1. Decide how best to turn this intent into a prompt, then produce the first engineered version.`
  );
}

function refineMessage(intent, prev, ctx) {
  const scoreLine = prev.score != null ? ` (you scored it ${prev.score}/100)` : "";
  return (
    contextBlock(ctx) +
    `Clarified user intent:\n"""\n${intent}\n"""\n\n` +
    `Your current best prompt${scoreLine}:\n"""\n${prev.prompt}\n"""\n\n` +
    (prev.critique ? `Your previous critique: ${prev.critique}\n\n` : "") +
    `This is round ${prev.round + 1}. Critique this current prompt and produce a sharper, improved version. If it is already excellent and further edits would only be cosmetic, keep it essentially as-is and set done to true.`
  );
}

// Get the verdict with Structured Outputs (guaranteed-parseable JSON). If the API
// rejects the output_config field (older endpoint/model/region), fall back to
// prompt-guided JSON — the system prompt already requests the same shape and
// parseRound is defensive either way.
async function callClaudeForVerdict(opts) {
  try {
    return await callClaude({ ...opts, schema: VERDICT_SCHEMA });
  } catch (err) {
    if (err.status === 400) return await callClaude(opts);
    throw err;
  }
}

async function callClaude({ apiKey, model, system, userPrompt, schema }) {
  const body = {
    model,
    max_tokens: 2000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userPrompt }],
  };
  if (schema) {
    body.output_config = { format: { type: "json_schema", schema } };
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch (_) {}
    const e = new Error(detail || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "text");
  return block ? block.text : "";
}

// Parse one round's JSON verdict; fall back to treating the text as a plain
// prompt (and stopping the loop) if the model didn't return clean JSON.
function parseRound(text, round) {
  let raw = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      const o = JSON.parse(raw.slice(s, e + 1));
      const prompt = cleanOutput(String(o.prompt != null ? o.prompt : "")).trim();
      if (prompt) {
        const src = o.scores && typeof o.scores === "object" ? o.scores : {};
        const scores = {};
        let sum = 0, n = 0;
        SCORE_DIMS.forEach(([k]) => {
          const v = Number(src[k]);
          if (Number.isFinite(v)) {
            const c = Math.max(0, Math.min(100, Math.round(v)));
            scores[k] = c; sum += c; n++;
          }
        });
        // overall = average of the dimensions; fall back to a top-level score if present
        let score = n ? Math.round(sum / n) : null;
        if (score == null && Number.isFinite(Number(o.score))) {
          score = Math.max(0, Math.min(100, Math.round(Number(o.score))));
        }
        return {
          round,
          critique: String(o.critique != null ? o.critique : "").trim(),
          prompt,
          score,
          scores: n ? scores : null,
          done: !!o.done,
        };
      }
    } catch (_) {}
  }

  const p = cleanOutput(raw);
  return p ? { round, critique: "", prompt: p, score: null, scores: null, done: true } : null;
}

function cleanOutput(text) {
  let t = (text || "").trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  if (t.length > 1 && /^["'](.|\n)*["']$/.test(t)) t = t.slice(1, -1).trim();
  return t;
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

// Per-dimension score bars for the active round — makes the headline number explainable.
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

// The "what changed & why" trail — one line per round's critique, built live.
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

// Open the current prompt prefilled in a target AI, with the full prompt copied
// to the clipboard as a reliable carrier (prefill is best-effort; long prompts
// or unsupported params fall back to paste).
function sendTo(target, btn) {
  const prompt = els.outputText.textContent || "";
  if (!prompt) return;
  const enc = encodeURIComponent(prompt);
  const short = enc.length < 1800; // keep URLs well under length limits
  let url;
  if (target === "chatgpt") url = short ? "https://chatgpt.com/?q=" + enc : "https://chatgpt.com/";
  else if (target === "claude") url = short ? "https://claude.ai/new?q=" + enc : "https://claude.ai/new";
  else url = "https://gemini.google.com/app";

  if (navigator.clipboard) navigator.clipboard.writeText(prompt).catch(() => {});
  window.open(url, "_blank", "noopener");

  if (btn) {
    const prev = btn.textContent;
    btn.textContent = "Copied ✓";
    btn.classList.add("sent");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("sent"); }, 1300);
  }
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const prev = btn.textContent;
    btn.textContent = "Copied ✓";
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
    els.historyList.appendChild(emptyRow("History needs the installed extension — storage isn't available here."));
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
  star.textContent = e.starred ? "★" : "☆";
  star.title = e.starred ? "Unstar" : "Star";
  star.addEventListener("click", () => toggleStar(e.id));

  const meta = document.createElement("span");
  meta.className = "hist-meta";
  const scoreStr = e.score != null ? `${e.score}/100` : "—";
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
  if (s === 401) return "Invalid API key. Check it in Settings (⚙).";
  if (s === 429) return "Rate limited or out of credits. Try again shortly.";
  if (s === 400) return "Request rejected: " + (err.message || "bad request") + ".";
  if (s >= 500) return "Anthropic API error. Try again in a moment.";
  if (err.message && /Failed to fetch/i.test(err.message)) return "Network error — couldn't reach the API.";
  return err.message || "Something went wrong.";
}
