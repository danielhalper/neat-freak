# Session Retention + In-Progress Work Protection — Design Spec

**Status:** draft, awaiting review
**Touches:** `storage.js`, `background.js`, `smart-scope.js`, `options.html`, `options.js`, `tests/smart-scope.test.js`

Two independent updates, shipped as two commits. Shared theme: *stop losing things the
user cares about* — both old saved sessions piling up unbounded, and in-progress work
getting auto-stashed.

---

## Feature 1 — Session retention

### Why

Saved sessions accumulate in `chrome.storage.local` (`tabAtlasSessions`) **forever**.
There is no pruning today. `chrome.storage.local` has a hard ~10MB quota (we do not
request `unlimitedStorage`, and we don't want to — it triggers a scarier install prompt
and a CWS re-review). A heavy session (40 tabs × ~720-char summaries) is ~50KB. Left
unbounded this is both UX clutter and an eventual `QUOTA_BYTES` failure that would break
*saving itself*.

### Decision: count-based

Keep the **newest N sessions**, default **250**, prune oldest beyond that. Chosen over
age-based because it (a) directly bounds the real constraint (the 10MB quota) and
(b) never deletes deliberately-saved work merely because time passed — it only trims once
there's genuinely a large pile, and trims the least-recent first. Adjustable in Settings,
including a "keep everything" option.

### Settings

Bump `settingsVersion` 6 → 7. Add to `DEFAULT_SETTINGS`:

- `maxSavedSessions: 250` — `0` means "keep everything" (no count pruning).

Migration in `getSettings()`: clamp via a new `clampSavedSessions(value)`:
- missing/invalid → default 250
- `0` → `0` (unlimited)
- otherwise clamp to `[20, 1000]` (floor of 20 prevents an over-aggressive value from
  silently nuking most of the user's stashes)

`saveSettings()` runs the same clamp, mirrors `clutterThreshold`'s pattern.

### Pruning rules (`enforceRetention` in `storage.js`)

A new pure-ish helper that takes the sessions array + settings and returns the retained
array. Rules, in order:

1. **Never prune protected sessions.** A session is protected if
   `closeStatus === "review"` **or** `pendingTabIds.length > 0` — its tabs are saved but
   *not yet closed in the browser*; deleting it would strand live tabs and lose the
   record of what's pending. Protected sessions are always retained and don't count
   against the limit.
2. **Count limit.** Of the remaining (closed) sessions, sort newest-first by `createdAt`
   and keep the first `maxSavedSessions`. (Skip when `maxSavedSessions === 0`.)
3. **Quota backstop.** After the count limit, if the serialized retained set still exceeds
   a safe byte budget (`RETENTION_BYTE_BUDGET = 8 * 1024 * 1024`), keep dropping the
   oldest *unprotected* session until under budget. Byte size estimated via
   `JSON.stringify(...).length`. This guarantees a save can never fail with a quota error,
   regardless of the count knob or session sizes.

Ordering note: sessions are stored newest-first (`addSession` prepends), so "oldest" =
end of the array. `enforceRetention` sorts defensively by `createdAt` rather than trusting
array order.

### Where it runs

- **After each save:** in `background.js` `saveTabs`, call `enforceRetention` right after
  `addSession(session)` (count grows only on save, so this is the primary trigger).
- **On the existing alarm:** piggyback the 30-min `neat-freak-clutter-check` alarm to also
  run retention, so a long-idle browser with a huge backlog still gets trimmed without a
  save. (Cheap; reuses an existing wakeup.)

Both call a single `pruneSavedSessions()` in `background.js` that reads settings + sessions,
applies `enforceRetention`, and writes back only if something changed.

### UI (`options.html` / `options.js`)

Add to the **Capture Defaults** section a number field "Keep this many saved sessions"
(`#max-saved-sessions`, min 0, with helper text "0 = keep everything"). Wire through
`populate` / `readSettings` exactly like `clutterThreshold`.

### Out of scope

- Age-based expiry (rejected above).
- A manual "clear old sessions" button in the manager (retention is automatic; the
  existing per-session/-group/-folder delete buttons already cover manual cleanup).
- Per-session "pin / never delete" (YAGNI; revisit if requested).

---

## Feature 2 — In-progress form protection

### Why

Neat Freak's safety promise is *"worst case, you restore it in one click."* That promise
**breaks for a tab with a half-filled form**: stashing + closing it reopens only the URL
later — a blank form. Typed-but-unsubmitted content is gone permanently. This is the one
case where auto-closing causes real, unrecoverable loss.

The prompt already *says* to keep "an open form being filled in" ([smart-scope.js:516]),
but the page scraper ([background.js:440] `collectPageSummary`) only reads
title/headings/paragraphs — it captures **no form state**, so the model has no signal to
act on. That's the gap.

Scope note: kept deliberately small. The mechanism is **one signal + the existing prompt**,
plus a two-line reuse of the safety net that already exists. No prompt rewrite, no
heuristic re-ranking, no draft/contenteditable detection.

### Detection (content script)

Extend the existing single page-scrape injection (`collectPageSummary` →
`collectPageSignals`) to also return `hasUnsavedInput` (boolean). `getPageSummary` →
`getPageSignals` returns `{ summary, hasUnsavedInput }`; `buildSavedTabs` reads both. One
injection, no extra round-trip.

`hasUnsavedInput` is true if any **visible, editable `<input>`/`<textarea>`** has
`value.trim().length >= 2` **and** `value !== defaultValue` (the user changed it from the
server-rendered default).

- Excluded input types: `password` (never read), `hidden`, `submit`, `button`, `reset`,
  `checkbox`, `radio`, `file`, `image`, `range`, `color`. Skip `disabled`/`readonly`.
  "Visible" = `offsetParent !== null` or has client rects.
- Textareas already cover comment/draft boxes (GitHub, Reddit, etc.). Rich
  `contenteditable` editors (Gmail/Slack/Docs) are **out of scope** — keeps detection
  high-precision and sidesteps Google-Docs-style false positives.
- **Privacy:** the boolean is computed *in-page*; **no field contents and no password
  values ever leave the page** or reach the LLM.

### Data model

Add `hasUnsavedInput` (boolean) to each tab object built in `buildSavedTabs`, alongside
`pageSummary` / `lastAccessed`. Both `runSmartScope` paths already receive these tabs.

### The guarantee: extend the existing safety net (`smart-scope.js`)

`hasUnsavedInput` in the payload + the existing prompt handles the **LLM path** on its own.
(The product is moving to a self-run backend where every user is an LLM user; the
BYO-key → hosted-backend migration is tracked separately and is out of scope here.) Even
so, two key-independent paths would still close a form tab — both ending in unrecoverable
loss — so the signal alone isn't enough:

1. **Tab-limit floor.** `enforceMinSaveCount` runs *after* the model and can promote an
   already-kept tab back into the save set to get the user under their clutter limit — so
   a form tab the LLM correctly kept still gets closed when the user is well over
   threshold. Independent of which backend serves the request.
2. **Outage fallback.** When the backend errors or times out, `runSmartScope` falls back
   to the heuristic, which has no prompt; a stale half-filled form gets saved by the
   normal cutoff.

Both are closed by extending the existing final safety net — `forceKeepActiveTabs` (rename
→ `forceKeepProtectedTabs`), already the guard that never closes the `active`/`audible`
tab — so the protected set becomes `active || audible || hasUnsavedInput`. It's the last
step in `runSmartScope`, so it overrides the LLM, the heuristic, the floor, and
`minSaveCount` for **both** paths. This ~2-line change is the whole guarantee; no other
heuristic or floor changes are made.

### LLM path (`smart-scope.js`)

- `buildSmartScopeRequest`: add `hasUnsavedInput` to each `tabsPayload` entry (default
  `false` for tabs lacking it, e.g. eval-corpus tabs).
- Prompt: one line naming the field so the model keeps it first-pass (the existing KEEP
  section already covers "a form being filled in"). No rewrite.

### Tests (`tests/smart-scope.test.js`)

One `runSmartScope` test mirroring the existing active/audible protection: a
`hasUnsavedInput` tab on the heuristic path is never saved (even under `minSaveCount: 99`)
and never appears in a category.

### Eval harness note

`eval/run.js` uses the exported `buildSmartScopeRequest`. The static `corpus.json` has no
form state, so corpus tabs serialize `hasUnsavedInput: false` — non-breaking.

---

## Testing plan

- `node --test tests/*.test.js` — existing 10 + the new protection tests pass.
- Manual (reload unpacked + refresh test tab):
  - Type into a Google Form / any `<textarea>`, leave it stale, hit Smart → tab stays open.
  - Confirm a password field with input does **not** trigger keep (we don't read it; but
    a sibling normal field would).
  - Save repeatedly past the retention limit (temporarily set `maxSavedSessions` low in
    options) → oldest sessions drop, a `review`/pending session is never dropped.
  - Set `maxSavedSessions = 0` → nothing is pruned.

[smart-scope.js:516]: ../../src/smart-scope.js
[background.js:440]: ../../src/background.js
