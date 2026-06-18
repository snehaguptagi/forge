# Architecture

Forge is a Chrome **Manifest V3** extension that turns a rough idea into an engineered prompt via Claude. Its popup and its in-page button share one engine, so behavior never drifts between them.

## Components
- **`engine.js`** — the single source of truth, and pure (no DOM, no `chrome.*`; takes everything as arguments). It builds persona system prompts (`buildStructureSystem`), drafts (`draftMessage`) and refines (`refineMessage`) the prompt in a loop, scores the result (`callClaudeForVerdict`), and makes the Anthropic call (`callClaude`, with a JSON schema for structured output).
- **`popup.html` / `popup.js`** — the toolbar popup: paste an intent → run the draft→refine loop → show the engineered prompt + an explainable, per-criterion score.
- **`content.js`** — content script injected on ChatGPT / Claude / Gemini (scoped via `host_permissions`); adds an inline **Forge** button into the chat box to refine in place.
- **`background.js`** — MV3 service worker; brokers settings/storage.
- **`manifest.json`** — MV3; `permissions` is just `storage`; `host_permissions` limited to the three chat sites.

## Data flow
```
intent + raw text
   → engine.draftMessage()
   → callClaude()  (Anthropic, structured-output schema)
   → engine.refineMessage()   ← loops until score bar / max rounds
   → render engineered prompt + per-criterion score
```

## Key decisions
- **Bring-your-own-key, local-first.** The Anthropic key lives in `chrome.storage.local`; nothing leaves the browser except the call to Anthropic. The only Chrome permission requested is `storage`.
- **One shared engine.** Popup and content script both call `engine.js`, so the two surfaces can't behave differently.
- **Structured output + explainable score.** Claude returns a schema'd verdict, so the score is shown per-criterion rather than as a black-box number.

## Layout
```
engine.js      shared prompt engine (draft / refine / score, Claude calls)
popup.html/js  toolbar popup UI
content.js     inline button on ChatGPT / Claude / Gemini
background.js  MV3 service worker
manifest.json  MV3 config (storage only; 3 host permissions)
```
