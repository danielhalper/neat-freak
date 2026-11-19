import test from 'node:test'
import assert from 'node:assert/strict'
import {
	REMINDER_DELAY_MS, QUIET_STEPS_MS, RUN_STALE_MS, LIST_FRESH_MS, SHOWN_LIST_FRESH_MS,
	readCycle, nextNudgeStep, startRun, finishRun, markShown, markClosedByUser, markEngaged,
	endCycle, backoffLevel, needsIntentRun,
} from '../src/nudge-cycle.js'

const T0 = 1_800_000_000_000
const MIN = 60_000
const ready = { nudgesOn: true, overThreshold: true, surfaceReady: true, panelBusy: false, listCount: 5 }
const step = (cycle, ctx = {}) => nextNudgeStep(cycle, { now: T0, ...ready, ...ctx })

test('a fresh cycle runs once when over the threshold on a usable page, and not otherwise', () => {
	const cycle = readCycle(undefined)
	assert.deepEqual(step(cycle), { action: 'run' })
	assert.deepEqual(step(cycle, { overThreshold: false }), { action: 'none' })
	assert.deepEqual(step(cycle, { surfaceReady: false }), { action: 'none' })
	assert.deepEqual(step(cycle, { nudgesOn: false }), { action: 'none' })
	assert.deepEqual(step(cycle, { panelBusy: true }), { action: 'none' }, 'an open panel runs its own check')
})

test('stored cycle state is read defensively', () => {
	assert.deepEqual(readCycle({ phase: 'bogus', quietUntil: 'x', ignoredStreak: -4 }), readCycle(undefined))
	assert.equal(readCycle({ phase: 'quiet', quietUntil: T0, ignoredStreak: 2 }).ignoredStreak, 2)
})

test('a run with a list waits to show its first nudge; a run with nothing ends quietly without backoff', () => {
	const running = startRun(readCycle(undefined), T0)
	assert.deepEqual(step(running), { action: 'none' }, 'never a second run while one is in flight')
	const pending = finishRun(running, { now: T0, listCount: 5 })
	assert.deepEqual(step(pending), { action: 'show', kind: 'first' })
	assert.deepEqual(step(pending, { surfaceReady: false }), { action: 'none' }, 'the list waits for a usable page, no re-run')
	const empty = finishRun(running, { now: T0, listCount: 0 })
	assert.equal(empty.phase, 'quiet')
	assert.equal(empty.quietUntil, T0 + QUIET_STEPS_MS[0])
	assert.equal(empty.ignoredStreak, 0)
})

test('a pending list that empties or drops below the threshold ends the cycle without backoff', () => {
	const pending = finishRun(startRun(readCycle(undefined), T0), { now: T0, listCount: 5 })
	assert.deepEqual(step(pending, { listCount: 0 }), { action: 'end', ignored: false })
	assert.deepEqual(step(pending, { overThreshold: false }), { action: 'end', ignored: false })
})

test('a run lost to a worker restart is abandoned after a while', () => {
	const running = startRun(readCycle(undefined), T0)
	assert.deepEqual(step(running, { now: T0 + RUN_STALE_MS + 1 }), { action: 'end', ignored: false })
})

test('one reminder 30 minutes after the first nudge, with the same pruned list', () => {
	const nudged = markShown(finishRun(startRun(readCycle(undefined), T0), { now: T0, listCount: 5 }), { now: T0, kind: 'first', planId: 'plan-1' })
	assert.deepEqual(step(nudged, { now: T0 + REMINDER_DELAY_MS - 1 }), { action: 'none' })
	assert.deepEqual(step(nudged, { now: T0 + REMINDER_DELAY_MS }), { action: 'show', kind: 'reminder' })
	assert.deepEqual(step(nudged, { now: T0 + REMINDER_DELAY_MS, surfaceReady: false }), { action: 'none' })
	assert.deepEqual(step(nudged, { now: T0 + REMINDER_DELAY_MS, panelBusy: true }), { action: 'none' })
})

test('no reminder after the user closed the card (ignored) or when the pruned list is empty (not ignored)', () => {
	const nudged = markShown(finishRun(startRun(readCycle(undefined), T0), { now: T0, listCount: 5 }), { now: T0, kind: 'first', planId: 'plan-1' })
	const slot = T0 + REMINDER_DELAY_MS
	assert.deepEqual(step(markClosedByUser(nudged), { now: slot }), { action: 'end', ignored: true })
	assert.deepEqual(step(nudged, { now: slot, listCount: 0 }), { action: 'end', ignored: false })
	assert.deepEqual(step(nudged, { now: slot, overThreshold: false }), { action: 'end', ignored: false })
	assert.equal(markClosedByUser(readCycle(undefined)).phase, 'idle', 'closing only counts on a shown nudge')
})

test('each fully ignored cycle doubles the quiet period: 90 min, 3 h, 6 h, then 24 h', () => {
	let cycle = readCycle(undefined)
	let now = T0
	const quiet = []
	for (let i = 0; i < 5; i++) {
		cycle = finishRun(startRun(cycle, now), { now, listCount: 5 })
		cycle = markShown(cycle, { now, kind: 'first', planId: `plan-${i}` })
		now += REMINDER_DELAY_MS
		cycle = markShown(cycle, { now, kind: 'reminder', planId: `plan-${i}` })
		quiet.push(cycle.quietUntil - now)
		assert.deepEqual(step(cycle, { now: cycle.quietUntil - 1 }), { action: 'none' }, 'quiet even when back over the threshold')
		now = cycle.quietUntil
		assert.deepEqual(step(cycle, { now }), { action: 'run' })
	}
	assert.deepEqual(quiet, [QUIET_STEPS_MS[0], QUIET_STEPS_MS[1], QUIET_STEPS_MS[2], QUIET_STEPS_MS[3], QUIET_STEPS_MS[3]])
	assert.deepEqual(QUIET_STEPS_MS.map(ms => ms / MIN), [90, 180, 360, 1440])
	assert.equal(backoffLevel(cycle), 3)
})

test('any engagement ends the cycle and resets the quiet period to 90 minutes', () => {
	let cycle = { ...readCycle(undefined), phase: 'quiet', quietUntil: T0 + 24 * 60 * MIN, ignoredStreak: 4 }
	cycle = markEngaged(cycle, T0)
	assert.equal(cycle.phase, 'quiet')
	assert.equal(cycle.quietUntil, T0 + QUIET_STEPS_MS[0])
	assert.equal(backoffLevel(cycle), 0)
	const nudged = markShown(finishRun(startRun(readCycle(undefined), T0), { now: T0, listCount: 5 }), { now: T0, kind: 'first', planId: 'plan-1' })
	const engaged = markEngaged(nudged, T0 + 5 * MIN)
	assert.deepEqual(step(engaged, { now: T0 + REMINDER_DELAY_MS }), { action: 'none' }, 'no reminder after the list was opened or acted on')
})

test('ending a cycle that was not ignored keeps the backoff level', () => {
	const cycle = endCycle({ ...readCycle(undefined), ignoredStreak: 2 }, T0, { ignored: false })
	assert.equal(cycle.quietUntil, T0 + QUIET_STEPS_MS[0])
	assert.equal(backoffLevel(cycle), 2)
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
