import test from 'node:test'
import assert from 'node:assert/strict'
import { createChromeHarness } from './helpers/chrome-harness.js'

function fixture() {
	return Array.from({ length: 8 }, (_, i) => ({
		id: i + 1, windowId: 1, index: i, active: i === 0, title: `Project research ${i + 1}`,
		url: `https://example.com/article/${i + 1}`, lastAccessed: Date.now() - 120 * 60_000,
	}))
}

test('background routes: cached nudge -> review -> safety-filtered close -> restore, with durable journal', async t => {
	const timers = []
	const originalTimeout = globalThis.setTimeout
	globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
	const h = createChromeHarness({ tabs: fixture() })
	globalThis.chrome = h.chrome
	await import(`../src/background.js?integration=${Date.now()}`)
	t.after(() => { globalThis.setTimeout = originalTimeout; delete globalThis.chrome })

	await t.test('background page reads are off until explicitly enabled', async () => {
		await timers.find(timer => timer.ms === 3000).fn()
		assert.equal(h.data.session.neatFreakRecommendation, undefined)
		assert.equal(h.probes.length, 0)
		assert.equal(h.data.session.neatFreakPanelState.needsPreparation, true)
		await h.send({ type: 'PANEL_DISMISS' })
		// Reset the nudge cycle (count-only nudge shown, reminder pending) to
		// exercise the newly enabled prepare path.
		delete h.data.local.neatFreakNudgeCycle
		h.data.local.tabAtlasSettings.prepareSuggestions = true
	})

	await t.test('proactive watcher prepares a plan only in a focused window and shows the selected count', async () => {
		h.focused = false
		await timers.find(timer => timer.ms === 3000).fn()
		assert.equal(h.data.session.neatFreakRecommendation, undefined)
		h.focused = true
		await timers.find(timer => timer.ms === 3000).fn()
		const nudge = h.data.session.neatFreakPanelState
		assert.equal(nudge.mode, 'clutter')
		assert.equal(nudge.saveCount, 7)
		assert.equal(h.removed.length, 0)
		assert.ok(nudge.planId)
	})

	await t.test('dismiss preserves plan; toolbar gets exact saved count without recomputing', async () => {
		await h.send({ type: 'PANEL_DISMISS' })
		const reads = h.probes.length
		const result = await h.send({ type: 'GET_POPUP_STATE' })
		assert.equal(result.recommendation.saveCount, 7)
		assert.equal(h.probes.length, reads)
	})

	await t.test('review is immediate and Keep choices survive panel recovery', async () => {
		const planId = h.data.session.neatFreakRecommendation.plan.id
		assert.equal((await h.send({ type: 'REVIEW_RECOMMENDATION', planId })).ok, true)
		const state = h.data.session.neatFreakPanelState
		const keep = state.groups[0].tabs[0].sessionTabId
		await h.send({ type: 'SET_RECOMMENDATION_KEEP', planId, keepOpenSessionTabIds: [keep] })
		assert.deepEqual(h.data.session.neatFreakPanelState.keepOpenSessionTabIds, [keep])
		assert.equal(h.data.local.tabAtlasSessions.length, 0)
	})

	await t.test('Keep and Cancel preserve the exact exclusion for the next suggestion', async () => {
		const state = h.data.session.neatFreakPanelState
		await h.send({ type: 'PANEL_DISMISS' })
		const result = await h.send({ type: 'GET_RECOMMENDATION' })
		assert.equal(result.recommendation.saveCount, 6)
		// Reopen the remaining plan; its removed member must not return.
		await h.send({ type: 'REVIEW_RECOMMENDATION', planId: state.planId })
		assert.equal(h.data.session.neatFreakPanelState.groups.flatMap(group => group.tabs).length, 6)
	})

	await t.test('changed, audible, pinned and edited tabs survive; newly opened tabs are never added on execute', async () => {
		const state = h.data.session.neatFreakPanelState
		h.tabs.find(tab => tab.id === 3).url += '?different-document'
		h.tabs.find(tab => tab.id === 4).audible = true
		h.tabs.find(tab => tab.id === 5).pinned = true
		h.tabs.find(tab => tab.id === 6).hasUnsavedInput = true
		h.tabs.push({ ...fixture()[1], id: 99 })
		h.onRemove = id => {
			const session = h.data.local.tabAtlasSessions[0]
			assert.ok(session.tabs.some(tab => tab.originalTabId === id))
			assert.ok(session.pendingTabIds.includes(id))
			assert.equal(session.closeStatus, 'closing')
		}
		const result = await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: state.planId, keepOpenSessionTabIds: state.keepOpenSessionTabIds })
		assert.equal(result.ok, true, result.error)
		assert.deepEqual(h.removed, [7, 8])
		assert.equal(h.data.session.neatFreakPanelState.tabCount, 2)
		assert.equal(h.data.local.tabAtlasSessions[0].tabs.length, 2)
		assert.equal(h.data.local.tabAtlasSessions[0].pendingTabIds.length, 0)
		assert.equal((await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: state.planId })).ok, false)
	})

	await t.test('restore reopens exactly the successfully saved URLs', async () => {
		const session = h.data.local.tabAtlasSessions[0]
		const response = await h.send({ type: 'RESTORE_SESSION', sessionId: session.id })
		assert.equal(response.ok, true, response.error)
		for (const saved of session.tabs) assert.ok(h.tabs.some(tab => tab.url === saved.url))
	})

	await t.test('browser restart makes pending IDs non-executable even when IDs and URLs match', async () => {
		const session = h.data.local.tabAtlasSessions[0]
		session.pendingTabIds = [h.tabs[0].id]
		session.tabs = [{ ...h.tabs[0], id: 'pending', originalTabId: h.tabs[0].id }]
		delete h.data.session.neatFreakBrowserSessionId
		const count = h.removed.length
		const response = await h.send({ type: 'CLOSE_SAVED_TABS', sessionId: session.id })
		assert.equal(response.ok, false)
		assert.match(response.error, /earlier browser session/)
		assert.equal(h.removed.length, count)
	})
})
