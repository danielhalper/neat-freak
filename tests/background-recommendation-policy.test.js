import test from 'node:test'
import assert from 'node:assert/strict'
import { createChromeHarness } from './helpers/chrome-harness.js'
import { AUTOMATIC_AI_LIMIT } from '../src/recommendation-budget.js'

test('background AI cap falls back visibly; explicit refresh can still use AI and close the prepared offer', async t => {
	const timers = []
	const originalTimeout = globalThis.setTimeout
	const originalFetch = globalThis.fetch
	globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
	const h = createChromeHarness({ tabs: Array.from({ length: 6 }, (_, i) => ({
		id: i + 1, windowId: 1, index: i, active: i === 0,
		url: `https://example.test/article/${i}`, title: `Research ${i}`,
		lastAccessed: Date.now() - 120 * 60_000,
	})) })
	Object.assign(h.data.local.tabAtlasSettings, { llmEnabled: true, prepareSuggestions: true })
	h.data.local.neatFreakAutomaticAiBudget = { day: Math.floor(Date.now() / 86_400_000), used: AUTOMATIC_AI_LIMIT }
	globalThis.chrome = h.chrome
	let requests = 0
	globalThis.fetch = async () => { requests++; throw new Error('Automatic network call must be blocked') }
	t.after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; delete globalThis.chrome })
	await import(`../src/background.js?policy=${Date.now()}`)
	await timers.find(timer => timer.ms === 3000).fn()
	assert.equal(requests, 0)
	const local = h.data.session.neatFreakPanelState
	assert.equal(local.local, true)
	assert.equal(local.localReason, 'background-limit')
	assert.equal(local.reviewRequired, true)
	const denied = await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: local.planId })
	assert.equal(denied.ok, false)
	assert.match(denied.error, /Review/)
	assert.equal(h.removed.length, 0)

	globalThis.fetch = async (url, options) => {
		requests++
		if (url === 'https://model.example.test/chat/completions') {
			const payload = JSON.parse(JSON.parse(options.body).messages[1].content)
			const id = payload.tabs[0].id
			return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
				groups: [{ name: 'Research', tabIds: [id] }],
				tabActions: payload.tabs.map(tab => ({ tabId: tab.id, action: tab.id === id ? 'save' : 'keep' })),
			}) } }] }) }
		}
		assert.equal(options.body, '{}', 'Token service never receives tab content')
		return { ok: true, json: async () => ({ key: 'synthetic-key', baseUrl: 'https://model.example.test/chat/completions', expiresAt: Date.now() + 60_000 }) }
	}
	const refreshed = await h.send({ type: 'REFRESH_RECOMMENDATION' })
	assert.equal(refreshed.ok, true, refreshed.error)
	assert.equal(refreshed.recommendation.local, false)
	assert.equal(refreshed.recommendation.reviewRequired, false)
	assert.equal(requests, 2)
	assert.equal(h.data.local.neatFreakAutomaticAiBudget.used, AUTOMATIC_AI_LIMIT)
	const result = await h.send({ type: 'EXECUTE_RECOMMENDATION', planId: refreshed.recommendation.planId })
	assert.equal(result.ok, true, result.error)
	assert.equal(result.closedCount, 1)
	assert.equal(h.removed.length, 1)

	h.data.session.neatFreakRecommendation.lastExplicitAttemptAt = 0
	h.tabs.find(tab => !tab.active).signalsUnavailable = true
	const unknownId = h.tabs.find(tab => tab.signalsUnavailable).id
	globalThis.fetch = async () => { throw new Error('Simulated offline model') }
	const offline = await h.send({ type: 'REFRESH_RECOMMENDATION' })
	assert.equal(offline.ok, true, offline.error)
	assert.equal(offline.recommendation.local, true)
	assert.equal(offline.recommendation.localReason, 'ai-unavailable')
	assert.equal(offline.recommendation.reviewRequired, true)
	assert.equal(h.data.session.neatFreakRecommendation.plan.tabs.some(tab => tab.originalTabId === unknownId), false, 'A page reporting failed form inspection is kept')
})
