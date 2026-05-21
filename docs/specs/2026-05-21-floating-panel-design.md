# Floating Panel — Design Spec

**Status:** draft, awaiting review
**Replaces:** clutter-toast.js, done-toast.js, and (on http(s) pages) popup.html as the primary surface

## Goal

Collapse Neat Freak's three current surfaces (Chrome action popup, clutter toast, done toast) into a single floating panel that lives top-right of the active page. The panel transitions between collapsed states (clutter / saving / done) and an expanded full-functionality state in place — no dismiss-and-reappear flicker, no "is this a new thing?" disorientation.

## Why

Right now Neat Freak has three visually unrelated surfaces:
- The Chrome popup dropdown (anchored to the toolbar icon)
- The clutter toast (top-right of page, injected)
- The done toast (top-right of page, injected, fires after a save)

They don't share a visual framework, they don't share a position, and the user has to mentally bridge "the thing I clicked" and "the thing that just appeared." The unified panel makes one continuous element that adapts to context.

## Scope

**In scope:**
- One persistent floating panel, top-right anchor, slide-in animation on first mount
- Collapsed (toast-sized, 320px) states: clutter / saving / done
- Expanded (panel-sized, ~360px × ~500px) state with two content variants depending on entry context
- Click extension icon → opens panel (expanded, default)
- Click panel body when collapsed → expands
- Mascot color halo per state (amber for stressed/busy, mint/teal for calm)
- Animated mascot during saving
- popup.html stays as the chrome:// fallback only

**Out of scope (separate effort):**
- Reworking the existing Chrome popup HTML itself — it stays as a chrome:// fallback unchanged
- Search behavior changes
- Smart scope algorithm changes
- The manager page

## States

### Collapsed states (320px wide card)

All three share the same shape: 44×44 mascot in a colored halo, title + sub text, optional × close, action button row.

| Mode | Mascot | Halo color | Title | Sub | Primary action |
|---|---|---|---|---|---|
| `clutter` | stressed | amber (`#fef3c7` / `#f4bd45`) | "N tabs open" | "Want me to tidy up?" | "Tidy now" |
| `saving` | stressed, animated rotate ±9° / 1.1s | amber | "Tidying your tabs" | "Organizing…" w/ animated dots | "Working…" (disabled) |
| `done` | calm | mint (`#d1fae5` / `#0f766e`) | "N tab(s) tucked away" | "{groups} folders · {loose} loose · {keep} kept open" | "Open manager" |

All three are clickable on the body (not the buttons) to expand. The × dismisses to `hidden`.

### Expanded states (~360px × ~500px panel)

The expanded panel reuses ~95% of the existing popup.html UI but with three changes:
1. The "Neat Freak" wordmark is much smaller (small caps eyebrow, not a full title) — the panel is integrated into the page's visual framework, not a Chrome-managed window
2. A close × in the top-right of the panel
3. The "recent sessions" section becomes context-aware (see below)

| Entry context | Recent sessions section shows |
|---|---|
| Icon click, no recent activity | Last 3 sessions, recency-ranked, expandable folders, "Open all" per session and per folder |
| Click clutter-collapsed body | Same as above — "what could I bring back?" context |
| Click done-collapsed body | The session that was JUST saved, pinned at top, folders expanded by default. Below that: older sessions like the default. |

### Recent-sessions component (the "what to reopen" feature)

Each session card shows:
- Session header: timestamp + total tab count + "Open all" button
- Folder rows (expandable via disclosure triangle):
  - Folder name + tab count + "Open all" button
  - Expanded: tab list (favicon, title, click to restore single tab)

Recency ranking: sessions sorted newest-first. Folders within a session sorted by member count descending (largest folder first). Tabs within folders kept in their original order.

This is meaningfully different from today's "recent sessions" which just shows 3 sessions with a "Restore" button per session. The new component is the primary "find your stuff" surface inside the panel.

## Architecture

### Single content script

`src/neat-freak-panel.js` — one file handles all states. Mounts once per page. Idempotent: re-running the script when the element already exists just triggers a re-render from current state.

### State source

`chrome.storage.session.neatFreakPanelState` — the single source of truth.

```ts
type PanelState =
  | { mode: "hidden" }
  | { mode: "clutter"; tabCount: number }
  | { mode: "saving" }
  | { mode: "done"; tabCount: number; groupCount: number; looseCount: number; keepCount: number; sessionId: string }
  | { mode: "expanded"; entry: "default" | "from-clutter" | "from-done"; sessionId?: string }
```

The panel listens to `chrome.storage.onChanged` (area === "session") and re-renders when the key changes. No runtime messaging needed for state syncing.

Note: `chrome.storage.session` requires `setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })` from the service worker on boot (already done in current code).

### Background API

```js
async function setPanelState(state) {
  await chrome.storage.session.set({ neatFreakPanelState: state });
  await ensurePanelMounted(); // executeScript with files: ["src/neat-freak-panel.js"]
}
```

`ensurePanelMounted` injects the panel into the active tab if it's an http(s) page. On a chrome:// page it silently no-ops — the state is still in storage so when the user navigates to a regular page, the panel mounts and reads current state.

### Triggers (background → state writes)

| Event | State written |
|---|---|
| Tab count crosses threshold (clutter watcher) | `clutter` |
| User clicks "Tidy now" in clutter state | `saving`, then run Smart save |
| Save completes (any path: panel, popup, etc.) | `done` if popup not open, else no panel update |
| User clicks extension icon | `expanded` with entry="default" |
| User clicks panel body when collapsed | `expanded` with entry derived from current mode |
| User clicks × | `hidden` |

### Click icon → panel (chrome:// fallback)

Two options. We need to pick one before building:

**Option A: Remove `default_popup`, use `chrome.action.onClicked`.**
- Click icon on http(s) → background fires `setPanelState({ mode: "expanded" })` → panel injects into active tab.
- Click icon on chrome:// page → injection fails → fallback: open the manager tab.
- Pro: clean single-surface story.
- Con: chrome:// users get a *new tab* (the manager), not a popup. Different surface depending on what's active. Disorienting on the new tab page where users open the manager constantly.

**Option B: Keep `popup.html` as a thin shim that injects, then closes itself.**
- Click icon → Chrome opens popup.html → popup script tries to inject the panel into the active tab → if success, popup closes itself → user sees the panel.
- On chrome:// pages, injection fails → popup stays open and renders the existing popup UI inline as the fallback.
- Pro: works on every page, gives a sensible fallback automatically.
- Con: brief flash of the popup before it closes on http(s) pages.

Recommendation: **Option B**. The flash is mitigable (popup starts hidden, injects, closes if success, only shows if needs to fall back). On chrome:// pages we get the existing popup UX for free.

### Lifecycle

- Panel persists across state transitions (mount once, re-render on storage change).
- Panel destroyed on `mode: "hidden"` or × click.
- Page navigation destroys the panel naturally (new DOM). Next state write re-injects on the new active tab.
- Multiple tabs may have a panel simultaneously if user switches tabs mid-flow. Each tab's panel reads the same storage state, so they stay in sync. Reasonable; users see consistency wherever they look.

### Popup suppression

Existing port-counter (`popup-alive` long-lived connection) stays. When the Chrome action popup is open (chrome:// fallback case), `setPanelState({ mode: "done" })` from a save still writes to storage, but `ensurePanelMounted` short-circuits if popup is open — popup handles its own done state, panel doesn't compete.

## Phasing

### Phase 2A — Unified collapsed panel
Build the panel script with clutter / saving / done collapsed states. Replace `showClutterToast` and `showDoneToast` with `setPanelState` calls. Smooth in-place transitions. No expanded view yet — click on body is a no-op or shows a stub.

**Acceptance:**
- Threshold crossing shows clutter panel
- Tidy now → panel stays mounted, transitions to saving, then done
- Mascot animations work (rotate during saving, halo color change between states)
- Existing popup-driven save still produces done state via the same panel

### Phase 2B — Expanded view
Add the expanded state. Implement the full popup-equivalent UI inside the shadow DOM: scope picker, preview, save button, recent sessions placeholder, search. Smaller "Neat Freak" eyebrow. Smooth grow animation from collapsed to expanded.

**Acceptance:**
- Click panel body in any collapsed state → expands in place
- All popup actions work from inside the panel
- × collapses or hides

### Phase 2C — Click extension icon → panel
Implement Option B (popup-as-shim) per above. Verify chrome:// fallback still works.

**Acceptance:**
- Click icon on http(s) → panel appears expanded
- Click icon on chrome://newtab → popup.html renders inline as fallback
- No double-popup or flash on the http(s) case

### Phase 2D — Recommended sessions feature
Build the recency-ranked session component for the expanded view:
- Sessions sorted newest-first
- Folders within sessions sorted by size descending
- Per-folder "Open all" button, per-session "Open all" button, per-tab single-restore
- Done-context variant: just-saved session pinned at top, folders expanded

**Acceptance:**
- Expanded view from icon-click shows last 3 sessions ranked, expandable folders
- Expanded view from done-collapsed shows the just-saved session as the primary content
- "Open all" actions match existing manager's restore-group / restore-session behavior

## Locked decisions

1. **Icon click → Option B (popup-shim).** Keep `popup.html` as a thin shim that tries to inject the panel and closes itself on success; renders the existing popup UI inline only when injection fails (chrome:// pages). Mitigate the on-success flash by hiding the popup body until the inject result comes back.
2. **Auto-dismiss only when trigger-opened.** Clutter (threshold crossed) and done (save completed) collapsed states auto-dismiss after 8 seconds. User-opened expanded state never auto-dismisses — only × / outside-click closes it.
3. **Outside-click behavior.** Collapsed → no-op (use × to dismiss explicitly). Expanded → collapses back to the preceding collapsed state (clutter / done) or to `hidden` if there was no preceding collapsed context.
4. **Per-step progress in the saving state.** Yes. The popup already gets per-step labels via `emitProgress`; pipe the same updates into the panel state. Saving sub-text shows "Capturing N URLs…" → "Grouping…" → "Saving…".
5. **"Open all" on a just-saved session.** Default: silent confirm if the session is less than 60 seconds old ("Reopen all N tabs you just tucked away?"). Beyond that age, no confirm. Revisit during Phase 2D if it feels wrong in practice.
6. **Small viewports.** Width clamps to `min(360px, calc(100vw - 32px))`. On a 500px window this lands at ~468px wide which is fine; on a 320px Chrome window it shrinks gracefully.

## Visual language

The collapsed states inherit the aesthetic established in the current `clutter-toast.js`:
- Card: 340px wide (clamped on narrow viewports), `#fdfcf8` cream background, `#e8dfc7` warm border, 14px radius
- Box shadow with subtle teal tint (`rgba(15, 118, 110, 0.22)`)
- 3px gradient bar across the top (amber for clutter/saving, teal for done)
- Mascot: 60px, free-standing (no halo), drop-shadow tinted teal, gentle wobble on entrance
- Title 14px/600, sub 13px/regular, muted text color
- Close button absolute top-right inside the card, neutral until hover
- Actions row separated from body by dashed border
- Primary button colored by state context:
  - Clutter / saving: amber (`#f4bd45`) — "attention needed"
  - Done: teal (`#0f766e`) — "success, calmly done"

## Trade-offs accepted

- **Panel cannot render on chrome:// pages.** This is a hard browser limitation, mitigated by the popup.html chrome:// fallback (Option B).
- **One floating panel per active tab.** Switching tabs mid-save means the panel may exist on two tabs simultaneously. They stay in sync via storage but it's a small UX wrinkle.
- **Lost convention: "click outside to dismiss".** Chrome action popups have this for free. The injected panel needs explicit outside-click handling (or doesn't — see open question #3).
- **Lost convention: keyboard shortcut to open popup.** Users with `Ctrl+Shift+L` (or whatever they bind) opening the action popup → on http(s) pages, this triggers the popup-shim which injects the panel. Same UX. On chrome:// pages, opens the popup. Should preserve.

## Files affected

- New: `src/neat-freak-panel.js` (the panel script)
- New: `docs/specs/2026-05-21-floating-panel-design.md` (this doc)
- Modified: `src/background.js` (replace `showClutterToast` / `showDoneToast` with `setPanelState`; new message routes for `PANEL_TIDY_NOW`, `PANEL_OPEN_MANAGER`, `PANEL_EXPAND`, etc.)
- Modified: `src/popup.js` (Phase 2C: try injection on open, close if success, otherwise render inline)
- Deleted: `src/clutter-toast.js`, `src/done-toast.js` (absorbed into the panel)
- Manifest unchanged (web_accessible_resources for mascot SVGs already in place)

## Estimated complexity

- Phase 2A: ~150 lines panel script + ~30 lines background changes. Half a focused work session.
- Phase 2B: Big — expanded view is essentially porting popup.html into the panel shadow DOM. Full session.
- Phase 2C: Small — popup-shim is ~20 lines.
- Phase 2D: Medium — session component rendering, recency sort, restore plumbing already exists in manager.js (can lift logic).

Total: roughly 2 focused work sessions if 2A → 2D in order, with a review checkpoint after each.
