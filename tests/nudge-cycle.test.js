import test from 'node:test'
import assert from 'node:assert/strict'
import {
	REMINDER_DELAY_MS, REMINDER_GRACE_MS, REMIND_EVERY_CYCLE, OVER_GOAL_BANDS, QUIET_CAP_MS, GROWTH_RESET_SHARE,
	RUN_STALE_MS, LIST_FRESH_MS, SHOWN_LIST_FRESH_MS,
	readCycle, bandFor, quietDue, nextNudgeStep, startRun, finishRun, markShown, markClosedByUser,
	markEngaged, endCycle, needsIntentRun,
} from '../src/nudge-cycle.js'

const T0 = 1_800_000_000_000
const MIN = 60_000
const GOAL = 20
const ready = { nudgesOn: true, overThreshold: true, surfaceReady: true, panelBusy: false, listCount: 5, tabCount: 30, goal: GOAL }
const step = (cycle, ctx = {}, options) => nextNudgeStep(cycle, { now: T0, ...ready, ...ctx }, options)

// An ignored cycle at `now` with `tabCount` tabs: run, nudge, and the reminder
// at the slot when this cycle gets one (only the first after a reset).
function ignoredCycle(cycle, now, tabCount = 30, nudges = []) {
	const start = step(cycle, { now, tabCount })
	assert.equal(start.action, 'run')
	cycle = finishRun(startRun(cycle, now, start), { now, listCount: 5 })
	cycle = markShown(cycle, { now, kind: 'first', planId: 'plan-a', tabCount })
	nudges.push(now)
	if (cycle.phase !== 'nudged') return cycle
	const slot = now + REMINDER_DELAY_MS
	assert.deepEqual(step(cycle, { now: slot, tabCount }), { action: 'show', kind: 'reminder' })
	nudges.push(slot)
	return markShown(cycle, { now: slot, kind: 'reminder', planId: 'plan-a', tabCount })
}
const quietMinutes = (cycle, tabCount = 30) => (quietDue(cycle, { tabCount, goal: GOAL }).due - cycle.quietFrom) / MIN

test('pacing numbers are named constants in one place', () => {
	assert.deepEqual(OVER_GOAL_BANDS.map(band => [band.name, band.fromOver, band.quietMs / MIN]),
		[['up-to-100', 0, 210], ['100-250', 1, 150], ['over-250', 2.5, 90]])
	assert.equal(QUIET_CAP_MS, 24 * 60 * MIN)
	assert.equal(GROWTH_RESET_SHARE, 0.5)
	assert.equal(REMINDER_DELAY_MS, 30 * MIN)
	assert.equal(REMINDER_GRACE_MS, 30 * MIN)
	assert.equal(REMIND_EVERY_CYCLE, false)
})

test('bands by how far over the goal: with a goal of 20, 20-39, 40-69 and 70+ tabs', () => {
	assert.deepEqual([20, 39, 40, 69, 70, 300].map(tabs => OVER_GOAL_BANDS[bandFor(tabs, GOAL)].name),
		['up-to-100', 'up-to-100', '100-250', '100-250', 'over-250', 'over-250'])
})

test('a fresh cycle runs once when over the goal on a usable page, and not otherwise', () => {
	const cycle = readCycle(undefined)
	assert.deepEqual(step(cycle), { action: 'run', trigger: 'time', band: 0, step: 0 })
	assert.deepEqual(step(cycle, { overThreshold: false }), { action: 'none' })
	assert.deepEqual(step(cycle, { surfaceReady: false }), { action: 'none' })
	assert.deepEqual(step(cycle, { nudgesOn: false }), { action: 'none' })
	assert.deepEqual(step(cycle, { panelBusy: true }), { action: 'none' }, 'an open panel runs its own check')
})

test('stored cycle state is read defensively', () => {
	assert.deepEqual(readCycle({ phase: 'bogus', quietFrom: 'x', ignoredStreak: -4 }), readCycle(undefined))
	assert.equal(readCycle({ phase: 'quiet', quietFrom: T0, ignoredStreak: 2 }).ignoredStreak, 2)
})

test('a run with a list waits to show its first nudge; a run with nothing waits the starting period without doubling', () => {
	const running = startRun(readCycle(undefined), T0, step(readCycle(undefined)))
	assert.deepEqual(step(running), { action: 'none' }, 'never a second run while one is in flight')
	const pending = finishRun(running, { now: T0, listCount: 5 })
	assert.deepEqual(step(pending), { action: 'show', kind: 'first' })
	assert.deepEqual(step(pending, { surfaceReady: false }), { action: 'none' }, 'the list waits for a usable page, no re-run')
	const empty = finishRun(running, { now: T0, listCount: 0 })
	assert.equal(empty.phase, 'quiet')
	assert.equal(quietMinutes(empty), 210)
	assert.equal(empty.ignoredStreak, 0)
})

test('a pending list that empties or drops below the goal ends without a cycle', () => {
	const pending = finishRun(startRun(readCycle(undefined), T0, step(readCycle(undefined))), { now: T0, listCount: 5 })
	assert.deepEqual(step(pending, { listCount: 0 }), { action: 'end', counted: false, at: T0 })
	assert.deepEqual(step(pending, { overThreshold: false }), { action: 'end', counted: false, at: T0 })
})

test('a run lost to a worker restart is abandoned after a while', () => {
	const running = startRun(readCycle(undefined), T0, step(readCycle(undefined)))
	assert.deepEqual(step(running, { now: T0 + RUN_STALE_MS + 1 }), { action: 'end', counted: false, at: T0 + RUN_STALE_MS + 1 })
})

test('the reminder comes at the 30-minute slot, waits up to 30 more minutes for a usable page, and times quiet from when it shows', () => {
	const nudged = markShown(finishRun(startRun(readCycle(undefined), T0, step(readCycle(undefined))), { now: T0, listCount: 5 }), { now: T0, kind: 'first', planId: 'plan-1', tabCount: 30 })
	const slot = T0 + REMINDER_DELAY_MS
	assert.deepEqual(step(nudged, { now: slot - 1 }), { action: 'none' })
	assert.deepEqual(step(nudged, { now: slot }), { action: 'show', kind: 'reminder' })
	assert.deepEqual(step(nudged, { now: slot + 5 * MIN, surfaceReady: false }), { action: 'none' }, 'unfocused: wait inside the window')
	assert.deepEqual(step(nudged, { now: slot, panelBusy: true }), { action: 'none' })
	assert.deepEqual(step(nudged, { now: slot + 10 * MIN }), { action: 'show', kind: 'reminder' }, 'focused 10 minutes later: show it then')
	const late = markShown(nudged, { now: slot + 10 * MIN, kind: 'reminder', planId: 'plan-1', tabCount: 30 })
	assert.equal(late.phase, 'quiet')
	assert.equal(late.quietFrom, slot + 10 * MIN, 'quiet is timed from when it showed')
	assert.deepEqual(step(nudged, { now: slot + REMINDER_GRACE_MS + 1 }), { action: 'end', counted: true, at: slot }, 'past the window nothing shows')
	assert.deepEqual(step(markClosedByUser(nudged), { now: slot }), { action: 'end', counted: true, at: slot }, 'closing by hand skips the reminder and is no engagement')
	assert.deepEqual(step(nudged, { now: slot, listCount: 0 }), { action: 'end', counted: true, at: slot })
	assert.deepEqual(step(nudged, { now: slot, overThreshold: false }), { action: 'end', counted: true, at: slot })
	assert.equal(markClosedByUser(readCycle(undefined)).phase, 'idle', 'closing only counts on a shown nudge')
})

test('a laptop asleep through the reminder window gives one nudge on waking, not a late reminder plus a nudge', () => {
	const at = (h, m = 0) => T0 + (h * 60 + m) * MIN
	const asleep = { surfaceReady: false, panelBusy: false }
	let cycle = finishRun(startRun(readCycle(undefined), at(18), step(readCycle(undefined), { now: at(18) })), { now: at(18), listCount: 1 })
	cycle = markShown(cycle, { now: at(18), kind: 'first', planId: '', tabCount: 30 })
	assert.deepEqual(step(cycle, { now: at(18, 10), ...asleep }), { action: 'none' })
	const shown = []
	let now = at(32) // 08:00 the next day
	for (let i = 0; i < 4; i++) {
		const next = step(cycle, { now })
		if (next.action === 'end') cycle = endCycle(cycle, next.at, next)
		else if (next.action === 'run') cycle = finishRun(startRun(cycle, now, next), { now, listCount: 1 })
		else if (next.action === 'show') { shown.push([next.kind, now]); cycle = markShown(cycle, { now, kind: next.kind, planId: '', tabCount: 30 }) }
		now += 1_000
	}
	assert.deepEqual(shown, [['first', at(32) + 2_000]], 'exactly one nudge at 08:00 and no reminder')
	assert.equal(cycle.phase, 'quiet', 'a repeat cycle ends at its one nudge')
})

test('only the first cycle after a reset gets the reminder; a repeat cycle goes quiet when its nudge shows', () => {
	let cycle = ignoredCycle(readCycle(undefined), T0)
	const next = cycle.quietFrom + 210 * MIN
	const running = finishRun(startRun(cycle, next, step(cycle, { now: next })), { now: next, listCount: 5 })
	cycle = markShown(running, { now: next, kind: 'first', planId: 'plan-b', tabCount: 30 })
	assert.equal(cycle.phase, 'quiet', 'no reminder slot on a repeat cycle')
	assert.equal(cycle.quietFrom, next)
	assert.equal(cycle.quietStep, 1)
	const always = markShown(running, { now: next, kind: 'first', planId: 'plan-b', tabCount: 30 }, { remindEveryCycle: true })
	assert.equal(always.phase, 'nudged', 'REMIND_EVERY_CYCLE = true would keep the slot')
	assert.deepEqual(step(always, { now: next + REMINDER_DELAY_MS }, { remindEveryCycle: true }), { action: 'show', kind: 'reminder' })
	assert.deepEqual(step(always, { now: next + REMINDER_DELAY_MS }), { action: 'end', counted: true, at: next + REMINDER_DELAY_MS })
})

test('worked examples, nothing clicked and nothing changing: nudge times by band', () => {
	const schedule = tabCount => {
		let cycle = readCycle(undefined)
		const nudges = []
		let now = T0
		while (nudges.length < 5 && now - T0 < 48 * 60 * MIN) {
			cycle = ignoredCycle(cycle, now, tabCount, nudges)
			now = quietDue(cycle, { tabCount, goal: GOAL }).due
		}
		return nudges.map(at => `${Math.floor((at - T0) / 60 / MIN)}:${String((at - T0) / MIN % 60).padStart(2, '0')}`)
	}
	assert.deepEqual(schedule(75).slice(0, 5), ['0:00', '0:30', '2:00', '5:00', '11:00'], 'top band (70+ tabs, goal 20)')
	assert.deepEqual(schedule(30).slice(0, 4), ['0:00', '0:30', '4:00', '11:00'], 'lowest band (20-39 tabs)')
})

test('starting quiet period by level, then each cycle without engagement doubles it, capped at 24 hours', () => {
	const ladder = tabCount => {
		let cycle = readCycle(undefined)
		let now = T0
		const waits = []
		for (let i = 0; i < 6; i++) {
			cycle = ignoredCycle(cycle, now, tabCount)
			waits.push(quietMinutes(cycle, tabCount))
			assert.deepEqual(step(cycle, { now: quietDue(cycle, { tabCount, goal: GOAL }).due - 1, tabCount }), { action: 'none' })
			now = quietDue(cycle, { tabCount, goal: GOAL }).due
		}
		return waits
	}
	assert.deepEqual(ladder(30), [210, 420, 840, 1440, 1440, 1440])
	assert.deepEqual(ladder(50), [150, 300, 600, 1200, 1440, 1440])
	assert.deepEqual(ladder(80), [90, 180, 360, 720, 1440, 1440])
})

test('the due time follows the current level, so moving into a higher band shortens the wait', () => {
	let cycle = ignoredCycle(readCycle(undefined), T0, 35)
	cycle = ignoredCycle(cycle, quietDue(cycle, { tabCount: 35, goal: GOAL }).due, 35)
	assert.equal(quietMinutes(cycle, 35), 420, 'second cycle without engagement at 35 tabs')
	assert.equal(quietMinutes(cycle, 44), 300, '44 tabs: the 100-250% band, still doubled (growth under half the goal)')
	assert.deepEqual(step(cycle, { now: cycle.quietFrom + 300 * MIN, tabCount: 44 }), { action: 'run', trigger: 'time', band: 1, step: 1 })
	assert.deepEqual(step(cycle, { now: cycle.quietFrom + 299 * MIN, tabCount: 44 }), { action: 'none' })
})

test('growth of half the goal since the last nudge resets the doubling to the starting period', () => {
	let cycle = ignoredCycle(readCycle(undefined), T0, 30)
	cycle = ignoredCycle(cycle, quietDue(cycle, { tabCount: 30, goal: GOAL }).due, 30)
	cycle = ignoredCycle(cycle, quietDue(cycle, { tabCount: 30, goal: GOAL }).due, 30)
	assert.equal(quietMinutes(cycle, 30), 840)
	assert.equal(quietMinutes(cycle, 39), 840, '9 new tabs is under half the goal')
	assert.equal(quietMinutes(cycle, 40), 150, '10 new tabs: starting period, and 40 tabs is the 100-250% band')
	const start = step(cycle, { now: cycle.quietFrom + 150 * MIN, tabCount: 40 })
	assert.deepEqual(start, { action: 'run', trigger: 'growth', band: 1, step: 0 })
	cycle = finishRun(startRun(cycle, cycle.quietFrom + 150 * MIN, start), { now: cycle.quietFrom + 150 * MIN, listCount: 5 })
	assert.equal(cycle.ignoredStreak, 0, 'growth resets the doubling')
	cycle = markShown(cycle, { now: cycle.runStartedAt, kind: 'first', planId: 'plan-g', tabCount: 40 })
	cycle = markShown(cycle, { now: cycle.runStartedAt + REMINDER_DELAY_MS, kind: 'reminder', planId: 'plan-g', tabCount: 40 })
	assert.equal(quietMinutes(cycle, 40), 150, 'the next wait starts again from the starting period')
	assert.equal(cycle.shownTabCount, 40, 'growth is measured from the latest nudge')
})

test('any engagement resets to the starting quiet period for the current level', () => {
	let cycle = ignoredCycle(readCycle(undefined), T0, 30)
	cycle = ignoredCycle(cycle, quietDue(cycle, { tabCount: 30, goal: GOAL }).due, 30)
	cycle = markEngaged(cycle, T0 + 999 * MIN)
	assert.equal(cycle.phase, 'quiet')
	assert.equal(cycle.ignoredStreak, 0)
	assert.equal(cycle.quietFrom, T0 + 999 * MIN)
	assert.equal(quietMinutes(cycle, 30), 210)
	assert.equal(quietMinutes(cycle, 80), 90)
	const nudged = markShown(finishRun(startRun(readCycle(undefined), T0, step(readCycle(undefined))), { now: T0, listCount: 5 }), { now: T0, kind: 'first', planId: 'plan-1', tabCount: 30 })
	assert.deepEqual(step(markEngaged(nudged, T0 + 5 * MIN), { now: T0 + REMINDER_DELAY_MS }), { action: 'none' }, 'no reminder after the list was opened or acted on')
})

test('dropping below the goal and back does not nudge inside the quiet period', () => {
	const cycle = ignoredCycle(readCycle(undefined), T0, 30)
	assert.deepEqual(step(cycle, { now: cycle.quietFrom + 60 * MIN, overThreshold: false, tabCount: 15 }), { action: 'none' })
	assert.deepEqual(step(cycle, { now: cycle.quietFrom + 61 * MIN, tabCount: 21 }), { action: 'none' })
})

test('ending without a cycle keeps the doubling where it was', () => {
	const cycle = endCycle({ ...readCycle(undefined), ignoredStreak: 2 }, T0, { counted: false })
	assert.equal(cycle.ignoredStreak, 2)
	assert.equal(quietMinutes(cycle), 210)
})

test('opening the panel starts a fresh AI run only when the list is missing or old, unless a nudge just showed it', () => {
	const plan = (ageMs, extra = {}) => ({ id: 'plan-1', createdAt: T0 - ageMs, expired: false, tabs: [{}], ...extra })
	const cycle = readCycle(undefined)
	assert.equal(needsIntentRun({ aiOn: false, plan: null, now: T0, cycle }), false)
	assert.equal(needsIntentRun({ aiOn: true, plan: null, now: T0, cycle }), true)
	assert.equal(needsIntentRun({ aiOn: true, plan: plan(10 * MIN), now: T0, cycle }), false)
	assert.equal(needsIntentRun({ aiOn: true, plan: plan(LIST_FRESH_MS + 1), now: T0, cycle }), true)
	assert.equal(needsIntentRun({ aiOn: true, plan: plan(10 * MIN, { expired: true }), now: T0, cycle }), true)
	const remindedRecently = { ...cycle, shownAt: T0 - 5 * MIN, shownPlanId: 'plan-1' }
	assert.equal(needsIntentRun({ aiOn: true, plan: plan(35 * MIN), now: T0, cycle: remindedRecently }), false)
	const remindedLongAgo = { ...cycle, shownAt: T0 - SHOWN_LIST_FRESH_MS - 1, shownPlanId: 'plan-1' }
	assert.equal(needsIntentRun({ aiOn: true, plan: plan(35 * MIN), now: T0, cycle: remindedLongAgo }), true)
	const otherPlan = { ...cycle, shownAt: T0 - 5 * MIN, shownPlanId: 'plan-0' }
	assert.equal(needsIntentRun({ aiOn: true, plan: plan(35 * MIN), now: T0, cycle: otherPlan }), true)
})
