# Privacy Policy — Neat Freak

**Last updated: 2026-05-27**

Neat Freak is a Chrome extension that saves open browser tabs into local, searchable folders. This policy explains what data Neat Freak handles, where it goes, and what we do (and don't do) with it.

## TL;DR

Neat Freak stores everything in your browser. We have no server, no account system, and no analytics. Nothing leaves your device unless you explicitly turn on AI-smart group naming, in which case tab titles, URLs, and short page summaries are sent to OpenAI using **your own API key**.

## What Neat Freak stores on your device

Saved locally via `chrome.storage.local`, never transmitted to any server we control (we do not have a server):

- **Saved tab sessions** — for each session: the URLs, titles, favicon URLs, and a short text summary of each page at the time you saved it.
- **Tab grouping metadata** — folder names, signals, and confidence scores.
- **Your settings** — capture defaults, whether AI grouping is enabled, and your OpenAI API key (if you provide one).

All of this lives in your browser's extension storage. Uninstalling Neat Freak removes it.

## What gets sent to OpenAI (only if you opt in)

If — and only if — you (a) provide your own OpenAI API key in settings and (b) leave "Use an LLM to create groups" enabled, then:

- When you save a session, Neat Freak sends a list of tab titles, URLs, domains, and short page summaries to OpenAI's API to generate workstream-aware folder names.
- When you press Enter in the search bar, Neat Freak sends your query plus the same per-tab metadata to OpenAI to rank matches.

The request goes directly from your browser to `api.openai.com` using your API key. We are not a middleman — we do not log, proxy, or otherwise observe this traffic.

OpenAI's data handling is governed by [OpenAI's privacy policy](https://openai.com/policies/privacy-policy) and your API usage agreement with them. Per OpenAI's API terms, data sent through the API is not used to train their models by default.

If you do not provide an API key, **no data leaves your device**. Local graph-based grouping runs entirely in your browser.

## What we do NOT collect

- No analytics or telemetry (no Google Analytics, no Mixpanel, no Sentry, nothing).
- No user accounts. There is no Neat Freak account system.
- No advertising identifiers. We do not show ads.
- No tracking across sessions or devices. Each install is independent.
- No selling, renting, or sharing of any data. (We don't have any to share.)

## Permissions and why we need them

- **`storage`** — to save your sessions and settings on your device.
- **`tabs`** — to read the list of open tabs (title, URL, favicon, pinned status) when you tell Neat Freak to save them, and to open URLs when you click Restore.
- **`scripting`** — to extract a short text summary of each page at save time (the page's headings and first few paragraphs), which improves grouping accuracy. This runs only at the moment of save, only on tabs you are saving.
- **`notifications`** — to send a desktop notification when a save finishes, so you can close the popup and get on with your day.
- **`host_permissions: http://*/*, https://*/*`** — required so the `scripting` permission above can run on any page you have open. Neat Freak does not read your pages at any other time.
- **`host_permissions: https://api.openai.com/*`** — only used when you have enabled AI grouping with your own key.

## Data retention

Sessions stay in your browser until you delete them (or uninstall Neat Freak). There is no remote backup, no sync, no automatic deletion.

## Children's privacy

Neat Freak does not knowingly collect data from anyone under 13. Since we don't collect data from anyone, this is somewhat redundant, but stating it explicitly.

## Changes to this policy

If we update this policy, we'll change the "Last updated" date at the top and publish the new version at the same URL. Material changes (e.g., adding any kind of server-side data handling) will be announced in the extension's update notes.

## Contact

Questions about this policy: **danielhalper4@gmail.com**
