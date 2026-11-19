import test from 'node:test'
import assert from 'node:assert/strict'
import {
	REMINDER_DELAY_MS, REMIND_EVERY_CYCLE, OVER_GOAL_BANDS, QUIET_CAP_MS, GROWTH_RESET_SHARE,
	RUN_STALE_MS, LIST_FRESH_MS, SHOWN_LIST_FRESH_MS,
	readCycle, bandFor, quietDue, nextNudgeStep, startRun, finishRun, markShown, markClosedByUser,
	markEngaged, endCycle, needsIntentRun,
} from '../src/nudge-cycle.js'

const T0 = 1_800_000_000_000
const MIN = 60_000
const GOAL = 20
const ready = { nudgesOn: true, overThreshold: true, surfaceReady: true, panelBusy: false, listCount: 5, tabCount: 30, goal: GOAL }
const step = (cycle, ctx = {}, options) => nextNudgeStep(cycle, { now: T0, ...ready, ...ctx }, options)

// A cycle at `now` with `tabCount` tabs: run, first nudge, reminder at the slot.
function ignoredCycle(cycle, now, tabCount = 30) {
	const start = step(cycle, { now, tabCount })
	assert.equal(start.action, 'run')
	cycle = finishRun(startRun(cycle, now, start), { now, listCount: 5 })
	cycle = markShown(cycle, { now, kind: 'first', planId: 'plan-a', tabCount })
	return markShown(cycle, { now: now + REMINDER_DELAY_MS, kind: 'reminder', planId: 'plan-a', tabCount })
}
const quietMinutes = (cycle, tabCount = 30) => (quietDue(cycle, { tabCount, goal: GOAL }).due - cycle.quietFrom) / MIN

test('pacing numbers are named constants in one place', () => {
	assert.deepEqual(OVER_GOAL_BANDS.map(band => [band.name, band.fromOver, band.quietMs / MIN]),
		[['up-to-100', 0, 180], ['100-250', 1, 150], ['over-250', 2.5, 90]])
	assert.equal(QUIET_CAP_MS, 24 * 60 * MIN)
	assert.equal(GROWTH_RESET_SHARE, 0.5)
	assert.equal(REMINDER_DELAY_MS, 30 * MIN)
	assert.equal(REMIND_EVERY_CYCLE, true)
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
	assert.equal(quietMinutes(empty), 180)
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

test('the reminder comes at the 30-minute slot; the cycle ends at the slot whether or not it showed', () => {
	const nudged = markShown(finishRun(startRun(readCycle(undefined), T0, step(readCycle(undefined))), { now: T0, listCount: 5 }), { now: T0, kind: 'first', planId: 'plan-1', tabCount: 30 })
	const slot = T0 + REMINDER_DELAY_MS
	assert.deepEqual(step(nudged, { now: slot - 1 }), { action: 'none' })
	assert.deepEqual(step(nudged, { now: slot }), { action: 'show', kind: 'reminder' })
	assert.deepEqual(step(nudged, { now: slot + 5 * MIN, surfaceReady: false }), { action: 'end', counted: true, at: slot })
	assert.deepEqual(step(nudged, { now: slot, panelBusy: true }), { action: 'end', counted: true, at: slot })
	assert.deepEqual(step(markClosedByUser(nudged), { now: slot }), { action: 'end', counted: true, at: slot }, 'closing by hand skips the reminder and is no engagement')
	assert.deepEqual(step(nudged, { now: slot, listCount: 0 }), { action: 'end', counted: true, at: slot })
	const reminded = markShown(nudged, { now: slot + 2 * MIN, kind: 'reminder', planId: 'plan-1', tabCount: 30 })
	assert.equal(reminded.phase, 'quiet')
	assert.equal(reminded.quietFrom, slot)
	assert.equal(markClosedByUser(readCycle(undefined)).phase, 'idle', 'closing only counts on a shown nudge')
})

test('with reminders limited to the first cycle after a reset, repeat cycles skip it', () => {
	let cycle = ignoredCycle(readCycle(undefined), T0)
	const next = cycle.quietFrom + 180 * MIN
	cycle = finishRun(startRun(cycle, next, step(cycle, { now: next })), { now: next, listCount: 5 })
	cycle = markShown(cycle, { now: next, kind: 'first', planId: 'plan-b', tabCount: 30 })
	const slot = next + REMINDER_DELAY_MS
	assert.deepEqual(step(cycle, { now: slot }), { action: 'show', kind: 'reminder' }, 'every cycle by default')
	assert.deepEqual(step(cycle, { now: slot }, { remindEveryCycle: false }), { action: 'end', counted: true, at: slot })
	const fresh = markShown(finishRun(startRun(readCycle(undefined), T0, step(readCycle(undefined))), { now: T0, listCount: 5 }), { now: T0, kind: 'first', planId: 'plan-c', tabCount: 30 })
	assert.deepEqual(step(fresh, { now: T0 + REMINDER_DELAY_MS }, { remindEveryCycle: false }), { action: 'show', kind: 'reminder' })
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
	assert.deepEqual(ladder(30), [180, 360, 720, 1440, 1440, 1440])
	assert.deepEqual(ladder(50), [150, 300, 600, 1200, 1440, 1440])
	assert.deepEqual(ladder(80), [90, 180, 360, 720, 1440, 1440])
})

test('the due time follows the current level, so moving into a higher band shortens the wait', () => {
	let cycle = ignoredCycle(readCycle(undefined), T0, 35)
	cycle = ignoredCycle(cycle, quietDue(cycle, { tabCount: 35, goal: GOAL }).due, 35)
	assert.equal(quietMinutes(cycle, 35), 360, 'second cycle without engagement at 35 tabs')
	assert.equal(quietMinutes(cycle, 44), 300, '44 tabs: the 100-250% band, still doubled (growth under half the goal)')
	assert.deepEqual(step(cycle, { now: cycle.quietFrom + 300 * MIN, tabCount: 44 }), { action: 'run', trigger: 'time', band: 1, step: 1 })
	assert.deepEqual(step(cycle, { now: cycle.quietFrom + 299 * MIN, tabCount: 44 }), { action: 'none' })
})

test('growth of half the goal since the last nudge resets the doubling to the starting period', () => {
	let cycle = ignoredCycle(readCycle(undefined), T0, 30)
	cycle = ignoredCycle(cycle, quietDue(cycle, { tabCount: 30, goal: GOAL }).due, 30)
	cycle = ignoredCycle(cycle, quietDue(cycle, { tabCount: 30, goal: GOAL }).due, 30)
	assert.equal(quietMinutes(cycle, 30), 720)
	assert.equal(quietMinutes(cycle, 39), 720, '9 new tabs is under half the goal')
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
	assert.equal(quietMinutes(cycle, 30), 180)
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
	assert.equal(quietMinutes(cycle), 180)
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
