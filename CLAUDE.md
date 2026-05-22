# Neat Freak — Chrome extension for tidying tabs into folders

Chrome Manifest V3 extension. Saves open tabs into memory-light folders grouped by workstream, restores in one click. No build step — vanilla ES modules loaded directly.

## Repo layout

```
manifest.json          MV3 manifest, version, permissions
popup.html             Thin shell that mounts the floating panel (Chrome action popup)
manager.html           Saved-sessions manager page (chrome.tabs page)
options.html           Settings page
welcome.html           First-install onboarding (4 steps)
src/
  background.js          Service worker — message routing, save flow, clutter watcher
  neat-freak-panel.js    Floating panel content script — clutter / saving / done / idle states + expanded view
  popup.js               ~30-line shim: tries to inject panel on active tab, otherwise mounts panel inline in the popup
  manager.js             Manager page logic
  options.js             Settings page logic
  welcome.js             Onboarding logic
  smart-scope.js         Smart save algorithm (heuristic + LLM paths). Pure functions tested.
  categorizer.js         Tab clustering (association graph + temporal-proximity bonus)
  storage.js             chrome.storage.local + .session wrappers, settings versioning + migrations
  styles.css             Shared styles for the extension pages (popup/options/welcome/manager)
  utils.js               URL parsing, text helpers
tests/
  smart-scope.test.js    Node --test runner. Covers applySmartHeuristic + runSmartScope.
docs/specs/              Design docs for major features
assets/                  Mascot SVGs (calm + stressed), PNGs, brand logo, LilitaOne-Regular woff2 (brand wordmark font)
```

## Running the extension

1. `chrome://extensions/` → enable Developer mode
2. **Load unpacked** → select this repo's root
3. After code or manifest changes, click the **Reload** button on the extension card
4. Content script changes also need a refresh of the test tab (Cmd-R) — Chrome doesn't re-inject into already-open tabs

## Running tests

```bash
node --test tests/*.test.js
```

10 tests covering the Smart scope heuristic. Pure-function tests, no Chrome API mocking required.

## Key architecture notes

- **One panel, two surfaces.** The expanded panel UI lives in `src/neat-freak-panel.js` (shadow DOM). On http(s) pages it injects into the tab. On chrome:// pages it falls back to the popup, which mounts the same panel script in the popup window via `inPopupContext` detection.
- **State machine via storage.** Panel state (`clutter` / `saving` / `done` / `idle` / `hidden`) lives in `chrome.storage.session.neatFreakPanelState`. The panel script listens for changes and re-renders in place. Background writes via `setPanelState()`.
- **Two save paths.** Heuristic (no API key) uses content + temporal-proximity association graph. LLM path uses `gpt-5.4-mini` with reasoning_effort=low and a default-to-save prompt. Both paths share URL-exact dedup pre-pass.
- **Settings as defaults.** Panel changes (scope picker, More options checkboxes) write back to settings so each toggle becomes the next-open default. Settings are versioned (`settingsVersion`) with migrations in `storage.js`.

## Conventions

- ES modules, no transpilation
- No emojis in code unless requested
- Tight commit messages — explain *why*, not just *what*
- Don't introduce build tooling without a clear reason; the no-build constraint is intentional
- Keep `chrome.action.openPopup()` interactions wrapped in try/catch — it gates on user gesture in some contexts

## Branch policy

Single-developer project — push completed work directly to `main`. No PR
workflow, no protected branches.

Anything Chrome will reject at the extension root must not land in `main`.
The MV3 loader specifically rejects top-level filenames starting with `_`,
so reference/scratch directories should be named without a leading
underscore (e.g. `refactor-assets/`, not `_refactor_assets/`).
