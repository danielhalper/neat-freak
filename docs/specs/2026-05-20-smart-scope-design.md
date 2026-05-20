# Smart Scope — Design Spec

**Date**: 2026-05-20
**Status**: Approved — ready for implementation plan
**Author**: brainstorming with the team

## Summary

Add a third scope option, **Smart**, to the popup's capture switch. Smart looks at how recently each tab was used and at the group context of each tab to decide which tabs to save+close vs. keep open — instead of always saving every eligible tab in the chosen scope.

## Motivation

Today's flow forces a binary: save every eligible tab in the current window, or every eligible tab in all windows. Heavy tab users (50+ open) often have a mix:

- Tabs actively in use right now (clicked in the last few minutes)
- Tabs they're using as reference for an active workstream
- Tabs they opened, glanced at, and forgot about

The first two should stay open. The third should be tucked away. Smart automates that triage so the user doesn't have to manually pre-filter.

## Non-Goals

- Per-tab "do not close" pinning beyond what `chrome.tabs.pinned` already provides.
- A configurable threshold UI for power users. Heuristic thresholds (3h / 8h) are hardcoded for v1; revisit only if users ask.
- URL-update timestamp tracking. `tab.lastAccessed` is the v1 signal.

## User-Visible Behavior

### Popup scope switch

```
[ Smart | All windows | Current ]
```

- **Smart** is the leftmost option and the default scope for new installs. Existing users keep whatever they had previously set in Settings.
- When Smart is selected, the button subtitle reads: `"87 tabs eligible — Smart will pick"`.
- When All windows / Current are selected, the existing subtitle stays: `"87 tabs to save, 2 skipped"`.

### Save flow (Smart with LLM key)

1. Get candidate tabs (filtered by `pinned` / `keepCurrentTab` per More options).
2. Read `tab.lastAccessed` for each candidate, convert to minutes-ago.
3. Build the local association graph (same as today's grouper) → provisional clusters.
4. **One** LLM call to `gpt-5-mini` with: tab list including `lastAccessedMinutesAgo` and `clusterId`, plus the provisional clusters. Strict JSON schema returns both `groups` and `tabActions: { tabId, action: 'save' | 'keep', reason }`.
5. Save+close the `action: 'save'` tabs in their assigned groups.
6. Leave the `action: 'keep'` tabs as live tabs.
7. Done state shows: `"32 saved, 55 kept"` with the calm mascot.

### Save flow (Smart without LLM key — heuristic fallback)

1–3 are the same.
4. For each cluster, compute `maxLastAccessed` (the most recent timestamp in the cluster).
5. Mark cluster as **active** if `maxLastAccessed` ≤ 1 hour ago, else **stale**.
6. Per tab in cluster:
   - If cluster is **stale** and tab's `lastAccessedHoursAgo > 3` → save+close.
   - If cluster is **active** and tab's `lastAccessedHoursAgo > 8` → save+close.
   - Else → keep.
7. Save+close the chosen set, leave the rest open.

The same flow path runs at save time. The `categorizer.js` module needs a new entry point that takes `lastAccessed` data + an optional "Smart" flag.

### LLM prompt (rough)

> You are deciding which open Chrome tabs to save+close and which to keep open, plus how to group the ones you're closing into folders by workstream.
>
> Each tab has: title, url, domain, page summary, last-accessed minutes ago, and a provisional cluster ID from a graph-based grouping pass.
>
> For each tab, decide `action: 'save'` (close + tuck away in a folder) or `action: 'keep'` (leave the live tab alone).
>
> Decide using:
> - **Group context**: if a whole cluster has been cold for hours, all those tabs should likely be saved. If a cluster is actively being used, even the older tabs in it can probably go (the user is focused on the recent ones).
> - **Content + likely priority**: protect anything that looks like work-in-progress — open forms, partially-written drafts, unfinished checkouts. These should be kept open even if they're stale by time.
> - **The distribution of access times**: if everything is recent, nothing is stale. If most things are days old and a few are fresh, the fresh ones are what matter.
>
> Also return `groups`: workstream-aware folder names for the saved tabs, same as the existing categorizer schema.

### Done state

The popup's existing done state already shows the calm mascot, folder list, and Close-live-tabs button. Smart adds one line to the subtitle: `"32 saved · 55 kept open · gpt-5-mini"` (or `"… · heuristic"` when no key).

### Edge cases

- **Smart decides nothing should close**: done state shows `"Nothing's stale yet — all your tabs look fresh."` Calm mascot. No empty session is created.
- **All tabs marked for save**: treated as a full save. Manager auto-opens (existing conditional auto-open logic handles the Chrome-would-quit case).
- **LLM call fails or times out**: automatic fallback to heuristic mode for this save. Done state notes `"Used heuristic (LLM unavailable)"`.
- **Active tab in a stale group**: the active tab is kept open per the existing `keepCurrentTab` setting; the rest of the group is still saved.
- **Pinned tab in stale group**: skipped per the existing `includePinned` setting.
- **Fewer than 5 candidate tabs**: Smart still runs; it will likely decide everything is fresh. No special-casing.

## Architecture

### Files touched

- **[src/storage.js](../../src/storage.js)** — `defaultScope` accepts the new value `"smart"`. New-install default becomes `"smart"`. No version bump required for existing users (their stored value is preserved).
- **[src/background.js](../../src/background.js)** — `getCandidateTabs(options)` accepts `scope: "smart"`. The save flow branches: if `scope === "smart"`, it builds the cluster graph and either invokes the LLM Smart-aware path or applies the heuristic. Per-tab `lastAccessed` is read from `chrome.tabs.query()` (no new permission needed).
- **[src/categorizer.js](../../src/categorizer.js)** — new exported function `runSmartScope(tabs, settings)` that:
  - Reuses the existing association-graph build
  - Either calls the LLM with an enriched prompt + response schema (when key is set) or applies the local 3h/8h heuristic
  - Returns `{ saveSet, keepSet, categories }` where `saveSet` is the tabs to close+store, `keepSet` is the tabs to leave open, and `categories` is the existing folder structure for `saveSet`
- **[popup.html](../../popup.html)** — segmented control gets a third button. New button: `<button class="segmented active" data-scope="smart">Smart</button>` slotted first.
- **[src/popup.js](../../src/popup.js)** — handles the new scope value. `renderPreview()` adapts subtitle copy: `"X tabs eligible — Smart will pick"` when scope is Smart; otherwise current behavior.
- **[options.html](../../options.html)** + **[src/options.js](../../src/options.js)** — the `<select id="default-scope">` gets a third `<option value="smart">Smart</option>` placed first.

### Data flow

```
┌────────────────────────┐
│ User clicks Tidy       │
│ Scope: smart           │
└──────────┬─────────────┘
           │
┌──────────▼─────────────┐
│ getCandidateTabs       │
│ - filter pinned/active │
│ - all windows scope    │
│ - attach lastAccessed  │
└──────────┬─────────────┘
           │
┌──────────▼─────────────┐
│ buildAssociationGraph  │
│ (existing)             │
└──────────┬─────────────┘
           │
       LLM key?
        /        \
      yes         no
       │           │
┌──────▼──┐  ┌────▼──────┐
│ LLM call│  │ Heuristic │
│ groups+ │  │ 3h/8h     │
│ actions │  │ per group │
└──────┬──┘  └────┬──────┘
       │          │
       └────┬─────┘
            │
┌───────────▼────────────┐
│ Split: saveSet / keep  │
└───────────┬────────────┘
            │
┌───────────▼────────────┐
│ Save+close saveSet     │
│ Leave keepSet live     │
│ Show done state        │
└────────────────────────┘
```

### LLM response schema (extension to existing)

Today's schema returns `{ groups: [...] }`. Smart returns `{ groups: [...], tabActions: { tabId: { action: 'save'|'keep', reason: string } } }`. Same `response_format: { type: "json_schema", strict: true }` pattern, just with the `tabActions` object added.

### Per-tab `lastAccessed` availability

`chrome.tabs.Tab.lastAccessed` is available in Chrome 121+ (Jan 2024). The current `host_permissions` already imply tabs access; no new permission needed. For tabs where `lastAccessed` is `undefined` (very rare — happens if the tab was never activated), treat as `Infinity` minutes ago.

## Testing

### Manual

- Load 60+ tabs across 2 windows including: a half-filled form, a recent tab, a tab from 2 hours ago, a tab from 2 days ago.
- Pick Smart, click Tidy.
- Verify: the form tab stays open, the 2-hour-old tab probably stays, the 2-day-old tab gets saved.
- Verify done-state count math: "X saved + Y kept = total eligible."
- Test with LLM key: confirm `tabActions` populated and reasoning is sane.
- Test without LLM key: confirm heuristic-only fallback path (3h / 8h cutoffs).
- Test LLM timeout: with an invalid key, the save should auto-fall-back to heuristic with a notice.

### Unit testable

- `runSmartScope()` with mocked `tabs` and `lastAccessed` values, no LLM — assert correct save/keep partition based on the heuristic.
- Graph clustering input/output unchanged for backwards compatibility.

## Migration

- `settingsVersion` stays at 4. The `defaultScope` field is a free-form string; adding `"smart"` as a valid value requires no schema change.
- Existing users' explicit `defaultScope` is preserved. New installs (no stored settings) get `"smart"`.

## Open Questions

None at time of writing.
