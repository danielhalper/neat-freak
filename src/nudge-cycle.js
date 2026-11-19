// When Neat Freak runs the AI in the background and when it nudges.
//
// One cycle: over the threshold on a usable page -> one automatic run -> first
// nudge with that list -> one reminder 30 minutes later (same list, only
// pruned) unless the user opened or acted on it, closed the card, or the list
// emptied -> quiet period. Each fully ignored cycle doubles the quiet period
// (90 min, 3 h, 6 h, then 24 h); any engagement resets it to 90 min. If the
// tab count has grown by GROWTH_RESTART_TABS since the last nudge, a new cycle
// may start once the base 90 minutes have passed, whatever the ladder says.
// Nothing runs on a schedule between cycles, so a list never grows without a
// new run.
//
// Pure functions over a plain state object; the service worker persists it in
// chrome.storage.local so a restart or reload does not nudge straight away.

export const REMINDER_DELAY_MS = 30 * 60_000
// The quiet period and its backoff. Change the policy here only: the base
// period after any cycle, the ladder for consecutive ignored cycles (index =
// how many were ignored before), and the growth that skips the ladder.
export const BASE_QUIET_MS = 90 * 60_000
export const QUIET_STEPS_MS = [BASE_QUIET_MS, 3 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000]
export const GROWTH_RESTART_TABS = 10
export const RUN_STALE_MS = 2 * 60_000
// The panel re-checks a list older than this when opened, unless a nudge
// showed that exact list in the last SHOWN_LIST_FRESH_MS (so clicking a
// reminder opens the list it showed instead of re-running).
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
		quietUntil: count(s.quietUntil),
		ignoredStreak: Math.floor(count(s.ignoredStreak)),
		runStartedAt: count(s.runStartedAt),
		nudgedAt: count(s.nudgedAt),
		closedByUser: s.closedByUser === true,
		shownAt: count(s.shownAt),
		shownPlanId: typeof s.shownPlanId === 'string' ? s.shownPlanId : '',
		shownTabCount: count(s.shownTabCount),
		quietFrom: count(s.quietFrom),
		cycleTrigger: TRIGGERS.has(s.cycleTrigger) ? s.cycleTrigger : 'time',
	}
}

export function backoffLevel(cycle) {
	return Math.min(cycle.ignoredStreak, QUIET_STEPS_MS.length - 1)
}

// ctx: { now, nudgesOn, overThreshold, surfaceReady, panelBusy, listCount, tabCount }
// surfaceReady: Chrome is focused on an injectable page. panelBusy: the panel
// is open or mid-review/save (a visible nudge card does not count).
export function nextNudgeStep(cycle, ctx) {
	if (!ctx.nudgesOn) return NONE
	const canShow = ctx.surfaceReady && !ctx.panelBusy
	switch (cycle.phase) {
		case 'running':
			return ctx.now - cycle.runStartedAt > RUN_STALE_MS ? { action: 'end', ignored: false } : NONE
		case 'pending':
			if (!ctx.overThreshold || !ctx.listCount) return { action: 'end', ignored: false }
			return canShow ? { action: 'show', kind: 'first' } : NONE
		case 'nudged':
			if (ctx.now < cycle.nudgedAt + REMINDER_DELAY_MS) return NONE
			if (!ctx.overThreshold || !ctx.listCount) return { action: 'end', ignored: false }
			if (cycle.closedByUser) return { action: 'end', ignored: true }
			return canShow ? { action: 'show', kind: 'reminder' } : NONE
		default: {
			if (!ctx.overThreshold || !canShow) return NONE
			if (ctx.now >= cycle.quietUntil) return { action: 'run', trigger: 'time' }
			// Growth skips the backoff ladder, never the base quiet period.
			const grew = cycle.shownAt > 0 && ctx.tabCount - cycle.shownTabCount >= GROWTH_RESTART_TABS
			return grew && ctx.now >= cycle.quietFrom + BASE_QUIET_MS ? { action: 'run', trigger: 'growth' } : NONE
		}
	}
}

export function startRun(cycle, now, trigger = 'time') {
	return { ...cycle, phase: 'running', runStartedAt: now, nudgedAt: 0, closedByUser: false, cycleTrigger: TRIGGERS.has(trigger) ? trigger : 'time' }
}

export function finishRun(cycle, { now, listCount }) {
	return listCount > 0 ? { ...cycle, phase: 'pending' } : endCycle(cycle, now, { ignored: false })
}

// tabCount: open tabs when the nudge showed, the baseline for the growth rule.
export function markShown(cycle, { now, kind, planId, tabCount }) {
	const shown = { ...cycle, shownAt: now, shownPlanId: planId || '', shownTabCount: count(tabCount) }
	if (kind === 'reminder') return endCycle(shown, now, { ignored: true })
	return { ...shown, phase: 'nudged', nudgedAt: now, closedByUser: false }
}

// The user closed the nudge card themself (the 10-second auto-hide does not
// count). Only the first nudge of a cycle can be closed this way.
export function markClosedByUser(cycle) {
	return cycle.phase === 'nudged' ? { ...cycle, closedByUser: true } : cycle
}

// Opening the list, tidying, pressing Tidy or Refresh.
export function markEngaged(cycle, now) {
	return { ...cycle, phase: 'quiet', ignoredStreak: 0, quietFrom: now, quietUntil: now + BASE_QUIET_MS, closedByUser: false }
}

export function endCycle(cycle, now, { ignored }) {
	const quietMs = ignored ? QUIET_STEPS_MS[backoffLevel(cycle)] : BASE_QUIET_MS
	return {
		...cycle, phase: 'quiet', quietFrom: now, quietUntil: now + quietMs, closedByUser: false,
		ignoredStreak: ignored ? cycle.ignoredStreak + 1 : cycle.ignoredStreak,
	}
}

export function needsIntentRun({ aiOn, plan, now, cycle }) {
	if (!aiOn) return false
	if (!plan || plan.expired) return true
	if (now - plan.createdAt <= LIST_FRESH_MS) return false
	return !(cycle.shownPlanId === plan.id && now - cycle.shownAt <= SHOWN_LIST_FRESH_MS)
}
