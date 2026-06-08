# Contributing to Forge

Thanks for your interest. Forge is a small, dependency-free Chrome (Manifest V3) extension, so getting set up is quick.

## Run it locally

No build step. It's vanilla HTML, CSS, and JavaScript.

```bash
# load it as an extension
#   chrome://extensions  ->  Developer mode  ->  Load unpacked  ->  this folder

# or run the popup as a plain web page (popup only; the inline button needs the
# installed extension, since content scripts only run on the AI sites)
python3 -m http.server 5599
# open http://localhost:5599/popup.html
```

Regenerate the assets if you touch the brand:

```bash
python3 make_icons.py     # PNG icons (16 to 128)
python3 make_banner.py    # docs/banner.png
```

## Architecture, in one breath

- **`engine.js` is the single source of truth** for the pipeline: the prompts, the personas, the Claude API call, parsing, and the refine loop. It is pure (no DOM, no `chrome.*`).
- The **popup** loads it via `<script>`; the **background worker** loads it via `importScripts`. If you change a prompt or the scoring, change it once, in `engine.js`. Do not fork the logic into `popup.js` or `background.js`.
- `content.js` injects the inline button on the AI sites and reads/writes their composer. Those selectors are inherently fragile; if a site changes its markup, update `findComposer()` / the `SELECTORS` map.

## House style

- **No em dashes.** Use commas, periods, colons, parentheses, or hyphens. (Yes, really.)
- Keep it dependency-free and no-build where possible.
- Match the existing formatting; small, focused changes.

## Reporting issues

Open an issue with the site/browser, what you typed, and what happened (a screenshot helps). For the inline button, note which site (ChatGPT / Claude / Gemini) and whether the composer was found.
