// When Neat Freak runs the AI in the background and when it nudges.
//
// A cycle: over the tab goal on a usable page -> one automatic run -> a nudge.
// The first cycle after a reset (start, engagement or growth) also has a
// reminder slot 30 minutes later, where the same (pruned) list shows again
// unless the user opened or acted on it, closed the card, or the list emptied.
// If the page isn't usable at the slot the reminder waits up to
// REMINDER_GRACE_MS; otherwise the cycle ends at the slot without it. A repeat
// cycle shows its one nudge and ends right then.
//
// Then a quiet period. It starts from how far over the goal the user is
// (OVER_GOAL_BANDS) and doubles for each cycle in a row without engagement, up
// to QUIET_CAP_MS. Engagement, or tab growth of GROWTH_RESET_SHARE of the goal
// since the last nudge, resets it to the starting period. The due time is
// worked out from the current level at every check. Nothing runs on a schedule
// between cycles, so a list never grows without a new run.
//
// Pure functions over a plain state object; the service worker persists it in
// chrome.storage.local so a restart or reload does not nudge straight away.

// ---- Pacing: change the policy here only. ----
export const REMINDER_DELAY_MS = 30 * 60_000
// The reminder may show this long after its slot, waiting for a usable page;
// after that it is dropped (e.g. the laptop slept through it).
export const REMINDER_GRACE_MS = 30 * 60_000
// false: only the first cycle after a reset (start, engagement or growth) gets
// the 30-minute reminder; repeat cycles go quiet when their nudge shows.
// true: every cycle gets the reminder slot.
export const REMIND_EVERY_CYCLE = false
// Starting quiet period by over = (open tabs - goal) / goal. A band applies
// from its fromOver upward (goal 20: 20-39, 40-69 and 70+ tabs).
export const OVER_GOAL_BANDS = [
	{ name: 'up-to-100', fromOver: 0, quietMs: 210 * 60_000 },
	{ name: '100-250', fromOver: 1, quietMs: 150 * 60_000 },
	{ name: 'over-250', fromOver: 2.5, quietMs: 90 * 60_000 },
]
export const QUIET_CAP_MS = 24 * 3_600_000
// Growth since the last nudge, as a share of the goal, that resets the doubling.
export const GROWTH_RESET_SHARE = 0.5
// ---- end of pacing ----

export const RUN_STALE_MS = 2 * 60_000
// Freshness for opening the panel (see needsIntentRun).
export const LIST_FRESH_MS = 30 * 60_000
export const SHOWN_LIST_FRESH_MS = 15 * 60_000

const PHASES = new Set(['idle', 'running', 'pending', 'nudged', 'quiet'])
const TRIGGERS = new Set(['time', 'growth'])
const NONE = Object.freeze({ action: 'none' })

function count(value) {
	return Number.isFinite(value) && value >= 0 ? value : 0
}

export function readCycle(stored) {
	const s = stored && typeof stored === 'object' ? stored : {}
	return {
		phase: PHASES.has(s.phase) ? s.phase : 'idle',
		// Cycles in a row without engagement, including the last one ended.
		ignoredStreak: Math.floor(count(s.ignoredStreak)),
		quietFrom: count(s.quietFrom),
		// Doubling step of the current quiet period (0 = starting period).
		quietStep: Math.floor(count(s.quietStep)),
		runStartedAt: count(s.runStartedAt),
		nudgedAt: count(s.nudgedAt),
		closedByUser: s.closedByUser === true,
		shownAt: count(s.shownAt),
		shownPlanId: typeof s.shownPlanId === 'string' ? s.shownPlanId : '',
		shownTabCount: count(s.shownTabCount),
		cycleTrigger: TRIGGERS.has(s.cycleTrigger) ? s.cycleTrigger : 'time',
		startBand: Math.min(Math.floor(count(s.startBand)), OVER_GOAL_BANDS.length - 1),
		startStep: Math.floor(count(s.startStep)),
		startStreak: Math.floor(count(s.startStreak)),
	}
}

export function bandFor(tabCount, goal) {
	let band = 0
	OVER_GOAL_BANDS.forEach((entry, index) => {
		if (tabCount - goal >= entry.fromOver * goal - 1e-9) band = index
	})
	return band
}

// When the current quiet period ends, from the level right now.
export function quietDue(cycle, { tabCount, goal }) {
	const band = bandFor(tabCount, goal)
	if (cycle.phase === 'idle') return { due: 0, band, step: 0, grew: false }
	const grew = cycle.shownAt > 0 && tabCount - cycle.shownTabCount >= goal * GROWTH_RESET_SHARE
	const step = grew ? 0 : cycle.quietStep
	const due = cycle.quietFrom + Math.min(OVER_GOAL_BANDS[band].quietMs * 2 ** step, QUIET_CAP_MS)
	return { due, band, step, grew }
}

// ctx: { now, nudgesOn, overThreshold, surfaceReady, panelBusy, listCount, tabCount, goal }
// surfaceReady: Chrome is focused on an injectable page. panelBusy: the panel
// is open or mid-review/save (a visible nudge card does not count).
export function nextNudgeStep(cycle, ctx, { remindEveryCycle = REMIND_EVERY_CYCLE } = {}) {
	if (!ctx.nudgesOn) return NONE
	const canShow = ctx.surfaceReady && !ctx.panelBusy
	switch (cycle.phase) {
		case 'running':
			return ctx.now - cycle.runStartedAt > RUN_STALE_MS ? { action: 'end', counted: false, at: ctx.now } : NONE
		case 'pending':
			if (!ctx.overThreshold || !ctx.listCount) return { action: 'end', counted: false, at: ctx.now }
			return canShow ? { action: 'show', kind: 'first' } : NONE
		case 'nudged': {
			const slot = cycle.nudgedAt + REMINDER_DELAY_MS
			if (ctx.now < slot) return NONE
			const wanted = !cycle.closedByUser && ctx.overThreshold && ctx.listCount > 0
				&& (remindEveryCycle || cycle.startStreak === 0)
			if (!wanted || ctx.now > slot + REMINDER_GRACE_MS) return { action: 'end', counted: true, at: slot }
			return canShow ? { action: 'show', kind: 'reminder' } : NONE
		}
		default: {
			if (!ctx.overThreshold || !canShow) return NONE
			const quiet = quietDue(cycle, ctx)
			if (ctx.now < quiet.due) return NONE
			return { action: 'run', trigger: quiet.grew ? 'growth' : 'time', band: quiet.band, step: quiet.step }
		}
	}
}

// start: the 'run' step (trigger, band, step). Growth resets the doubling.
export function startRun(cycle, now, { trigger = 'time', band = 0, step = 0 } = {}) {
	const streak = trigger === 'growth' ? 0 : cycle.ignoredStreak
	return {
		...cycle, phase: 'running', runStartedAt: now, nudgedAt: 0, closedByUser: false,
		cycleTrigger: TRIGGERS.has(trigger) ? trigger : 'time', startBand: band, startStep: step,
		startStreak: streak, ignoredStreak: streak,
	}
}

export function finishRun(cycle, { now, listCount }) {
	return listCount > 0 ? { ...cycle, phase: 'pending' } : endCycle(cycle, now, { counted: false })
}

// tabCount: open tabs when the nudge showed, the baseline for growth.
// Showing the reminder ends the cycle; quiet starts when it showed. A repeat
// cycle has no slot, so it ends, and its quiet period starts, at its nudge.
export function markShown(cycle, { now, kind, planId, tabCount }, { remindEveryCycle = REMIND_EVERY_CYCLE } = {}) {
	const shown = { ...cycle, shownAt: now, shownPlanId: planId || '', shownTabCount: count(tabCount) }
	if (kind === 'reminder') return endCycle(shown, now, { counted: true })
	if (!remindEveryCycle && cycle.startStreak > 0) return endCycle(shown, now, { counted: true })
	return { ...shown, phase: 'nudged', nudgedAt: now, closedByUser: false }
}

// The user closed the nudge card themself (the 10-second auto-hide does not
// count): no reminder, and no engagement either.
export function markClosedByUser(cycle) {
	return cycle.phase === 'nudged' ? { ...cycle, closedByUser: true } : cycle
}

// Opening the list, tidying, pressing Tidy or Refresh.
export function markEngaged(cycle, now) {
	return { ...cycle, phase: 'quiet', ignoredStreak: 0, quietStep: 0, quietFrom: now, closedByUser: false }
}

// counted: a cycle (a first nudge was shown) ended without engagement, so the
// next quiet period doubles. Uncounted endings (nothing to show, a lost run)
// wait the starting period and leave the doubling where it was.
export function endCycle(cycle, at, { counted }) {
	return {
		...cycle, phase: 'quiet', quietFrom: at, closedByUser: false,
		quietStep: counted ? cycle.ignoredStreak : 0,
		ignoredStreak: counted ? cycle.ignoredStreak + 1 : cycle.ignoredStreak,
	}
}

// Opening the panel shows a list aimed at the goal. A list a nudge showed in
// the last SHOWN_LIST_FRESH_MS is reused, so clicking a nudge opens its list
// at once; a list the user asked for (plan.requested) is reused while it is
// under LIST_FRESH_MS old. Anything else, including a fresh automatic list,
// gets a new run.
export function needsIntentRun({ aiOn, plan, now, cycle }) {
	if (!aiOn) return false
	if (!plan || plan.expired) return true
	if (cycle.shownPlanId === plan.id && now - cycle.shownAt <= SHOWN_LIST_FRESH_MS) return false
	return !(plan.requested && now - plan.createdAt <= LIST_FRESH_MS)
}
