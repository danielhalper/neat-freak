# Proactive Clutter Nudge — Design

Date: 2026-06-01

## Problem

The clutter watcher nudges reactively ("want to tidy?") and the smart
categorization (LLM) runs only on the Tidy click, with >2s latency. Two gaps:

1. **The nudge under-sells.** It asks a question instead of leading with value.
   We want: *"I can tidy 12 of your tabs into 3 folders — expand to see, or just
   Tidy."*
2. **The nudge can go unseen.** It fires on whatever tab is active when the
   threshold is crossed. If that's a `chrome://` tab, the Web Store, or an
   unfocused window, the in-page panel can't render — only the badge shows, and
   it's easily missed.

## Goals

- Value-forward nudge: tab count + expandable folder/URL list + one-click Tidy.
- **Confirmed perception:** present only when it can actually be seen; hold the
  passive badge until then.
- **Fresh plan:** compute the LLM plan at the moment of presentation, not held
  from early detection — so it isn't stale by the time it's shown/acted on.
- **Bounded nag + load:** at most one nudge (and one compute) per cooldown, with
  tier back-off.

## Non-goals

- OS notifications (intentionally dropped — the deferred-presentation model
  removes the need; revisit only if reaching users outside Chrome matters).
- Seen-analytics beyond tier + cooldown tracking.

## State machine

Three states, persisted in `chrome.storage.session` (survives SW restarts):

- **idle** — under threshold, or already alerted for the current tier within the
  cooldown window.
- **armed** — crossed a not-yet-alerted tier and the cooldown has elapsed: we
  owe a reminder and are waiting for a perceivable moment to deliver it.
- **presented** — shown; tier stamped, cooldown running.

Transitions:

1. **Tier-cross** (debounced `onCreated`/`onRemoved`): `currentTier >
   lastAlertedTier` AND cooldown elapsed → **arm**. No LLM yet.
2. **Drop below threshold** while armed → **disarm** (no stale reminder later).
3. **armed + on a valid focused tab** → **present** (compute-on-arrival).
4. **present** → stamp `CLUTTER_ALERTED_TIER` + `CLUTTER_LAST_ALERT_AT`, disarm.

## Triggers

- Existing: `tabs.onCreated`, `tabs.onRemoved` (debounced 3s), the 30-min alarm,
  `onStartup`, SW boot.
- **New:** `chrome.tabs.onActivated` + `chrome.windows.onFocusChanged` →
  `tryPresentReminder()`.

MV3 note: these must be registered at the top level (a dormant SW only wakes for
top-level listeners). The handler's first act is to read the armed flag and bail
if we owe nothing — so the worker briefly wakes on each switch, peeks, and goes
back to sleep. Real work happens only while armed.

## Perceivability gate

"Valid focused tab" = active tab is http(s) (`isInjectablePageUrl`) **and** the
window is focused. If not → remain armed and wait; the toolbar badge carries the
passive signal in the meantime.

## Compute-on-arrival

When presenting (armed + valid tab), run `runSmartScope` on the current
candidate tabs → plan `{ groups, tabActions }` → derive save/keep sets. Cache it
keyed to a hash of the candidate set (`id` + normalized url). Write
`setPanelState({ mode: "clutter", saveCount, groups, planKey })`.

Because compute happens at present-time, the plan is seconds old when shown. The
nudge shows a brief "looking…" then fills in (latency is acceptable per product
call). The backend is the managed/self-run model (`settings.backendUrl` /
`settings.llmModel`), so per-call cost is infra/load, not per-token billing — the
cooldown bounds how often it runs.

## Nudge UI (panel `clutter` state)

- Headline: **"I can tidy N tabs"** (N = save-set count from the plan).
- Expand: folder list (group name + count), each expandable to its URLs.
- Primary: **Tidy** → execute the cached plan.
- Dismiss + mascot as today.

## Freshness on Tidy (delta handling)

On the Tidy click, re-hash the current candidate set vs the cached snapshot:

- Exact match → use cached plan (instant).
- Changed → `classifyDelta(snapshot, current)`:
  - **removed** (id gone) → prune from plan. Free, never forces recompute.
  - **added** (new id) → default to **keep**, unless additions are large.
  - **navigated** (same id, different normalized url) → treat as keep / re-decide.
  - `churn = (added + navigated) / snapshot.size`; `churn > ~0.2` → full
    recompute (brief spinner). Removals excluded from churn.

## Auto-dismiss

- `AUTO_DISMISS_MS` 8s → **10s**.
- **Visibility-paused:** the countdown only advances while the tab is
  visible+focused (`visibilitychange` / `document.hidden`), so 10s = 10s
  on-screen, not 10s of wall-clock that may elapse while they're elsewhere.

## Cooldown / back-off

- `CLUTTER_LAST_ALERT_AT_KEY` — present-time stamp; don't arm/re-present within
  the cooldown (~30–60 min).
- `CLUTTER_ALERTED_TIER_KEY` — highest tier alerted; tier back-off widens the gap
  if the user keeps ignoring it.

## Testable pure functions (Node test harness)

- `hashTabSet(tabs)` → string
- `classifyDelta(snapshot, current)` → `{ removed, added, navigated, churn }`
- `shouldArm({ currentTier, lastAlertedTier, lastAlertAt, now, cooldownMs })` → bool
- `reconcilePlan(plan, delta)` → `{ plan, needsRecompute }`

## Risks / open items

- Residual staleness window is **compute → click** (they look, wander, open
  tabs, then click). Bounded by the 10s visibility-paused dismiss + the
  freshness check on click.
- `onActivated` wakes the SW on every tab switch (MV3 — unavoidable for catching
  the valid-tab moment); accepted, handler bails fast.
- The headline count is itself the LLM's save/keep output, so it can't show
  before compute-on-arrival completes.
