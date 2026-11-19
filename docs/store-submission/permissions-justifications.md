# Chrome Web Store — Privacy disclosures & permission justifications

Paste these into the dashboard's **Privacy practices** tab. The store is strict about broad host permissions and data handling — expect a reviewer back-and-forth.

> **This version changed the data model.** AI used to be opt-in with the user's own OpenAI key (nothing left the device by default). Now AI is **on by default** and routes tab data through Neat Freak's confidential backend. The data-usage section below reflects that — review it carefully on resubmission, and ideally have counsel look at the privacy policy.

---

## Single purpose

```
Save open Chrome tabs into a memory-light, searchable archive — automatically grouped into folders by topic — and restore them in one click.
```

---

## Permission justifications

### `storage`
```
Neat Freak saves each tab session (titles, URLs, favicons, and short page summaries) to chrome.storage.local so users can return to grouped sessions across browser restarts. It also stores user settings (capture defaults, whether AI is enabled) and a random, anonymous install identifier used only to rate-limit the AI backend. No data is stored on a server we operate.
```

### `tabs`
```
The core feature reads open-tab metadata (title, URL, favicon, pinned status, window ID) for counts, suggestions and tidying. We also use chrome.tabs.create to reopen URLs on Restore and chrome.tabs.remove to close tabs after an explicit user action and a durable snapshot.
```

### `scripting`
```
Neat Freak extracts optional summaries (title, meta description, headings and paragraphs) from candidate pages while tidying or preparing suggestions, including candidates the user ultimately keeps. Background preparation is off until explicitly enabled. Local form checks protect unsaved input before closure; field values are not returned, and detected editable regions are excluded from summaries. Scripting also displays the floating panel. Users can disable summaries or background preparation in Settings.
```

### `notifications`
```
When the user tidies and closes the popup, Neat Freak shows a single desktop notification when the save finishes. Notifications fire only in response to user-initiated saves.
```

### `alarms`
```
Used to check the open-tab threshold for optional reminders and prepare suggestions when background preparation has been enabled. With AI on, preparation can send candidate titles, URLs and optional summaries before a Save click. The alarm itself is not analytics.
```

### Host permissions: `http://*/*` and `https://*/*`
```
Host access lets scripting inspect candidate pages for summaries and local form checks, and display the floating panel. Preparation runs on request or automatically after background preparation is enabled. It can inspect pages before a Save click. With AI on, titles, URLs and optional summaries go to the AI backend over HTTPS. Disabling AI keeps processing local; disabling summaries alone still allows titles and URLs to be sent. No ads are injected.
```

(Note: the old `https://api.openai.com/*` host permission has been removed — the extension no longer talks to OpenAI.)

---

## Data usage disclosures (dashboard form)

**Does your extension run remote code?** → **No.** All code is bundled in the published package. The only network calls are to Neat Freak's AI backend (a token/relay service plus a confidential-enclave model), which return JSON data, not code.

**What user data is collected or transferred?**
- **Website content** — **Yes.** When AI is enabled, tab titles, URLs, and short page summaries are sent to the AI backend to select/group tabs and power search.
- **Web history** — **Yes.** Candidate tab titles and URLs are transmitted when AI is on, including during requested suggestions or enabled background preparation before a Save click.
- Personally identifiable info, health, financial, authentication, location, user activity — **No.**

> ⚠️ **Judgment call — "Personal communications":** page summaries are pulled from whatever page the user saves, so they can incidentally contain content from an email/chat/DM page. Decide (ideally with counsel) whether you must check "Personal communications." The conservative answer may be **yes**. At minimum, the privacy policy discloses this possibility.

**How is the data used / shared?**
- Used **solely** to provide the user-requested features (tab grouping, selection, and search).
- Transferred to a third-party service provider (a confidential-computing AI provider) **only** to operate those features. The relay service sees only an anonymous install id; tab content is processed inside a hardware secure enclave and is not retained or used for training.

**Certifications (all true for Neat Freak):**
- I do **not** sell or transfer user data to third parties outside the approved use case above.
- I do **not** use or transfer user data for purposes unrelated to the item's single purpose.
- I do **not** use or transfer user data to determine creditworthiness or for lending.

**Privacy policy URL:** point this at the published `docs/landing/privacy.html` (e.g. your GitHub Pages / site URL for it).

---

## Fallback plan (if the reviewer rejects broad host_permissions)

If `http://*/*` + `https://*/*` are flagged as too broad, the cleanest path is to drop the scripting-based page summary:

1. Remove `scripting` and both broad host permissions from `manifest.json`.
2. In `src/background.js`, remove `getPageSummary` / `collectPageSummary` and stop populating `pageSummary`.
3. Resubmit with only `storage`, `tabs`, `notifications`, `alarms`.

But note: with AI on by default, you'd still need *some* host access for the backend calls, or you'd gate AI behind an explicit user opt-in. Weigh the review friction against the feature.
