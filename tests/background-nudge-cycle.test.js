import test from 'node:test'
import assert from 'node:assert/strict'
import { createChromeHarness } from './helpers/chrome-harness.js'
import { REMINDER_DELAY_MS, OVER_GOAL_BANDS } from '../src/nudge-cycle.js'

const MIN = 60_000

async function boot(t, h = null, settings = {}) {
	const timers = []
	const originalTimeout = globalThis.setTimeout
	globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
	h ||= createChromeHarness({ tabs: Array.from({ length: 8 }, (_, i) => ({
		id: i + 1, windowId: 1, active: i === 0, title: `Research ${i}`,
		url: `https://example.test/article/${i}`, lastAccessed: Date.now() - 120 * 60_000,
	})) })
	h.data.local.tabAtlasSettings.prepareSuggestions = true
	Object.assign(h.data.local.tabAtlasSettings, settings)
	globalThis.chrome = h.chrome
	t.after(() => { globalThis.setTimeout = originalTimeout; delete globalThis.chrome })
	await import(`../src/background.js?cycle=${Math.random()}`)
	const check = () => timers.findLast(timer => timer.ms === 3000).fn()
	return {
		h, check,
		get cycle() { return h.data.local.neatFreakNudgeCycle },
		get state() { return h.data.session.neatFreakPanelState },
		get plan() { return h.data.session.neatFreakRecommendation?.plan },
		rewind(ms) { for (const key of ['nudgedAt', 'quietFrom', 'shownAt', 'runStartedAt']) if (this.cycle[key]) this.cycle[key] -= ms },
	}
}

test('one run, a first nudge, one reminder 30 minutes later with the same list, then the starting quiet period', async t => {
	const f = await boot(t)
	await f.check()
	assert.equal(f.state.mode, 'clutter')
	assert.equal(f.cycle.phase, 'nudged')
	const planId = f.plan.id
	const probes = f.h.probes.length
	await f.h.send({ type: 'PANEL_DISMISS', auto: true })
	await f.check()
	assert.equal(f.state.mode, 'hidden', 'no second nudge inside the reminder window')
	assert.equal(f.h.probes.length, probes, 'no scheduled re-run')
	f.rewind(REMINDER_DELAY_MS)
	await f.check()
	assert.equal(f.state.mode, 'clutter')
	assert.equal(f.state.planId, planId, 'the reminder shows the same list')
	assert.equal(f.h.probes.length, probes)
	assert.equal(f.cycle.phase, 'quiet')
	assert.equal(f.cycle.ignoredStreak, 1)
	assert.equal(f.cycle.quietStep, 0)
	assert.ok(Math.abs(f.cycle.quietFrom - Date.now()) < 5_000, 'quiet starts at the reminder slot')
	await f.h.send({ type: 'PANEL_DISMISS', auto: true })
	f.h.tabs.splice(2)
	await f.check()
	f.h.tabs.push(...Array.from({ length: 6 }, (_, i) => ({ id: 50 + i, windowId: 1, title: `New ${i}`, url: `https://example.test/new/${i}`, lastAccessed: Date.now() - 120 * MIN })))
	await f.check()
	assert.equal(f.state.mode, 'hidden', 'dropping below the threshold and back does not end the quiet period')
	assert.equal(f.h.probes.length, probes)
})

test('closing the card yourself skips the reminder and counts as ignored', async t => {
	const f = await boot(t)
	await f.check()
	await f.h.send({ type: 'PANEL_DISMISS' })
	assert.equal(f.cycle.closedByUser, true)
	f.rewind(REMINDER_DELAY_MS)
	await f.check()
	assert.equal(f.state.mode, 'hidden')
	assert.equal(f.cycle.phase, 'quiet')
	assert.equal(f.cycle.ignoredStreak, 1)
})

test('opening the list is engagement: no reminder, the doubling resets to the starting period', async t => {
	const f = await boot(t)
	await f.check()
	f.cycle.ignoredStreak = 3
	await f.h.send({ type: 'REVIEW_RECOMMENDATION', planId: f.plan.id })
	assert.equal(f.cycle.phase, 'quiet')
	assert.equal(f.cycle.ignoredStreak, 0)
	assert.equal(f.cycle.quietStep, 0)
	assert.ok(Math.abs(f.cycle.quietFrom - Date.now()) < 5_000)
})

test('the cycle survives a worker reload: no nudge or run straight away', async t => {
	const first = await boot(t)
	await first.check()
	first.rewind(REMINDER_DELAY_MS)
	await first.check()
	await first.h.send({ type: 'PANEL_DISMISS', auto: true })
	const probes = first.h.probes.length
	delete first.h.data.session.neatFreakRecommendation
	const reloaded = await boot(t, first.h)
	await reloaded.check()
	assert.equal(reloaded.state.mode, 'hidden')
	assert.equal(reloaded.h.probes.length, probes)
	reloaded.rewind(OVER_GOAL_BANDS[0].quietMs)
	await reloaded.check()
	assert.equal(reloaded.state.mode, 'clutter', 'the next cycle starts once the quiet period is over')
	assert.ok(reloaded.h.probes.length > probes)
})

test('a list that could not be shown waits for a usable page instead of re-running', async t => {
	const f = await boot(t)
	f.h.focused = false
	await f.check()
	assert.equal(f.cycle, undefined, 'no run without a focused page')
	f.h.focused = true
	const original = f.h.chrome.windows.getLastFocused
	let calls = 0
	// Focus is lost while the run is in flight (the second focus check).
	f.h.chrome.windows.getLastFocused = async () => (++calls === 2 ? { id: 1, focused: false } : original())
	await f.check()
	assert.equal(f.cycle.phase, 'pending')
	assert.notEqual(f.state?.mode, 'clutter')
	const probes = f.h.probes.length
	f.h.chrome.windows.getLastFocused = original
	await f.check()
	assert.equal(f.state.mode, 'clutter')
	assert.equal(f.cycle.phase, 'nudged')
	assert.equal(f.h.probes.length, probes)
})

test('a suggestion run waits about 1 second per tab for page signals; the check before closing still waits 4', async t => {
	const f = await boot(t)
	const timers = []
	const capture = globalThis.setTimeout
	globalThis.setTimeout = (fn, ms) => { timers.push(ms); return capture(fn, ms) }
	await f.check()
	assert.ok(timers.filter(ms => ms === 1000).length >= 7, 'one 1-second wait per inspected tab')
	assert.equal(timers.filter(ms => ms === 4000).length, 0)
	await f.h.send({ type: 'REVIEW_RECOMMENDATION', planId: f.plan.id })
	timers.length = 0
	await f.h.send({ type: 'EXECUTE_RECOMMENDATION', planId: f.plan.id })
	assert.ok(timers.filter(ms => ms === 4000).length >= 7, 'the pre-close check keeps 4 seconds')
})

test('diagnostics record the band, doubling step and tab count; a repeat cycle shows one nudge and no reminder', async t => {
	const f = await boot(t)
	f.h.data.local.neatFreakNudgeCycle = { phase: 'quiet', quietFrom: 0, ignoredStreak: 2, quietStep: 1 }
	await f.check()
	assert.equal(f.state.mode, 'clutter')
	assert.equal(f.cycle.phase, 'quiet', 'a repeat cycle ends when its nudge shows')
	assert.ok(Math.abs(f.cycle.quietFrom - Date.now()) < 5_000)
	assert.equal(f.cycle.quietStep, 2)
	await f.h.send({ type: 'PANEL_DISMISS', auto: true })
	f.rewind(REMINDER_DELAY_MS)
	await f.check()
	assert.equal(f.state.mode, 'hidden', 'no reminder')
	const shown = f.h.data.local.neatFreakDiagnostics.filter(entry => entry.event === 'nudge_shown')
	assert.deepEqual(shown.map(entry => [entry.nudgeKind, entry.quietBand, entry.doublingStep, entry.tabCount, entry.cycleStart]),
		[['first', 'up-to-100', 1, 8, 'time']])
})

test('growth of half the goal since the last nudge resets the doubling to the starting period for the new level', async t => {
	const f = await boot(t)
	const now = Date.now()
	// Goal 5, 8 tabs: the up-to-100% band, doubled once to 6 hours.
	f.h.data.local.neatFreakNudgeCycle = { phase: 'quiet', ignoredStreak: 2, quietStep: 1, quietFrom: now - 181 * MIN, shownAt: now - 211 * MIN, shownTabCount: 8 }
	await f.check()
	assert.notEqual(f.state?.mode, 'clutter', 'without growth the doubled wait holds')
	// Half the goal is 2.5 tabs; 11 tabs is 120% over (150-minute band).
	f.h.tabs.push(...Array.from({ length: 3 }, (_, i) => ({ id: 60 + i, windowId: 1, title: `New ${i}`, url: `https://example.test/new/${i}`, lastAccessed: Date.now() - 120 * MIN })))
	await f.check()
	assert.equal(f.state.mode, 'clutter')
	const shown = f.h.data.local.neatFreakDiagnostics.filter(entry => entry.event === 'nudge_shown').at(-1)
	assert.deepEqual([shown.cycleStart, shown.quietBand, shown.doublingStep, shown.tabCount], ['growth', '100-250', 0, 11])
	assert.equal(f.cycle.ignoredStreak, 0, 'growth resets the doubling')
	assert.equal(f.cycle.shownTabCount, 11)
})

test('with AI on, a local list left by a failed panel-open run is never nudged', async t => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => { throw new Error('Simulated offline AI') }
	t.after(() => { globalThis.fetch = originalFetch })
	const f = await boot(t, null, { llmEnabled: true })
	const opened = await f.h.send({ type: 'PREPARE_RECOMMENDATION' })
	assert.equal(opened.ok, true, opened.error)
	assert.equal(opened.recommendation.local, true, 'the user-initiated run keeps its local fallback for Review')
	await f.check()
	assert.notEqual(f.state?.mode, 'clutter', 'the automatic cycle does not nudge a local list for an AI user')
	assert.equal(f.cycle.phase, 'quiet')
	assert.equal(f.cycle.ignoredStreak, 0, 'nothing to show: the cycle ends uncounted')
	assert.equal(f.plan.mode, 'heuristic', 'the local list stays available in the panel')
	assert.equal(f.h.data.local.neatFreakDiagnostics.filter(entry => entry.event === 'nudge_shown').length, 0)
})
