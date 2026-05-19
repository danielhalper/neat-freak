# Neat Freak

Tidy your tabs. Find your work.

Neat Freak is a Chrome extension that saves every open tab into memory-light folders, grouped by what you're actually working on — and restores them in one click.

## What it does

- **Save** — snapshot every open tab in every window into a memory-light session. Tabs close, Chrome reclaims RAM.
- **Group** — tabs auto-organize into folders by topic using a local association graph (titles, domains, page summaries). Optional LLM pass (`gpt-5-mini`) for workstream-aware folder names.
- **Find** — search every saved tab by keyword, or ask in plain English ("ux applicants I looked up?") and the LLM ranks matches.
- **Restore** — open one tab, a full folder, or a whole session.

No account. No sync. No telemetry. Everything is stored in Chrome's local extension storage.

## Install

The published version lives on the Chrome Web Store (link coming after launch). For local development:

1. `git clone` this repo.
2. Open `chrome://extensions` and toggle **Developer mode** on.
3. Click **Load unpacked** and select the project folder.
4. Pin Neat Freak in the toolbar.

## Project layout

| Path | What |
|------|------|
| `manifest.json` | Manifest V3 config |
| `popup.html` + `src/popup.js` | Toolbar popup — save / search / view recent sessions |
| `manager.html` + `src/manager.js` | Full-page manager — list-view-with-folders for every saved session |
| `welcome.html` + `src/welcome.js` | First-run onboarding (3 steps + live pin detection) |
| `options.html` + `src/options.js` | Settings — capture defaults + optional OpenAI key |
| `src/background.js` | Service worker — captures tabs, dispatches LLM calls, fires notifications |
| `src/categorizer.js` | Association-graph clustering + optional LLM pass |
| `src/storage.js` | `chrome.storage.local` wrapper |
| `assets/` | Icons, logo |
| `docs/deck/` | Web Store screenshots, promo tile, marquee |
| `docs/store-submission/` | Listing copy, privacy policy, permissions justifications |

## LLM grouping (optional)

Local graph-based grouping works without any setup. If you add your own OpenAI API key in Settings, Neat Freak uses `gpt-5-mini` to:

- Rename folders with workstream-aware labels
- Power the plain-English search bar

The key is stored only in `chrome.storage.local` on your device. Requests go directly to `api.openai.com` — Neat Freak has no server.

When enabled, each LLM call sends tab titles, URLs, domains, and short page summaries (extracted at save time). It does not send full page HTML. See [`docs/store-submission/privacy-policy.md`](docs/store-submission/privacy-policy.md) for the full data-handling story.

## Permissions

- `storage` — save sessions and settings locally.
- `tabs` — read open tab metadata; open URLs on restore; close saved tabs.
- `scripting` — extract short page summaries at save time (only on tabs being saved).
- `notifications` — show a desktop notification when a save finishes.
- `host_permissions: http://*/*, https://*/*` — required for `scripting` to run on any tab the user saves.
- `host_permissions: https://api.openai.com/*` — only used when the user enables LLM grouping with their own key.

## License

Source available for transparency; pick a license before deciding redistribution terms.
