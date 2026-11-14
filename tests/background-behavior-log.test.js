import test from 'node:test'
import assert from 'node:assert/strict'
import { createChromeHarness } from './helpers/chrome-harness.js'

function fixture() {
	return Array.from({ length: 6 }, (_, i) => ({ id: i + 1, windowId: 1, active: i === 0, index: i,
		url: `https://docs.example.com/private/${i + 1}?q=secret`, title: `Private research ${i + 1}`,
		lastAccessed: Date.now() - 120 * 60_000 }))
}

test('background wiring: off by default, then labels manual closes, saves, Keep and restores', async t => {
	const originalTimeout = globalThis.setTimeout
	globalThis.setTimeout = () => 0
	const h = createChromeHarness({ tabs: fixture() })
	globalThis.chrome = h.chrome
	await import(`../src/background.js?behavior=${Date.now()}`)
	t.after(() => { globalThis.setTimeout = originalTimeout; delete globalThis.chrome })
	const exportLog = async () => {
		const response = await h.send({ type: 'EXPORT_BEHAVIOR_LOG' })
		assert.equal(response.ok, true, response.error)
		return response.behaviorLog
	}

	await t.test('nothing is recorded until the user opts in', async () => {
		await h.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 1 })
		const report = await exportLog()
		assert.equal(report.enabled, false)
		assert.deepEqual(report.records, [])
		assert.ok(!Object.keys(h.data.local).some(key => /behavior/i.test(key)))
	})

	await t.test('opted in: tab events, a Neat Freak save with one Keep, and a restore', async () => {
		h.data.local.tabAtlasSettings.behaviorLogEnabled = true
		await h.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 1 })
		await h.chrome.tabs.onUpdated.emit(3, { discarded: true }, h.tabs[2])
		h.tabs = h.tabs.filter(tab => tab.id !== 4)
		await h.chrome.tabs.onRemoved.emit(4, { isWindowClosing: false, windowId: 1 })

		const { recommendation } = await h.send({ type: 'REFRESH_RECOMMENDATION' })
		await h.send({ type: 'REVIEW_RECOMMENDATION', planId: recommendation.planId })
		const plan = h.data.session.neatFreakRecommendation.plan
		const keep = plan.tabs.find(tab => tab.originalTabId === 5)
		const result = await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: plan.id, keepOpenSessionTabIds: [keep.id] })
		assert.equal(result.ok, true, result.error)
		assert.ok(h.removed.length > 0)

		const session = h.data.local.tabAtlasSessions[0]
		const restoredTab = session.tabs[0]
		assert.equal((await h.send({ type: 'RESTORE_TAB', sessionId: session.id, tabId: restoredTab.id })).ok, true)

		const report = await exportLog()
		// The harness reuses freed tab ids for restored tabs (Chrome never does), so look up ended vs open.
		const ended = id => report.records.find(record => record.tabId === id && record.outcome)
		const open = id => report.records.find(record => record.tabId === id && !record.outcome)
		assert.equal(ended(4).outcome, 'closed')
		for (const id of h.removed) assert.equal(ended(id).outcome, 'saved', `tab ${id}`)
		assert.ok(Number.isFinite(ended(restoredTab.originalTabId).restoredAt))
		assert.equal(open(5).keeps, 1)
		assert.equal(ended(3).discards, 1)
		assert.equal(ended(2).activations, 1)
		// The Refresh recorded every candidate with whether it was offered.
		for (const id of h.removed) assert.equal(ended(id).offers.at(-1).offered, true, `offer ${id}`)
		assert.equal(open(5).offers.at(-1).offered, true)
		assert.equal(open(5).lastKeptAt >= open(5).offers.at(-1).at, true)
		assert.ok(report.records.every(record => record.domain === 'example.com'))
		assert.doesNotMatch(JSON.stringify(report), /private|secret|research|https?:/i)
	})

	await t.test('a labelling pass is stored through the background route, domain only', async () => {
		const ids = h.tabs.filter(tab => /^https?:/.test(tab.url)).map(tab => tab.id)
		const begun = await h.send({ type: 'BEGIN_TAB_LABELS' })
		assert.equal(begun.ok, true, begun.error)
		assert.ok(Number.isFinite(begun.frozenAt))
		const response = await h.send({ type: 'SAVE_TAB_LABELS', frozenAt: begun.frozenAt, labels: ids.map((tabId, i) => ({ tabId, label: ['important', 'either', 'close'][i % 3] })) })
		assert.equal(response.ok, true, response.error)
		assert.equal(response.saved, ids.length)
		const pass = (await exportLog()).labelPasses.at(-1)
		assert.equal(pass.at, begun.frozenAt)
		assert.deepEqual(pass.tabs.map(row => row.tabId).sort(), [...ids].sort())
		assert.ok(pass.tabs.every(row => row.domain === 'example.com' && typeof row.heuristic === 'boolean'))
		assert.doesNotMatch(JSON.stringify(pass), /private|secret|research|https?:/i)
	})

	await t.test('diagnostics export stays separate, and Clear removes the log', async () => {
		const diagnostics = await h.send({ type: 'EXPORT_DIAGNOSTICS' })
		assert.doesNotMatch(JSON.stringify(diagnostics), /example\.com|behavior/i)
		assert.equal((await h.send({ type: 'CLEAR_BEHAVIOR_LOG' })).ok, true)
		h.data.local.tabAtlasSettings.behaviorLogEnabled = false
		const cleared = await exportLog()
		assert.deepEqual([cleared.records, cleared.labelPasses], [[], []])
	})
})
