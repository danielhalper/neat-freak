import test from 'node:test'
import assert from 'node:assert/strict'
import { createChromeHarness } from './helpers/chrome-harness.js'

function fixture() {
	return Array.from({ length: 6 }, (_, i) => ({ id: i + 1, windowId: 1, active: i === 0, index: i,
		url: `https://example.com/article/${i + 1}`, title: `Research article ${i + 1}`, lastAccessed: Date.now() - 120 * 60_000 }))
}

test('background failure and interruption scenarios', async t => {
	const originalTimeout = globalThis.setTimeout
	globalThis.setTimeout = () => 0
	const h = createChromeHarness({ tabs: fixture() })
	globalThis.chrome = h.chrome
	await import(`../src/background.js?failures=${Date.now()}`)
	t.after(() => { globalThis.setTimeout = originalTimeout; delete globalThis.chrome })

	await t.test('storage failure aborts before the first removal', async () => {
		const response = await h.send({ type: 'REFRESH_RECOMMENDATION' })
		await h.send({ type: 'REVIEW_RECOMMENDATION', planId: response.recommendation.planId })
		h.failStorage = true
		const result = await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: response.recommendation.planId })
		assert.equal(result.ok, false)
		assert.match(result.error, /storage failure/i)
		assert.equal(h.removed.length, 0)
		h.failStorage = false
	})

	await t.test('partial close reports real success and retry preserves previously saved tabs', async () => {
		h.data.session.neatFreakRecommendation.lastExplicitAttemptAt = 0
		const response = await h.send({ type: 'REFRESH_RECOMMENDATION' })
		await h.send({ type: 'REVIEW_RECOMMENDATION', planId: response.recommendation.planId })
		h.failures.add(3)
		const result = await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: response.recommendation.planId })
		assert.equal(result.ok, true, result.error)
		assert.equal(result.closedCount, 4)
		assert.equal(result.failedCount, 1)
		const sessionId = result.session.id
		assert.equal(h.data.local.tabAtlasSessions[0].tabs.length, 5)
		assert.deepEqual(h.data.local.tabAtlasSessions[0].pendingTabIds, [3])
		h.failures.clear()
		assert.equal((await h.send({ type: 'CLOSE_SAVED_TABS', sessionId })).ok, true)
		assert.equal(h.data.local.tabAtlasSessions[0].tabs.length, 5)
		assert.deepEqual(h.data.local.tabAtlasSessions[0].pendingTabIds, [])
	})

	await t.test('a repeated confirm on a completed session cannot delete its archived tabs', async () => {
		const session = h.data.local.tabAtlasSessions[0]
		const ids = session.tabs.map(tab => tab.id)
		const closedBefore = h.removed.length
		assert.equal((await h.send({ type: 'PANEL_CONFIRM_REVIEW', sessionId: session.id })).ok, true)
		assert.deepEqual(h.data.local.tabAtlasSessions[0].tabs.map(tab => tab.id), ids)
		assert.equal(h.removed.length, closedBefore)
	})

	await t.test('interrupted journal restoration skips tabs that are still open', async () => {
		const session = h.data.local.tabAtlasSessions[0]
		session.closeStatus = 'closing'
		session.pendingTabIds = session.tabs.map(tab => tab.originalTabId)
		h.tabs = fixture().filter(tab => tab.id <= 3)
		const before = h.tabs.length
		await h.send({ type: 'RESTORE_SESSION', sessionId: session.id })
		assert.equal(h.tabs.length - before, 3)
		assert.equal(h.tabs.filter(tab => tab.url === fixture()[1].url).length, 1)
	})

	await t.test('concurrent close requests execute once and reject saved-session edits until complete', async () => {
		h.tabs = fixture()
		h.data.session.neatFreakRecommendation.lastExplicitAttemptAt = 0
		const response = await h.send({ type: 'REFRESH_RECOMMENDATION' })
		await h.send({ type: 'REVIEW_RECOMMENDATION', planId: response.recommendation.planId })
		let release
		let probesStarted = 0
		const gate = new Promise(resolve => { release = resolve })
		const originalScript = h.chrome.scripting.executeScript
		h.chrome.scripting.executeScript = async (options, callback) => {
			if (options.func) { probesStarted++; await gate }
			return originalScript(options, callback)
		}
		const first = h.send({ type: 'EXECUTE_RECOMMENDATION', planId: response.recommendation.planId })
		while (!probesStarted) await new Promise(resolve => setImmediate(resolve))
		const second = await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: response.recommendation.planId })
		assert.equal(second.ok, false)
		assert.match(second.error, /already in progress/)
		const deletion = await h.send({ type: 'DELETE_SESSION', sessionId: h.data.local.tabAtlasSessions[0].id })
		assert.equal(deletion.ok, false)
		h.chrome.scripting.executeScript = originalScript
		release()
		const result = await first
		assert.equal(result.ok, true, result.error)
		assert.equal(result.closedCount, 5)
	})
})
