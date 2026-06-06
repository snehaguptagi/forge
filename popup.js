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
3. Score the improved prompt from 0 to 100 on how well-engineered it is.
4. Set done = true when further changes would only be cosmetic.

${p.style}

Always: make implicit requirements explicit; resolve ambiguity with the most reasonable interpretation and never ask the user questions; cut filler and stay token-efficient; specify output format, length, or structure when it matters; preserve every concrete requirement, constraint, fact, name, and number from the intent, and never invent specifics; address the executing AI in the second person.

The "prompt" field must contain ONLY the prompt itself${promptFieldNote} — no preamble, no surrounding commentary, no markdown code fences.

Respond with ONLY a JSON object, no other text:
{"critique": "<what you improved and why, one or two sentences>", "prompt": "<the improved prompt>", "score": <integer 0-100>, "done": <true|false>}`;
}

// JSON Schema for the per-round verdict — passed to Structured Outputs so the
// response is guaranteed to parse. (score range isn't expressible in the schema,
// so it's clamped in parseRound.)
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    critique: { type: "string" },
    prompt: { type: "string" },
    score: { type: "integer" },
    done: { type: "boolean" },
  },
  required: ["critique", "prompt", "score", "done"],
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
    "forgeView", "settingsView", "settingsBtn", "backBtn",
    "raw", "forgeBtn", "keyBtn", "status",
    "understood", "understoodText",
    "convergence", "output", "outputLabel", "outputText", "critiqueNote",
    "copyBtn", "redoBtn",
    "apiKey", "model", "saveSettingsBtn", "settingsStatus",
  ].forEach((id) => (els[id] = $(id)));

  els.settingsBtn.addEventListener("click", () => showView("settings"));
  els.backBtn.addEventListener("click", () => showView("forge"));
  els.saveSettingsBtn.addEventListener("click", saveSettings);
  els.forgeBtn.addEventListener("click", forge);
  els.redoBtn.addEventListener("click", forge);
  els.copyBtn.addEventListener("click", copyOutput);
  els.keyBtn.addEventListener("click", () => {
    showView("settings");
    setTimeout(() => els.apiKey.focus(), 50);
  });

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => setPersona(btn.dataset.persona, true));
  });

  loadState();
}

function showView(which) {
  const settings = which === "settings";
  els.settingsView.hidden = !settings;
  els.forgeView.hidden = settings;
}

/* ----------------------------- storage ----------------------------- */

function hasStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
}

function loadState() {
  if (!hasStorage()) return;
  chrome.storage.local.get(["apiKey", "model", "persona"], (data) => {
    if (data.apiKey) els.apiKey.value = data.apiKey;
    els.model.value = data.model || DEFAULT_MODEL;
    if (data.persona && PERSONAS[data.persona]) setPersona(data.persona, false);
    if (!data.apiKey) showView("settings");
  });
}

function setPersona(key, persist) {
  if (!PERSONAS[key]) return;
  selectedPersona = key;
  document.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.persona === key)
  );
  if (persist && hasStorage()) chrome.storage.local.set({ persona: key });
}

function saveSettings() {
  if (!hasStorage()) {
    setStatus(els.settingsStatus, "Storage unavailable — load this as an installed extension.", "error");
    return;
  }
  chrome.storage.local.set(
    { apiKey: els.apiKey.value.trim(), model: els.model.value },
    () => {
      setStatus(els.settingsStatus, "Saved.", "ok");
      setTimeout(() => { hideStatus(els.settingsStatus); showView("forge"); }, 700);
    }
  );
}

function getSettings() {
  return new Promise((resolve) => {
    if (!hasStorage()) return resolve({ apiKey: "", model: DEFAULT_MODEL });
    chrome.storage.local.get(["apiKey", "model"], (d) =>
      resolve({ apiKey: (d.apiKey || "").trim(), model: d.model || DEFAULT_MODEL })
    );
  });
}

/* ----------------------------- refine loop ----------------------------- */

async function forge() {
  const raw = els.raw.value.trim();
  if (!raw) { setStatus(els.status, "Type something first.", "error"); return; }

  const { apiKey, model } = await getSettings();
  if (!apiKey) {
    showView("settings");
    setStatus(els.settingsStatus, "Add your Anthropic API key first.", "error");
    setTimeout(() => els.apiKey.focus(), 50);
    return;
  }

  // reset run state
  history = [];
  activeIndex = 0;
  finalized = false;
  els.convergence.innerHTML = "";
  els.convergence.hidden = true;
  els.output.hidden = true;
  els.critiqueNote.hidden = true;
  els.understood.hidden = true;
  els.understoodText.textContent = "";
  els.forgeBtn.disabled = true;
  els.redoBtn.disabled = true;

  try {
    // STAGE A — decode the gibberish into clear English intent.
    setStatus(els.status, '<span class="spinner"></span>Understanding what you mean…', "loading");
    const intent = await decode({ apiKey, model, raw });
    if (!intent) throw new Error("Couldn't read that — try again.");
    els.understoodText.textContent = intent;
    els.understood.hidden = false;

    // STAGE B — the chosen expert structures + refines over rounds.
    const system = buildStructureSystem(selectedPersona);
    const expert = (PERSONAS[selectedPersona] || PERSONAS.prompt_engineer).label;

    let round = 0, best = null;
    while (round < MAX_ROUNDS) {
      round++;
      setStatus(els.status, `<span class="spinner"></span>Forging with ${expert}… round ${round} of up to ${MAX_ROUNDS}`, "loading");

      const userPrompt = round === 1 ? draftMessage(intent, raw) : refineMessage(intent, best);
      const text = await callClaudeForVerdict({ apiKey, model, system, userPrompt });
      const parsed = parseRound(text, round);
      if (!parsed) throw new Error("Couldn't read the model's response. Try again.");

      history.push(parsed);
      best = parsed;
      els.output.hidden = false;
      setActive(history.length - 1);

      if (round >= MIN_ROUNDS && (parsed.done || parsed.score >= CONVERGE_SCORE)) break;
    }
    finalize();
    hideStatus(els.status);
  } catch (err) {
    setStatus(els.status, friendlyError(err), "error");
  } finally {
    els.forgeBtn.disabled = false;
    els.redoBtn.disabled = false;
  }
}

async function decode({ apiKey, model, raw }) {
  const text = await callClaude({ apiKey, model, system: DECODE_SYSTEM, userPrompt: raw });
  return cleanOutput(text);
}

function draftMessage(intent, raw) {
  return (
    `Clarified user intent:\n"""\n${intent}\n"""\n\n` +
    `(Original raw words, for reference only: ${raw})\n\n` +
    `This is round 1. Decide how best to turn this intent into a prompt, then produce the first engineered version.`
  );
}

function refineMessage(intent, prev) {
  const scoreLine = prev.score != null ? ` (you scored it ${prev.score}/100)` : "";
  return (
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
        const n = Number(o.score);
        const score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
        return {
          round,
          critique: String(o.critique != null ? o.critique : "").trim(),
          prompt,
          score,
          done: !!o.done,
        };
      }
    } catch (_) {}
  }

  const p = cleanOutput(raw);
  return p ? { round, critique: "", prompt: p, score: null, done: true } : null;
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

  if (h.critique) {
    els.critiqueNote.textContent = `Round ${h.round}: ${h.critique}`;
    els.critiqueNote.hidden = false;
  } else {
    els.critiqueNote.hidden = true;
  }

  if (finalized) {
    const n = history.length;
    els.outputLabel.textContent = `Final prompt · refined over ${n} round${n > 1 ? "s" : ""}`;
  } else {
    els.outputLabel.textContent = `Refining · round ${h.round}`;
  }

  renderConvergence();
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

function copyOutput() {
  navigator.clipboard.writeText(els.outputText.textContent).then(() => {
    els.copyBtn.textContent = "Copied ✓";
    els.copyBtn.classList.add("copied");
    setTimeout(() => {
      els.copyBtn.textContent = "Copy";
      els.copyBtn.classList.remove("copied");
    }, 1400);
  });
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
