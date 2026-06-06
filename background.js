"use strict";
/*
 * PromptForge background service worker.
 * Runs the forge pipeline for the inline content-script button (chatgpt.com /
 * claude.ai / gemini.google.com). The API call lives here (not in the content
 * script) so it isn't blocked by each site's Content-Security-Policy.
 *
 * NOTE: the pipeline below is mirrored from popup.js. Keep the two in sync.
 * TODO: extract into a shared engine.js loaded by both (importScripts + <script>).
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";

const MIN_ROUNDS = 2;
const MAX_ROUNDS = 4;
const CONVERGE_SCORE = 95;

const DECODE_SYSTEM = `You are an expert at understanding intent. The user gives you a raw, messy, broken-English description of what they want from an AI. Rewrite it as a clear, grammatical, plain-English statement of exactly what they want.

Fix typos, gibberish, and broken phrasing. Preserve every concrete requirement, constraint, fact, name, and number. Do NOT add requirements they did not state, do NOT answer or fulfil the request, and do NOT write a prompt yet — only restate their intent clearly and completely.

Output only the clarified intent as plain prose, with no preamble.`;

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
  if (schema) body.output_config = { format: { type: "json_schema", schema } };

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

function cleanOutput(text) {
  let t = (text || "").trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  if (t.length > 1 && /^["'](.|\n)*["']$/.test(t)) t = t.slice(1, -1).trim();
  return t;
}

function parseRound(text, round) {
  let raw = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      const o = JSON.parse(raw.slice(s, e + 1));
      const prompt = cleanOutput(String(o.prompt != null ? o.prompt : "")).trim();
      if (prompt) {
        const src = o.scores && typeof o.scores === "object" ? o.scores : {};
        let sum = 0, n = 0;
        SCORE_DIMS.forEach(([k]) => {
          const v = Number(src[k]);
          if (Number.isFinite(v)) { sum += Math.max(0, Math.min(100, Math.round(v))); n++; }
        });
        let score = n ? Math.round(sum / n) : null;
        if (score == null && Number.isFinite(Number(o.score))) {
          score = Math.max(0, Math.min(100, Math.round(Number(o.score))));
        }
        return { round, critique: String(o.critique != null ? o.critique : "").trim(), prompt, score, done: !!o.done };
      }
    } catch (_) {}
  }
  const p = cleanOutput(raw);
  return p ? { round, critique: "", prompt: p, score: null, done: true } : null;
}

async function decode({ apiKey, model, raw }) {
  return cleanOutput(await callClaude({ apiKey, model, system: DECODE_SYSTEM, userPrompt: raw }));
}

// Full pipeline used by the inline button: decode → structure/refine loop → best round.
async function runForgePipeline({ apiKey, model, raw, persona, context }) {
  const intent = await decode({ apiKey, model, raw });
  if (!intent) throw new Error("Couldn't read that input.");
  const system = buildStructureSystem(persona);
  let round = 0, best = null;
  while (round < MAX_ROUNDS) {
    round++;
    const userPrompt = round === 1 ? draftMessage(intent, raw, context || "") : refineMessage(intent, best, context || "");
    const text = await callClaudeForVerdict({ apiKey, model, system, userPrompt });
    const parsed = parseRound(text, round);
    if (!parsed) throw new Error("Couldn't read the model's response.");
    best = parsed;
    if (round >= MIN_ROUNDS && (parsed.done || parsed.score >= CONVERGE_SCORE)) break;
  }
  return best;
}

/* ----------------------------- messaging ----------------------------- */

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
      const best = await runForgePipeline({ apiKey, model, raw: String(msg.raw || ""), persona, context });
      sendResponse({ ok: true, prompt: best.prompt, score: best.score, persona, personaLabel: PERSONAS[persona].label });
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || "Forge failed" });
    }
  })();
  return true; // keep the message channel open for the async response
});
