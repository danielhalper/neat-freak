# Prepared tidy recommendations: implementation and QA

## Product behavior

Neat Freak prepares an actual Smart save set before offering “N tabs ready to
tidy.” The nudge is one line with Review (left) and Tidy now (right); clicking
Review or anywhere on the card opens the tab list in place, and Review folds it
back without losing Keep choices. Rows are checkboxes: ticked closes, unticked
stays open. The toolbar retains the recommendation when the nudge is dismissed.
A new “Suggested tidy” section sits above the existing scope controls.

Background preparation now starts off, including for existing installations.
Enable it from Suggested tidy or Settings after reading the inline disclosure.
The count-only reminder remains available without page inspection; Find
suggestions performs an explicit check. With preparation enabled, the nudge
shows the prepared save count. The open list labels the AI/local source. On a
local offer, Tidy now opens the list first (enforced in the background too) and
closes on the second press. On an AI offer, Tidy now closes directly.

Proactive mode reuses the content/workstream graph and Smart selector. It removes
both the tab-limit minimum and the fallback percentage, and changes the model
context from “the user clicked Smart” to an optional suggestion with no target
count. Missing model actions default to keep in this mode. The existing manual
Smart command retains its tab-limit behavior. There is no learned personal model.

Keep choices are stored for that exact Chrome tab and URL for the browser session.
They survive explicit Refresh and cancelling a review, but do not become broad
rules such as “always keep Google Docs.” The existing 35-tab corpus contains no
human close/keep labels, so it cannot establish personal preference accuracy.

## Freshness and cost

- Automatic runs: one per nudge cycle (see November 18). Nothing recomputes on
  a schedule; a prepared list is only pruned. Opening the panel with AI on and
  no list, or one older than 30 minutes, starts a run; explicit Refresh still
  recomputes.
- Automatic AI attempts: at most twelve per UTC day, persisted in local storage
  before a request. Worker/browser restarts and failures cannot reset the limit.
  After that, or when the automatic AI call fails, AI users get no local list
  and no nudge. Explicit requests bypass this limit. This bounds request count,
  not tokens or dollars, and does not guarantee a reserved manual quota.
- Five-minute Chrome alarm plus debounced tab/focus events. Existing alarms are
  not reset on every worker wake.
- Explicit Refresh: separate 30-second limit; concurrent requests share one run.
  A cancelled older run cannot swallow or overwrite a new explicit request.
- Nudge: cycle pacing in `src/nudge-cycle.js` (see November 18).
- Visible offers and open reviews do not silently acquire new members. Only a
  fresh, presented recommendation may expand the set. Cheap reconciliation
  removes tabs that changed, were revisited, pinned, started audio or closed.
- Recommendations expire after an hour. Expired or empty nudges retire quietly.
  A delayed Review checks again; a delayed close opens a fresh review and never
  closes the substituted set without a second explicit action.
- Page metadata is not extracted from discarded tabs. Form checks remain local
  even when page summaries are disabled. No browsing-history permission added.
- Proactive model requests time out at 25 seconds and fall back locally; token
  acquisition times out at 10 seconds. No repeated background retry within the
  computation cooldown.

## Execution guarantees

The background validates plan identity and claims the plan in session storage.
A consumed plan cannot execute again after a worker restart. The full chosen
URLs and categories are persisted to local storage before any tab is removed.
Close execution uses four bounded workers, and each tab is rechecked immediately
before removal for URL, pending navigation, activity, recency, audio, pin state,
loading and unsaved/unknown input. Probes cover frames and rich-text editors.

Browser-run IDs prevent old pending tab IDs from being executed after Chrome
restarts. Interrupted journals remain restorable and never automatically resume.
Restoring an incomplete journal skips original tabs still open at their saved URL.
Partial failures remain pending; retry preserves earlier successfully saved tabs.
Reported closure counts reflect actual outcomes. Saved-session edits are blocked
while a close is in progress, preserving its journal.

Chrome does not provide an atomic compare-and-remove operation. The final check
minimizes that race but cannot eliminate it. Form detection is conservative and
best-effort, especially for custom editors; URL restoration is not a recovery
mechanism for application memory. Visual and live-extension validation remains
necessary before shipping.

## Verification completed

- `node --test tests/*.test.js`: 89 passing tests, including actual background
  message routing with synthetic Chrome APIs, lifecycle/race tests, LLM payload
  and response tests, storage failure, partial closure, retry and restore.
- DOM QA executes the shipped panel and background in an isolated synthetic
  browser: in-page and popup modes both pass nudge -> Review -> Keep -> Refresh
  -> changed-tab protection -> close result. Rapid Keep toggles retain final
  state and scroll position. Background opt-in, local-mode labels and review
  requirements are covered. Form checks cover one-character/cleared text,
  checkbox/radio/select/file changes, plaintext editors and open shadow DOM,
  clean select defaults, password non-inspection and read failures. Detected
  editable text is excluded from summaries.
- JavaScript syntax and whitespace checks.
- Two Claude engineering review rounds and a subsequent product review.
  Incorporated fixes for cancelled-refresh
  races, discarded tabs, prior-browser IDs, partial journals, pin-setting
  compatibility, bounded probes and stable review rendering. Deferred broader
  behavioral inference and cluster-wide activation rules to preserve the user's
  requested algorithm.
- Existing local corpus: 35 tab snapshots; heuristic proactive pass selected 17
  into 10 folders. Simulating another 45 minutes without activity selected all
  35 in that metadata-only corpus. This demonstrates the existing fallback's
  recency sensitivity, not prediction accuracy; the corpus lacks real active,
  audio and draft-state signals and human labels. No classifier was tuned to it.

## Remaining release gate

The environment denied binding a local server, and browser automation rejected
file URLs. DOM testing succeeded using cached packages in scratch, but a real
Chrome visual/extension smoke test was not completed. A synthetic live-backend
request failed at DNS resolution (`ENOTFOUND`) before token acquisition; the
actual deployed model path remains unverified here. No changes were pushed.

Before release, load this checkout unpacked in a disposable Chrome profile:

1. Enable background preparation and, on regular pages, exceed the nudge threshold. Verify the prepared count,
   folder preview, immediate Review and no closure before explicit action.
2. Revisit/navigate a recommended tab, play audio, pin a tab and type a draft;
   verify those tabs stay open. Add a new tab; it must not enter the old offer.
3. Leave Review open, toggle Keep, switch tabs and return. Explicit Refresh should
   preserve keeps and include newly eligible tabs; a delayed close must only use
   the displayed selection. Repeat on a `chrome://` page via popup fallback.
4. Save and restore only disposable tabs. Verify partial failures/retry, worker
   restart, responsive layout, scrolling, keyboard interaction and no console errors.
5. Confirm the managed model responds within the proactive deadline, check its
   recommendations against human labels and inspect actual token usage before
   changing the 15-minute cadence.

## Re-running optional DOM QA

The extension still has no build step or production dependency. The DOM runner
accepts the path to an externally installed jsdom package:

```sh
node tests/panel-dom.qa.mjs /path/to/jsdom/lib/api.js
node tests/panel-dom.qa.mjs /path/to/jsdom/lib/api.js --popup
```

`tests/browser-harness.html` runs the same synthetic fixture when served locally.
`node tests/render-browser-harness.mjs /tmp/neat-freak-qa/browser.html` creates an
offline fixture for manual opening. It wraps source modules only for this test
page; it is not part of extension loading or distribution.

## Personal Chrome trial and adversarial review

This is ready for a supervised personal trial, not a release sign-off. Automated
tests establish behavior under their fixtures; they do not establish selection
accuracy, real-page draft coverage, or user trust. A further Claude product
review surfaced the same distinction. The November 4 follow-up implemented
opt-in, fallback visibility/review, bounded automatic AI attempts, prompt
corrections, form protections and disclosures. Core clustering and recency
cutoffs remain unchanged.

### Load the local extension

No server, build, or deployment is required. In Chrome, open
`chrome://extensions`, enable Developer mode, choose Load unpacked, and select
`/Users/danielhalper/Engineering projects/neat-freak`.
If that exact directory is already loaded unpacked, use its Reload button instead.
Refresh the ordinary web page used for testing after reloading the extension.

For a trial in the everyday profile, disable the store copy while using the local
copy; do not uninstall it. The local copy can have a different extension ID and
separate saved sessions/settings. Use Manager > Backup > Export to retain a
portable copy of saved sessions before switching installations. To roll back,
disable the local copy and re-enable the store copy. Do not uninstall the local
copy until any sessions saved during the trial have been restored or exported.

The browser integration can list the existing Neat Freak manager but cannot
control Chrome's internal extensions page. Loading/reloading must be done by the
user; this checkout has not been confirmed running in their Chrome.

### First session

1. Open the local toolbar panel on an ordinary HTTPS page and click **Tidy my
   tabs**. Its second line says what the press does: **N tabs ready to review**
   opens a prepared list at once; **N tabs eligible — Smart will pick** runs a
   tidy now (different, less conservative rules) and, with Review before closing
   on, stops at a list. On a count-only nudge, **Find suggestions** runs a
   check; zero matches says **No tabs suggested right now**.
   The manifest version is still 1.3.0. A diagnostic export marked
   `proactive-trial-4` identifies this revision (one-line offer card).
2. Review real tabs without closing them. Label each suggestion: would put away
   now / still need open / unsure. Keep the latter two. Note the reason without
   recording page contents. There is no enforced read-only trial mode: avoid the
   Tidy now buttons during this observation pass.
3. On disposable pages, leave a review open, revisit one selected tab, navigate
   another, pin another, and start audio on another. Create harmless test drafts
   on real editor/form surfaces. Those tabs must survive the close operation.
   A new tab must not be added to the old offer. Test safety cases in a separate
   profile if an accidental close would matter.
4. Close only a few reviewed disposable tabs and restore them from Manager.
   Confirm the reported count and URLs. Restoration does not recover native tab
   groups, navigation history, scroll position, or unsaved application state.
5. Repeat through the popup on a Chrome internal page, after a long idle period,
   after a browser restart, and with the network unavailable. Use Settings >
   Test backend as an initial connectivity check; it does not establish that a
   large proactive request completes within its shorter deadline. Inspect Chrome
   extension Errors if anything stalls. Test normal worker suspension with its
   developer-tools inspector closed as well as during an inspected session.

### Product review findings and current status

| Risk | Current evidence and release requirement |
| --- | --- |
| Idle mistaken for finished | In the unlabeled metadata corpus, aging tabs expanded local picks from 17 to 35. This is a warning, not an accuracy measurement. Compare suggestions before and after lunch/meetings on real work before changing the algorithm. |
| Silent local fallback | Fixed locally: AI/local source and fallback reasons are visible, and local suggestions require Review. Verify rendering in real Chrome. |
| Background work consumes manual budget | Reduced locally: one automatic run per nudge cycle, and automatic AI attempts are capped at twelve per UTC day. Explicit Refresh remains available. Checked-in backend configuration is 200k tokens per install/day; deployment and actual usage remain unverified. The attempt cap does not reserve tokens for manual work. |
| Background page reading exceeds the disclosure | Fixed locally: preparation defaults off, an inline opt-in explains data processing, and settings/onboarding/privacy/store copy describe candidate inspection before Save. These copy changes have not been published. Disabling summaries still allows titles/URLs to be sent; disabling AI keeps processing local. |
| Different Smart results look arbitrary | Proactive selection has no forced quota; manual Smart retains its minimum-save behavior. Suggestions now label all-window scope and source. Test whether Suggested tidy versus the existing manual command is clear. |
| Safety checks are incomplete on real pages | Custom/shadow-DOM editors, controlled inputs, changed non-text controls, iframe permissions and active web apps require actual Chrome tests. URL recovery is not draft recovery. Any lost draft blocks release. |
| Review becomes more work than cleanup | Measure time to accept, Keep corrections, and whether the interruption helped. An exact count is only useful if the underlying choice earns trust. |
| Keep and recovery expectations | Keep lasts for this tab/URL until the browser session ends. Saved URLs persist, but restored native tab groups/app state are not promised. Check whether either boundary surprises the tester. |

### Two-day evaluation

For each offer, record just the suggested count, how many would be put away now,
how many must stay open, how many are uncertain, time spent reviewing, and whether
the nudge was useful or disruptive. Compare the existing manual flow on a few
equivalent snapshots without executing both. Record model versus local mode and
token usage when available; do not infer a successful model call from a count.

Record immediate regret ("I was still using that") separately from intentional
later retrieval. Restoring a reference tomorrow can be successful product use,
not a bad recommendation. Ignore/dismiss is also not a reliable keep label.
Use explicit Keep decisions and stated regret before adding personal learning.

Proposed personal-trial bar: zero unintended closure/data-loss incidents, zero
silent additions to an accepted offer, reliable delayed close/restore behavior,
and roughly nine out of ten suggestions acceptable without editing across
several work contexts. That quality target is a proposed decision rule, not a
validated accuracy claim, and one person's two-day trial is not general release
evidence. Pause closing on the first harmful mistake. Public release still needs
real-Chrome/model validation, selection-quality evidence, actual cost measurements
and publication of the updated disclosures.

## November 4 follow-up: quiet updates and local diagnostics

The user reported that “Your tabs have changed” was confusing after ignoring a
proactive offer. Normal browsing is expected; cache freshness is not an error
the user needs to diagnose. The panel no longer displays that warning or an
expiration warning. Eligible counts only shrink while an offer is visible.
Empty/expired nudges retire silently; an expanded panel stays open. The toolbar
shows a neutral Find suggestions entry point when the cached offer expires.
Opening an old Review refreshes if needed. Clicking an old close action opens
the refreshed review without closing anything, preserving existing Keep choices.
Newly eligible tabs cannot silently join an accepted close operation.

Rendered-panel QA also exposed a dismissal animation race. Reopening a panel
now cancels its pending removal timer, and Review clears any stale expanded CSS
state so the header remains visible. Tests exercise both in-page and popup modes,
including an expired card, reopening during dismissal, Keep/Refresh, protected
tabs, close counts, and the actual settings export/disable/clear controls.

Local diagnostics are enabled by default in this local trial. The journal keeps
at most 500 events and seven days (pruned on activity). It records suggestion
counts, AI/local mode and fallback reason, durations, review/Keep decisions,
close/restore counts, error categories and safe extension source locations.
An allowlist excludes page titles, URLs, content, drafts, credentials, install
IDs and raw error messages. Random per-tidy references correlate related events.
Writes are serialized; logging failures cannot prevent a tidy. Settings provides
Export diagnostics, Clear diagnostics and a recording checkbox. Exports identify
the one-line offer card revision as `proactive-trial-4`, include the manifest version and four relevant
boolean settings, and never upload automatically. Updated disclosures are local.

Tests cover the retention bound, concurrent writes, worker replacement, opt-out,
storage failure, exported-data filtering, ignored-offer pruning, delayed clicks
and dismissal during recomputation. Passing synthetic tests does not establish
live Chrome or managed-backend behavior.

Activation still requires reloading the unpacked checkout in Chrome and
refreshing existing test pages. No prior usage logs were read, no live browser
interaction was completed in this follow-up, and no telemetry stream to the
assistant exists. After reload, Settings > Local diagnostics > Export diagnostics
provides a deliberate handoff for investigation. That export is the next evidence
needed to confirm real usage, backend availability and actual errors. Nothing
has been pushed or deployed.

## November 12: one Tidy button

Supersedes the panel descriptions above (the “Suggested tidy” section, the offer
card in the panel, and the Find suggestions link in the panel). The nudge card
is unchanged except that Review is a text link (Hide list when open).

- The panel always shows one **Tidy my tabs** button. With a prepared list its
  second line reads “N tabs ready to review” with a tick; otherwise “N tabs
  eligible — Smart will pick”. Either way a press ends at a list, then Tidy now.
- AI picks follow Review before closing (off: “ready to tidy”, the press closes
  them). Local picks always open the list.
- The list footer reads “Picked N min ago · Refresh” (“without AI” for local
  picks). “Reopen anytime” is gone. A list from a press with nothing prepared has
  the same header and Tidy now, with Cancel in place of Hide list / Refresh.
- While a press is heading for a list the working card says “Checking your
  tabs”, not “Tidying”.

## November 14: live check in real Chrome (build proactive-trial-4)

Run against the reloaded unpacked extension with about 138 open tabs.

Worked as built:

- Popup and in-page panel both showed the one Tidy button with “105 tabs ready
  to review” (104 after a refresh) and the tick. A press opened the list at once.
- Keep dropped the count to 104 and the line to “1 kept open. The rest are
  saved.” Hide list folded to Review / Tidy now and kept the choice. Refresh
  showed “Checking tabs…” and returned a new list in 27 s.
- Tidy now closed 104 tabs in 13 s: 0 protected, 0 failed, 0 gone.
- The diagnostics export held 53 entries over 7 days with no URLs, titles or
  addresses, and its events matched each step above.

Found:

- AI did not produce either list. The background run (33 s) and the Refresh
  (27 s) both timed out and fell back to local picks. Over the week, 8 of 10
  prepared lists were timeouts and 1 was a connection error; 1 used AI.
- The local list was 105 of 122 candidates in 17 folders: one of 79 tabs and
  ten of one tab.
- Opening the full panel from the “tabs tucked away” card left “Tidy without
  reviewing next time” on top of the header. Fixed (the toggle is limited to
  the small card); checked in headless Chrome, not yet in the reloaded extension.

Not checked live: the folded nudge card's look on a real page, and the
“ready to tidy” straight close (no AI list arrived). Pushed as `bb4fc7c`.

## November 16–17: timeout fix, live check (build proactive-trial-5)

Covers `ca72b99` (compact background request), `2ebe708` (manual Smart uses it
too) and `c7746f1` (habits log records AI picks). Reloaded unpacked extension.
Evidence: diagnostics and tab-habits exports on both days, and one panel pass
on a test tab on Nov 17.

Background runs, Nov 16 10:05 to Nov 17 00:47 PST (19 runs, 36–70 candidates):

- No timeouts. 14 runs used AI and took 1.5–22.2 s (median 7.7 s; the slowest
  was 3 s inside the 25 s deadline).
- Only 2 of the 19 runs showed a nudge (10:05 and 10:52). The other 17 were
  silent refreshes of a list nobody was looking at.
- 5 runs in a row (13:32–15:48) were local picks with reason
  `background-limit`: the eight automatic AI attempts per UTC day were used up
  by early afternoon and came back at 16:00 local. Local lists suggested 29–44
  of 62–70 candidates; AI lists suggested 1–29 of 36–70.
- AI picks vary on the same tabs. Six runs at 70 candidates suggested 13, 9, 7,
  7, 29 and 8. In the 29 run the habits log shows the model picking 40 of the
  43 tabs it tracked, before the guards.
- In at least 7 runs the AI picked tabs with unsaved form input. The draft
  guard held every one back.
- None of these lists was opened, so there are no outcomes or labels yet and
  `eval/behavior-rules.js` reports no accuracy.

Manual press, Nov 17 (10 eligible tabs, nothing prepared, review on):

- “Checking your tabs” showed at once and the list opened in 4.6 s: 3 tabs in
  one named folder, Cancel and Tidy now. Cancel closed the panel; no tab closed.
- The habits log recorded it as a manual AI run (10 candidates, 3 picked, 3
  offered) and section 2b of the eval now has rows.
- The loaded build carries the done-card toggle rule (`:not(.expanded)`).

Not checked live: the folded nudge card with a prepared list (none was
prepared at 10 tabs), the “ready to tidy” straight close, and the done-card
toggle on screen (needs a real tidy).

## November 18: nudge cycle and pacing (build proactive-trial-6)

Covers `8d819ef` to `4aae62a`. Why: on Nov 16 only 2 of 19 background runs
showed a nudge, the eight-attempt cap ran out by 13:17, and five lists fell
back to local picks.

Rules as built (`src/nudge-cycle.js`, all numbers are constants there):

- Over the tab goal on a usable page: one run, then a nudge. The first cycle
  after a reset also gets one reminder 30 minutes later, unless the list was
  opened, the card was closed by hand, or the list emptied. The 10-second
  auto-hide does not cancel it. It waits up to 30 more minutes for a usable
  page, then is dropped.
- Quiet period after a cycle, by how far over the goal: 3.5 h (up to 100%
  over), 2.5 h (100–250%), 1.5 h (250% and up). Each ignored cycle doubles it,
  capped at 24 h. Goal 20, 70+ tabs, nothing clicked: 0:00, 0:30, 2:00, 5:00,
  11:00.
- Reset to the starting period: engagement (open the list, tidy, Tidy or
  Refresh), or tabs up by half the goal since the last nudge.
- Cycle state lives in `chrome.storage.local`, so a restart does not re-nudge.
- A list a nudge showed in the last 15 minutes opens as is; otherwise the
  30-minute rule above applies when the panel opens.
- Page-signal wait before a run is 1 s per tab (was 4 s). The check before
  closing is unchanged.
- Diagnostics add token totals, tab counts, nudge kind, band and doubling step.

Verified: 169 unit tests; `panel-dom`, `panel-dom --popup` and `panel-intent`
rendered runs with jsdom 29 (jsdom 16 does not settle). An independent review
of `8d819ef` to `b34af87` found no path that closes tabs without a button
press. Its four findings are fixed in `c85b297` to `4aae62a`: a late reminder
followed at once by a new nudge, an AI user nudged with a stored local list,
an AI run started by "See closed tabs", and a missing test for Tidy pressed
during the panel-open run. Left as is: clock set backwards, and a goal changed
mid-cycle.

Not checked live (needs a reload; exports should say `proactive-trial-6`):
first nudge and reminder timing, the two resets, no nudge after a restart
inside a quiet period, the AI-unavailable path, the panel-open run, the 1 s
capture, and token counts in an export. The deployed backend still has the
smaller daily token budget.
