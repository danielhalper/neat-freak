# Privacy Policy — Neat Freak

**Last updated: 2026-11-04**

Neat Freak is a Chrome extension that saves open browser tabs into local, searchable folders, grouped by topic. This policy explains what data Neat Freak handles, where it goes, and what we do (and don't do) with it.

## TL;DR

Everything you save is stored in your browser — no account, no remote analytics, no cross-site tracking. To group and search your tabs intelligently, Neat Freak's AI features (**on by default**) send tab titles, URLs, and short page summaries to a **confidential AI backend** that processes them inside a hardware-isolated secure enclave: the content isn't stored, isn't used to train models, and **can't be read by us or the AI provider**. No API key required. You can turn AI off in Settings to keep everything fully on-device.

## What Neat Freak stores on your device

Saved locally via `chrome.storage.local`, never sent to a server we operate:

- **Saved tab sessions** — for each session: URLs, titles, favicon URLs, and a short text summary of each page at the time you saved it.
- **Tab grouping metadata** — folder names, signals, confidence scores.
- **Your settings** — capture defaults, whether AI is enabled, and a random, anonymous install identifier.
- **Prepared suggestions and Keep choices** — cached in browser-session storage until the browser session ends. A local daily counter limits automatic AI attempts; it contains no tab content and is not analytics.
- **Local diagnostics** — enabled by default for troubleshooting. Records event times, suggestion counts, review/Keep actions, close/restore counts, durations, error categories and extension source locations. Random per-tidy references connect events within an offer. No titles, URLs, page content, form values, credentials or install identifiers are recorded. Limited to 500 events and seven days, cleaned on extension activity. Settings lets you disable recording, clear it or export a file to share yourself. It is never uploaded automatically.

Uninstalling Neat Freak removes all of it.

## What gets sent off your device (AI features — on by default)

When AI features are enabled (the default), tidying, requesting suggestions, or running a smart search transmits, for the relevant tabs:

- tab **titles, URLs, domains**, and short **page summaries** (page title, meta description, headings, and the first few paragraphs), and
- your **search query** (smart search only).

This data goes to a **confidential AI backend** operated for Neat Freak, with two important properties:

1. **A relay service** — which hands out short-lived usage keys to rate-limit abuse — receives only an **anonymous, random install identifier**, never your tab content, and not tied to your identity.
2. **The AI model runs inside a hardware secure enclave** (confidential computing, provided by [Tinfoil](https://tinfoil.sh)). Your tab content is processed there and **cannot be read by Neat Freak's operators or by the AI provider**, is **not retained**, and is **not used to train models**.

No OpenAI key — or any key — is required from you.

**Turning AI off:** In Settings, disable "Use AI for smart tab selection, folder names, and search." With AI off, grouping runs entirely on-device and **no tab data leaves your browser**.

**Background suggestions:** Background preparation starts off and requires enabling "Prepare tab suggestions in the background." When enabled along with nudges, Neat Freak can inspect inactive candidate tabs and, with AI on, send their titles, URLs and optional summaries before you click Save. Suggestions cover regular windows; incognito tabs are excluded. No tab closes without a Save & close action.

**A note on page summaries:** Candidate pages can contain sensitive text, such as emails or documents. Summaries may be extracted while preparing suggestions or tidying, including from candidates you ultimately keep open. You can disable summary collection in Settings; titles and URLs can still be sent when AI is on. Disabling AI keeps tab processing local. Form checks also run locally before closing; form values are not included in their result, and detected editable regions are excluded from summaries. Detection is best-effort, especially for custom editors.

## What we do NOT collect

- No remotely collected analytics or telemetry (no Google Analytics, Mixpanel, Sentry, etc.). Local diagnostics stay on your device unless you export and share them.
- No user accounts.
- No advertising identifiers, and no ads.
- No tracking across sites, sessions, or devices. The install identifier is random, used only to rate-limit the AI backend, and not linked to you.
- We do not sell or rent your data, and we transfer it only to the confidential AI backend described above, solely to provide the AI features you've enabled.

## Permissions and why we need them

- **`storage`** — save your sessions and settings on your device.
- **`tabs`** — read open-tab metadata for counts, suggestions and tidying, close tabs after a user action, and reopen URLs on Restore.
- **`scripting`** — extract optional summaries from candidate pages when preparing suggestions or tidying, check locally for unsaved input, and display the floating panel.
- **`notifications`** — tell you when a save finishes.
- **`alarms`** — periodically check your clutter threshold and prepare suggestions when you have enabled background preparation.
- **Host access (`http://*/*`, `https://*/*`)** — lets the extension inspect candidate pages for the features described above, display its panel, and reach the AI backend when AI is enabled.

## Data retention

Saved sessions stay in your browser until you delete them, uninstall, or the configured retention limit removes older completed sessions. A storage-size backstop can also remove older completed sessions. Pending sessions are protected. There's no remote backup or sync. Tab content sent to the AI backend is processed in-enclave and not retained.

## Children's privacy

Neat Freak is not directed at children under 13 and does not knowingly collect their data.

## Changes to this policy

We'll update the "Last updated" date above and publish changes at the same URL. Material changes will be noted in the extension's update notes.

## Contact

Questions about this policy: **danielhalper4@gmail.com**
