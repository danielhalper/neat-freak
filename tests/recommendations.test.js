import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecommendationService } from '../src/recommendations.js'
import { reconcileRecommendation, PLAN_REFRESH_MS, PLAN_MAX_AGE_MS, settingsIdentity } from '../src/tidy-plan.js'
import { closeValidatedTabs } from '../src/safe-close.js'
import { runSmartScope, buildSmartScopeRequest, parseSmartScopeResponse } from '../src/smart-scope.js'
import { buildAssociationGraph } from '../src/categorizer.js'

const NOW = 1_800_000_000_000
function live(id, extra = {}) {
	return { id, url: `https://example.com/article/${id}`, title: `Research ${id}`, lastAccessed: NOW - 120 * 60_000, ...extra }
}
function saved(tab) { return { ...tab, id: `saved-${tab.id}`, originalTabId: tab.id } }
function plan(tabs) {
	return { id: 'p1', createdAt: NOW, tabs: tabs.map(saved), snapshot: tabs, categories: [{ id: 'research', tabIds: tabs.map(tab => `saved-${tab.id}`) }] }
}
function harness() {
	let clock = NOW
	let state = {}
	let tabs = [live(1), live(2), live(3)]
	let settings = { llmEnabled: false }
	let calls = 0
	let gate = null
	const deps = {
		read: async () => structuredClone(state),
		write: async value => { state = structuredClone(value) },
		queryTabs: async () => structuredClone(tabs),
		settings: async () => settings,
		capture: async tabs => tabs.map(saved),
		select: async tabs => {
			calls++
			if (gate) await gate
			return runSmartScope(tabs, settings, { now: clock, proactive: true })
		},
		createId: () => `p${calls}`, now: () => clock,
	}
	return {
		service: createRecommendationService(deps), deps,
		get state() { return state }, get calls() { return calls }, get tabs() { return tabs },
		set tabs(value) { tabs = value }, set gate(value) { gate = value },
		set settings(value) { settings = value }, advance(ms) { clock += ms },
	}
}

test('reconcile only shrinks: query/hash navigation, activation, audio, pins, loading and revisits are removed', () => {
	const snapshot = Array.from({ length: 9 }, (_, i) => live(i + 1))
	const current = snapshot.map(tab => ({ ...tab }))
	current[0].url += '?document=new'
	current[1].url += '#new-document'
	current[2].active = true
	current[3].audible = true
	current[4].pinned = true
	current[5].lastAccessed = NOW
	current[6].status = 'loading'
	current.splice(7, 1)
	current.push(live(10))
	const result = reconcileRecommendation(plan(snapshot), current, NOW)
	assert.deepEqual(result.tabs.map(tab => tab.originalTabId), [9])
	assert.deepEqual(result.categories[0].tabIds, ['saved-9'])
	assert.equal(result.stale, true)
})

test('unvisited tabs can age into a new recommendation without silently expanding the old one', async () => {
	const h = harness()
	h.tabs = [live(1, { lastAccessed: NOW }), live(2)]
	const first = await h.service.refresh()
	assert.equal(first.tabs.some(tab => tab.originalTabId === 1), false)
	h.advance(100 * 60_000)
	assert.equal((await h.service.get()).tabs.some(tab => tab.originalTabId === 1), false)
	const next = await h.service.refresh()
	assert.equal(next.tabs.some(tab => tab.originalTabId === 1), true)
	assert.notEqual(next.id, first.id)
})

test('single flight and cooldown survive service worker replacement', async () => {
	const h = harness()
	let release
	h.gate = new Promise(resolve => { release = resolve })
	const a = h.service.refresh()
	const b = h.service.refresh({ force: true })
	release()
	assert.equal((await a).id, (await b).id)
	assert.equal(h.calls, 1)
	await createRecommendationService(h.deps).refresh()
	assert.equal(h.calls, 1)
	h.advance(PLAN_REFRESH_MS)
	await h.service.refresh()
	assert.equal(h.calls, 1, 'Unchanged inputs reuse the prepared offer')
	h.advance(PLAN_MAX_AGE_MS)
	await h.service.refresh()
	assert.equal(h.calls, 2, 'Expired offers are recomputed')
})

test('invalidation during computation prevents stale completion from replacing a later flow', async () => {
	const h = harness()
	let release
	h.gate = new Promise(resolve => { release = resolve })
	const refresh = h.service.refresh()
	await new Promise(resolve => setImmediate(resolve))
	await h.service.invalidate()
	release()
	assert.equal(await refresh, null)
	assert.equal(h.state.plan, null)
})

test('settings change during computation and review opening invalidate in-flight results', async () => {
	for (const change of ['settings', 'review']) {
		const h = harness()
		let release
		h.gate = new Promise(resolve => { release = resolve })
		const refresh = h.service.refresh()
		await new Promise(resolve => setImmediate(resolve))
		if (change === 'settings') h.settings = { llmEnabled: true }
		else h.service.cancelRefresh()
		release()
		assert.equal(await refresh, null)
	}
})

test('keep choices persist across refresh by exact tab and URL, without excluding other pages from that site', async () => {
	const h = harness()
	const first = await h.service.refresh()
	await h.service.exclude(first.id, [first.tabs[0].id])
	h.advance(PLAN_REFRESH_MS)
	const next = await h.service.refresh()
	assert.equal(next.tabs.some(tab => tab.originalTabId === 1), false)
	assert.equal(next.tabs.some(tab => tab.originalTabId === 2), true)
	h.tabs[0].url += '/different'
	h.advance(PLAN_REFRESH_MS)
	assert.equal((await h.service.refresh()).tabs.some(tab => tab.originalTabId === 1), true)
})

test('plan claim survives worker replacement; repeat click cannot execute it twice', async () => {
	const h = harness()
	const p = await h.service.refresh()
	await h.service.beginReview(p.id)
	await h.service.claim(p.id)
	const restarted = createRecommendationService(h.deps)
	assert.equal(await restarted.get(), null)
	await assert.rejects(restarted.claim(p.id), /already used/)
})

test('local suggestions require a real review before claiming, including after refresh', async () => {
	const h = harness()
	const first = await h.service.refresh()
	assert.equal(first.reviewRequired, true)
	await assert.rejects(h.service.claim(first.id), /Review these local suggestions/)
	await h.service.beginReview(first.id)
	const fresh = await h.service.refresh({ force: true })
	assert.notEqual(fresh.id, first.id)
	await assert.rejects(h.service.claim(fresh.id), /Review these local suggestions/)
	await h.service.beginReview(fresh.id)
	await h.service.claim(fresh.id)
	assert.equal(await h.service.get(), null)
})

test('AI recommendations keep the direct-close path', async () => {
	const h = harness()
	h.deps.select = async tabs => ({ saveSet: tabs, categories: [], mode: 'llm' })
	const result = await h.service.refresh()
	assert.equal(result.reviewRequired, false)
	await h.service.claim(result.id)
})

test('an AI plan keeps the model\'s own picks as Chrome tab ids, for the tab habits log; a local plan has none', async () => {
	const h = harness()
	h.tabs = [live(1), live(2), live(3)]
	h.deps.select = async tabs => ({ saveSet: tabs.slice(0, 1), categories: [], mode: 'llm', modelPicks: ['saved-2', 'saved-1'] })
	const ai = await h.service.refresh({ force: true })
	assert.deepEqual([ai.aiPicks, ai.aiCandidates], [[1, 2], [1, 2, 3]])
	h.advance(60_000)
	h.deps.select = async tabs => ({ saveSet: tabs.slice(0, 1), categories: [], mode: 'heuristic' })
	const local = await h.service.refresh({ force: true })
	assert.deepEqual([local.aiPicks, local.aiCandidates], [null, null])
})

test('old recommendations expire and incognito/pinned/active tabs never reach the model', async () => {
	const h = harness()
	h.tabs = [live(1), live(2, { incognito: true }), live(3, { pinned: true }), live(4, { active: true })]
	const p = await h.service.refresh()
	assert.deepEqual(p.tabs.map(tab => tab.originalTabId), [1])
	h.advance(PLAN_MAX_AGE_MS)
	assert.equal((await h.service.get()).expired, true)
})

test('proactive selection does not enforce either a count quota or the 40% fallback', async () => {
	const tabs = Array.from({ length: 10 }, (_, i) => saved(live(i, { lastAccessed: NOW })))
	const result = await runSmartScope(tabs, { llmEnabled: false }, { proactive: true, minSaveCount: 9, now: NOW })
	assert.equal(result.saveSet.length, 0)
	const graph = buildAssociationGraph(tabs)
	const body = buildSmartScopeRequest(tabs, graph, NOW, { proactive: true, minSaveCount: 9 })
	assert.doesNotMatch(body.messages[0].content, /user clicked Smart|HARD TAB-LIMIT FLOOR|still save the half|SAVE everything else|KEEP only when/i)
	const missing = parseSmartScopeResponse({ groups: [], tabActions: [] }, tabs, graph, NOW, { proactive: true })
	assert.equal(missing.saveSet.length, 0)
})

test('close probes again just before removal, skips changed and unknown forms, and records partial failures', async () => {
	const tabs = [1, 2, 3, 4, 5, 6].map(id => saved(live(id)))
	const current = new Map(tabs.map(tab => [tab.originalTabId, live(tab.originalTabId)]))
	current.get(5).discarded = true
	const removed = []
	const probed = []
	const result = await closeValidatedTabs(tabs, {
		getTab: async id => current.get(id),
		probe: async id => {
			probed.push(id)
			if (id === 2) current.get(id).url += '?changed'
			if (id === 3) return { hasUnsavedInput: true }
			if (id === 4) throw new Error('cannot inspect')
			return {}
		},
		remove: async id => { if (id === 6) throw new Error('cannot remove'); removed.push(id) },
	})
	assert.deepEqual(removed, [1, 5])
	assert.equal(probed.includes(5), false)
	assert.equal(result.skipped.length, 3)
	assert.deepEqual(result.failed.map(tab => tab.originalTabId), [6])
})

test('explicit refresh can replace a cancelled automatic computation instead of joining a dead promise', async () => {
	const h = harness()
	await h.service.refresh()
	h.advance(PLAN_REFRESH_MS)
	h.tabs.push(live(4))
	let release
	h.gate = new Promise(resolve => { release = resolve })
	const automatic = h.service.refresh()
	await new Promise(resolve => setImmediate(resolve))
	h.service.cancelRefresh()
	h.gate = null
	const fresh = await h.service.refresh({ force: true })
	assert.ok(fresh)
	release()
	assert.equal(await automatic, null)
	assert.equal((await h.service.get()).id, fresh.id)
})

test('an explicit refresh is allowed immediately after an automatic check, but repeated explicit clicks are bounded', async () => {
	const h = harness()
	await h.service.refresh()
	h.advance(5000)
	await h.service.refresh({ force: true })
	assert.equal(h.calls, 2)
	await h.service.refresh({ force: true })
	assert.equal(h.calls, 2)
})

test('a Keep choice still persists when its tab was safety-pruned during a long review', async () => {
	const h = harness()
	const p = await h.service.refresh()
	await h.service.beginReview(p.id)
	h.tabs[0].lastAccessed = NOW
	await h.service.get()
	await h.service.exclude(p.id, [p.tabs[0].id])
	h.advance(120 * 60_000)
	const refreshed = await h.service.refresh({ force: true })
	assert.equal(refreshed.tabs.some(tab => tab.originalTabId === 1), false)
})

test('claim and reconciliation cannot resurrect a consumed plan', async () => {
	const h = harness()
	const p = await h.service.refresh()
	await h.service.beginReview(p.id)
	await Promise.all([h.service.get(), h.service.claim(p.id), h.service.get()])
	assert.equal(await h.service.get(), null)
})

test('explicit include-pinned permits captured pins, but a newly pinned tab always survives', async () => {
	const captured = [saved(live(1, { pinned: true })), saved(live(2))]
	const removed = []
	const result = await closeValidatedTabs(captured, {
		getTab: async id => live(id, { pinned: true }), probe: async () => ({}), remove: async id => removed.push(id),
	}, { protectPinned: false })
	assert.deepEqual(removed, [1])
	assert.equal(result.skipped[0].tab.originalTabId, 2)
})

test('a tab disappearing during remove is recorded as gone, without aborting the rest', async () => {
	const current = new Map([[1, live(1)], [2, live(2)]])
	const result = await closeValidatedTabs([saved(live(1)), saved(live(2))], {
		getTab: async id => current.get(id), probe: async () => ({}),
		remove: async id => { current.delete(id); if (id === 1) throw new Error('already closed') },
	})
	assert.deepEqual(result.gone.map(tab => tab.originalTabId), [1])
	assert.deepEqual(result.closed.map(tab => tab.originalTabId), [2])
})

test('LLM proactive request uses the same categorizer, keeps omitted actions, and falls back without a quota on failure', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	const tabs = [saved(live(1)), saved(live(2)), saved(live(3, { lastAccessed: NOW }))]
	globalThis.fetch = async (_url, options) => {
		const request = JSON.parse(options.body)
		assert.match(request.messages[0].content, /optional suggestion/)
		assert.match(request.messages[0].content, /there is no quota/)
		assert.equal('saveFloor' in JSON.parse(request.messages[1].content), false)
		return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ groups: [{ name: 'Research', tabIds: ['1'] }] }) } }] }) }
	}
	const settings = { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }
	const result = await runSmartScope(tabs, settings, { proactive: true, now: NOW, minSaveCount: 3 })
	assert.deepEqual(result.saveSet.map(tab => tab.id), ['saved-1'])
	globalThis.fetch = async () => { throw new Error('offline') }
	const fallback = await runSmartScope(tabs, settings, { proactive: true, now: NOW, minSaveCount: 3 })
	assert.equal(fallback.mode, 'heuristic')
	assert.equal(fallback.saveSet.some(tab => tab.originalTabId === 3), false)
	assert.equal(fallback.error, 'offline')
})

test('with AI on, a failed automatic AI run prepares no local list and keeps the last valid AI list', async () => {
	const h = harness()
	h.settings = { llmEnabled: true }
	h.deps.select = async tabs => ({ saveSet: tabs.slice(0, 1), categories: [], mode: 'llm' })
	const ai = await h.service.refresh()
	assert.equal(ai.mode, 'llm')
	h.deps.select = async tabs => ({ saveSet: tabs, categories: [], mode: 'heuristic', error: 'timeout', localReason: 'ai-unavailable' })
	h.advance(PLAN_REFRESH_MS)
	h.tabs = [...h.tabs, live(4)]
	const kept = await h.service.refresh()
	assert.equal(kept.id, ai.id, 'the last AI list stands')
	assert.equal(h.state.plan.mode, 'llm')
	h.advance(PLAN_MAX_AGE_MS)
	assert.equal(await h.service.refresh(), null, 'an expired AI list is not replaced by a local one')
	assert.notEqual(h.state.plan?.mode, 'heuristic')
})

test('with AI on and the automatic cap reached, no pages are inspected and no list is prepared', async () => {
	const h = harness()
	h.settings = { llmEnabled: true }
	let captured = 0
	const capture = h.deps.capture
	h.deps.capture = async (...args) => { captured++; return capture(...args) }
	h.deps.automaticAiAvailable = async () => false
	assert.equal(await h.service.refresh(), null)
	assert.equal(captured, 0)
	assert.equal(h.calls, 0)
	assert.equal(h.state.plan ?? null, null)
})

test('explicit runs with AI on, and automatic runs with AI off, still prepare local lists', async () => {
	const h = harness()
	h.settings = { llmEnabled: true }
	h.deps.select = async tabs => ({ saveSet: tabs, categories: [], mode: 'heuristic', localReason: 'ai-unavailable' })
	const explicit = await h.service.refresh({ force: true })
	assert.equal(explicit.mode, 'heuristic')
	assert.equal(explicit.reviewRequired, true)
	const off = harness()
	assert.equal((await off.service.refresh()).mode, 'heuristic')
})

test('a prepared suggestion records its token totals and the open tab count', async () => {
	const h = harness()
	const recorded = []
	h.deps.record = async (event, fields) => { recorded.push({ event, ...fields }) }
	h.deps.select = async tabs => ({ saveSet: tabs.slice(0, 1), categories: [], mode: 'llm', usage: { promptTokens: 900, completionTokens: 40 } })
	await h.service.refresh()
	const prepared = recorded.find(entry => entry.event === 'suggestion_prepared')
	assert.deepEqual([prepared.promptTokens, prepared.completionTokens, prepared.tabCount], [900, 40, 3])
})
