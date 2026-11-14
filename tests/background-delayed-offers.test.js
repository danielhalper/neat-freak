import test from 'node:test'
import assert from 'node:assert/strict'
import { createChromeHarness } from './helpers/chrome-harness.js'
import { DIAGNOSTICS_KEY } from '../src/diagnostics.js'

async function boot(t) {
	const timers = []
	const originalTimeout = globalThis.setTimeout
	globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
	const h = createChromeHarness({ tabs: Array.from({ length: 8 }, (_, i) => ({
		id: i + 1, windowId: 1, active: i === 0, title: `Private work ${i}`,
		url: `https://private.example.com/article/${i}`, lastAccessed: Date.now() - 120 * 60_000,
	})) })
	h.data.local.tabAtlasSettings.prepareSuggestions = true
	globalThis.chrome = h.chrome
	t.after(() => { globalThis.setTimeout = originalTimeout; delete globalThis.chrome })
	await import(`../src/background.js?delayed=${Math.random()}`)
	const check = () => timers.find(timer => timer.ms === 3000).fn()
	await check()
	return { h, check, get plan() { return h.data.session.neatFreakRecommendation.plan }, get state() { return h.data.session.neatFreakPanelState } }
}

test('ignored offers quietly shrink and disappear without recomputing or adding new tabs', async t => {
	const f = await boot(t)
	assert.equal(f.state.saveCount, 7)
	const probes = f.h.probes.length
	f.h.tabs[1].lastAccessed = Date.now()
	f.h.tabs.push({ ...f.h.tabs[2], id: 99 })
	await f.check()
	assert.equal(f.state.saveCount, 6)
	assert.equal(f.state.mode, 'clutter')
	assert.ok(!f.plan.tabs.some(tab => tab.originalTabId === 99))
	for (const tab of f.h.tabs) tab.lastAccessed = Date.now()
	await f.check()
	assert.equal(f.state.mode, 'hidden')
	assert.equal(f.h.probes.length, probes, 'Normal browsing does not call page probes or the model again')
	assert.equal(f.h.removed.length, 0)
})

test('switching scope or manual-tidy options keeps the prepared offer; other settings still drop it', async t => {
	const f = await boot(t)
	const planId = f.plan.id
	await f.h.send({ type: 'SAVE_SETTINGS', settings: { defaultScope: 'allWindows' } })
	await f.h.send({ type: 'SAVE_SETTINGS', settings: { defaultIncludePinned: true, defaultKeepCurrentTab: false, defaultReviewBeforeClose: false } })
	assert.equal(f.plan?.id, planId)
	assert.equal(f.h.data.local.tabAtlasSettings.defaultScope, 'allWindows')
	await f.h.send({ type: 'SAVE_SETTINGS', settings: { defaultScope: 'smart', collectPageSummaries: false } })
	assert.equal(f.plan, null)
})

test('an expired nudge retires silently; delayed Review checks again and opens current suggestions', async t => {
	const f = await boot(t)
	const oldId = f.plan.id
	f.plan.createdAt = Date.now() - 61 * 60_000
	await f.check()
	assert.equal(f.state.mode, 'hidden')
	const response = await f.h.send({ type: 'REVIEW_RECOMMENDATION', planId: oldId })
	assert.equal(response.ok, true, response.error)
	assert.equal(f.state.mode, 'review')
	assert.notEqual(f.state.planId, oldId)
	assert.equal(f.h.removed.length, 0)
})

test('a delayed close opens fresh review, preserves Keep, and never closes a substituted set', async t => {
	const f = await boot(t)
	const oldId = f.plan.id
	const kept = f.plan.tabs[0]
	await f.h.send({ type: 'REVIEW_RECOMMENDATION', planId: oldId })
	f.plan.createdAt = Date.now() - 61 * 60_000
	f.h.tabs.push({ ...f.h.tabs[2], id: 99 })
	const response = await f.h.send({ type: 'EXECUTE_RECOMMENDATION', planId: oldId, keepOpenSessionTabIds: [kept.id] })
	assert.equal(response.ok, true, response.error)
	assert.equal(response.reviewOpened, true)
	assert.equal(f.state.mode, 'review')
	assert.notEqual(f.state.planId, oldId)
	assert.equal(f.h.removed.length, 0)
	assert.ok(!f.plan.tabs.some(tab => tab.originalTabId === kept.originalTabId))
	assert.ok(f.plan.tabs.some(tab => tab.originalTabId === 99))
	const close = await f.h.send({ type: 'EXECUTE_RECOMMENDATION', planId: f.plan.id })
	assert.equal(close.ok, true, close.error)
	assert.equal(f.h.removed.length, 7)
	assert.ok(f.h.tabs.some(tab => tab.id === kept.originalTabId))
})

test('dismissing while an expired offer refreshes cannot resurrect the review', async t => {
	const f = await boot(t)
	f.plan.createdAt = Date.now() - 61 * 60_000
	const original = f.h.chrome.scripting.executeScript
	let release, entered
	const waiting = new Promise(resolve => { release = resolve })
	const started = new Promise(resolve => { entered = resolve })
	f.h.chrome.scripting.executeScript = async (...args) => { entered(); await waiting; return original(...args) }
	const reviewing = f.h.send({ type: 'REVIEW_RECOMMENDATION', planId: f.plan.id })
	await started
	await f.h.send({ type: 'PANEL_DISMISS' })
	release()
	assert.equal((await reviewing).ok, true)
	assert.equal(f.state.mode, 'hidden')
	assert.equal(f.h.removed.length, 0)
})

test('real message routes record useful local counts and failures, export without content, and respect opt-out', async t => {
	const f = await boot(t)
	await f.h.send({ type: 'REVIEW_RECOMMENDATION', planId: f.plan.id })
	const keptId = f.plan.tabs[0].id
	await f.h.send({ type: 'SET_RECOMMENDATION_KEEP', planId: f.plan.id, keepOpenSessionTabIds: [keptId] })
	const result = await f.h.send({ type: 'EXECUTE_RECOMMENDATION', planId: f.plan.id, keepOpenSessionTabIds: [keptId] })
	await f.h.send({ type: 'RESTORE_SESSION', sessionId: result.session.id })
	await f.h.send({ type: 'RESTORE_SESSION', sessionId: 'missing' })
	const report = (await f.h.send({ type: 'EXPORT_DIAGNOSTICS' })).diagnostics
	assert.equal(report.build, 'proactive-trial-4')
	assert.ok(report.entries.some(entry => entry.event === 'nudge_shown' && entry.suggestedCount === 7))
	assert.ok(report.entries.some(entry => entry.event === 'keep_changed' && entry.keptCount === 1))
	assert.ok(report.entries.some(entry => entry.event === 'close_finished' && entry.closedCount === 6))
	assert.ok(report.entries.some(entry => entry.event === 'restore_finished' && entry.restoredCount === 6))
	assert.ok(report.entries.some(entry => entry.ok === false && entry.errorCode === 'invalid-session'))
	assert.doesNotMatch(JSON.stringify(report), /private\.example|Private work|test-install|enclaveKey|pageSummary/)
	await f.h.send({ type: 'SAVE_SETTINGS', settings: { diagnosticsEnabled: false } })
	await f.h.send({ type: 'CLEAR_DIAGNOSTICS' })
	await f.h.send({ type: 'REFRESH_RECOMMENDATION' })
	assert.deepEqual(f.h.data.local[DIAGNOSTICS_KEY], [])
})
