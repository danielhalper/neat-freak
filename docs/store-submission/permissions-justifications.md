# Chrome Web Store — Permissions Justifications

The store dashboard asks for a one-paragraph justification for each permission you request. Paste these into the matching fields.

The store has gotten progressively stricter about broad host permissions. Be ready for a back-and-forth with the reviewer; these justifications are what they'll grade you on.

---

## `storage`

```
Neat Freak saves each tab session (titles, URLs, favicons, and short page summaries) to chrome.storage.local so users can return to grouped sessions across browser restarts. We also persist the user's settings (capture defaults, optional OpenAI API key for AI grouping) in chrome.storage.local. No data is transmitted to any server we operate.
```

---

## `tabs`

```
The core feature requires reading the list of open tabs (title, URL, favicon, pinned status, window ID) when the user clicks "Tidy tabs" so they can be saved into a session. We also use chrome.tabs.create to open URLs when the user clicks Restore, and chrome.tabs.remove to close saved tabs after they're snapshotted.
```

---

## `scripting`

```
To improve grouping accuracy, Neat Freak extracts a short text summary of each saved page (the page title, meta description, primary heading, and first few paragraphs) at the moment the user clicks "Tidy tabs". This summary feeds the local clustering algorithm so it can group tabs by topic rather than just by domain. The script runs only at save time, only on the tabs being saved, and only collects text content already visible to the user.
```

---

## `notifications`

```
When the user clicks "Tidy tabs" and closes the popup, Neat Freak shows a single desktop notification when the save finishes ("X tabs tucked away · N folders"). Clicking the notification opens the manager page so the user can review the newly-grouped session. Notifications are only fired in response to user-initiated save actions — there are no notifications outside of that flow.
```

---

## Host permission: `http://*/*` and `https://*/*`

This is the most-scrutinized one. Be prepared to defend it.

```
The "scripting" permission above requires matching host_permissions for the URLs it runs on. Neat Freak runs its page-summary extraction script only on tabs the user is explicitly saving (when they click "Tidy tabs"), and only at that moment. We need broad host access because users can save any tab they have open — a recipe site, a Google Doc, a LinkedIn profile, an internal wiki. Restricting host_permissions to a fixed set of domains would break the core feature for any tab outside that allowlist. We do not run content scripts persistently, do not inject ads or modify pages, and do not read tabs the user hasn't asked to save.
```

If the reviewer pushes back, a fallback is to drop the `scripting` permission entirely and rely on titles + URLs only for grouping. Quality drops a bit but the review path becomes trivial. See the "Fallback plan" section at the bottom of this doc.

---

## Host permission: `https://api.openai.com/*`

```
Used only when the user enables AI-smart group naming in settings AND provides their own OpenAI API key. In that case, Neat Freak sends tab titles, URLs, and page summaries to api.openai.com to generate workstream-aware folder names and to power natural-language search. Without a user-provided key, no requests are made to OpenAI. The key is stored on the user's device only.
```

---

## Remote code / single-purpose declarations

The dashboard will also ask:

**"Does your extension run remote code?"** → **No.** All extension code is bundled in the published package. The only remote calls are to api.openai.com for the optional AI grouping feature, and those return JSON data (not code).

**"What is the single purpose of your extension?"** → **"Save open Chrome tabs into a memory-light, searchable archive — automatically grouped into folders by topic — and restore them in one click."**

---

## Fallback plan (if reviewer rejects host_permissions)

If the reviewer flags `http://*/*` and `https://*/*` as too broad, the simplest path forward is to remove the scripting-based page summary feature:

1. Delete the `scripting` permission and both broad host permissions from `manifest.json`.
2. In `src/background.js`, remove the `getPageSummary` and `collectPageSummary` functions and stop populating `pageSummary` on saved tabs.
3. Resubmit. The only permissions remaining are `storage`, `tabs`, `notifications`, and `https://api.openai.com/*` — all narrow and unambiguous.

The grouping engine will work with just titles, URLs, and domains. Quality drops on tabs with generic titles (e.g., "Untitled - Google Docs") but the trade-off may be worth the cleaner submission.
