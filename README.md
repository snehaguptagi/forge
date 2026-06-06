# PromptForge

**Type it however you want — get the prompt you should've written.**

A Chrome extension that kills prompt anxiety. You don't craft the perfect prompt; you just dump your intent — type it messily — and PromptForge uses Claude to decode your raw thoughts and refine them into one tight, well-engineered prompt you can paste into any AI.

> **v1 is text-only.** Voice input (dictate your intent) is designed and was prototyped with the Web Speech API; it's deferred to a later version. The pipeline below is unchanged when voice returns — it just fills the same text box.

## Features

- **Two-stage pipeline (one click):**
  1. **Decode** — turns your gibberish into a clear English statement of intent (typos fixed, nothing added, no requirements lost) and shows it back to you as "Understood intent."
  2. **Structure + refine** — the chosen expert builds the prompt, then self-critiques and improves it over up to 4 rounds, stopping early once it converges. You watch the quality score climb and can click any round to see that version and what changed.
- **Three selectable experts** drive the structuring stage (each encodes researched best practices):
  - **Prompt Engineer** — clean, best-practice natural-language prompt (default).
  - **Context Engineer** — minimal high-signal context at the "right altitude": labeled Role / Context / Task / Constraints / Output sections with delimiters, examples over edge-case lists.
  - **JSON Prompter** — emits the prompt as a flat, enum-typed JSON object with reasoning-before-answer field order.
- **Guaranteed-valid verdicts** — the refine loop uses Anthropic **Structured Outputs** so each round's JSON can't fail to parse (falls back to prompt-guided JSON if the API doesn't accept it).
- **Dedicated 🔑 key button** on the main screen (in addition to the ⚙ gear) for quickly entering your Anthropic API key.
- **One-click copy** of the best round.
- **Your key, your browser** — the Anthropic API key lives in `chrome.storage.local` and is only ever sent to `api.anthropic.com`.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this `promptforge-extension` folder.
4. Pin PromptForge from the puzzle-piece menu.

## First run

1. Click the PromptForge icon → the **Settings** (⚙) view opens (or tap **🔑 Enter Anthropic key**).
2. Paste your Anthropic API key ([console.anthropic.com](https://console.anthropic.com/settings/keys)), pick a model (Sonnet 4.6 default), **Save**.
3. Pick an expert, type your raw idea → **Forge prompt** → **Copy**.

## How it works

`popup.js` runs a two-stage pipeline against the Anthropic Messages API:

1. **Decode** (1 call, `DECODE_SYSTEM`) — rewrites the raw input into a clean intent statement, preserving every requirement and adding nothing.
2. **Structure + refine** (2–4 calls, `buildStructureSystem(persona)`) — the selected expert turns the clean intent into a prompt and iterates. Each round returns a JSON verdict — `{critique, prompt, score, done}` — rendered progressively as a convergence strip (`R1 · 78 → R2 · 89 → …`). The loop runs min 2 / max 4 rounds, stopping early on `done` or self-score ≥ 95. The final card shows the highest-scoring round.

The verdict calls use **Structured Outputs** (`output_config.format` with a JSON schema), which constrains decoding so the response is guaranteed to match the schema. If the API rejects that field, `callClaudeForVerdict` retries once without it and relies on the prompt-guided JSON + defensive parsing. Calls are made directly from the popup via the `anthropic-dangerous-direct-browser-access: true` header (browser CORS otherwise blocks it). Each stage's system prompt is marked cacheable, so rounds within a forge are cheaper.

The score is the model's own self-assessment of prompt quality, shown to visualize convergence — not an external benchmark.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest — popup action, `storage` permission, `api.anthropic.com` host permission |
| `popup.html` / `popup.css` | UI (forge view + settings view) |
| `popup.js` | Decode + persona system prompts, refine loop, Structured Outputs call, rendering |
| `make_icons.py` | Regenerates the sparkle PNG icons in `icons/` |

## Notes

- API usage is billed to your Anthropic account.
- A forge is 3–5 Claude calls (1 decode + 2–4 refine).
- The expert system prompts encode best practices distilled from Anthropic, OpenAI, Google, and the context-engineering literature.
