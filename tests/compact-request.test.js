import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCompactRequest, runSmartScope } from '../src/smart-scope.js'
import { buildAssociationGraph } from '../src/categorizer.js'

// Smart requests (background suggestions and the manual Smart tidy) must come
// back inside the 25-second MV3 fetch window.
// Measured on Tinfoil gpt-oss-120b (2026-11-16): the full Smart request took
// ~40 s at 30, 35 and 120 tabs (5.5-6.4k output tokens); this compact request
// took 2-3.4 s (240-450 output tokens). Latency is driven by output tokens, so
// these tests pin the things that keep the output small.

const NOW = 1_800_000_000_000
function tab(n, extra = {}) {
	return {
		id: `tab-${n}-0f8e2c1a-7b4d-4e8a-9f1c-2d3e4f5a6b7c`, originalTabId: n,
		title: `Research article ${n}`, url: `https://example.com/article/${n}`,
		pageSummary: 'x'.repeat(720), lastAccessed: NOW - 120 * 60_000, ...extra,
	}
}
function build(tabs, floorContext = { proactive: true }) {
	return buildCompactRequest(tabs, buildAssociationGraph(tabs), NOW, floorContext)
}
function answer(content) {
	return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) })
}

test('proactive request asks only for folders of tabs to put away, with low reasoning', () => {
	const { body } = build([tab(1), tab(2)])
	assert.equal(body.reasoning_effort, 'low')
	const schema = body.response_format.json_schema.schema
	assert.deepEqual(schema.required, ['groups'])
	assert.deepEqual(Object.keys(schema.properties), ['groups'])
	assert.deepEqual(Object.keys(schema.properties.groups.items.properties).sort(), ['name', 'tabIds'])
})

test('proactive request replaces long tab ids with short ones the model echoes back', () => {
	const tabs = [tab(1), tab(2), tab(3)]
	const { body, tabIdByShortId } = build(tabs)
	const sent = JSON.parse(body.messages[1].content).tabs
	assert.deepEqual(sent.map(row => row.id), ['1', '2', '3'])
	assert.doesNotMatch(JSON.stringify(body), /0f8e2c1a/)
	assert.equal(tabIdByShortId.get('2'), tabs[1].id)
})

test('proactive request trims page summaries harder for large windows', () => {
	const small = JSON.parse(build([tab(1)]).body.messages[1].content).tabs[0]
	const large = JSON.parse(build(Array.from({ length: 60 }, (_, i) => tab(i + 1))).body.messages[1].content).tabs[0]
	// truncateText keeps max - 1 characters and appends "...".
	assert.ok(small.summary.length <= 502)
	assert.ok(large.summary.length <= 302)
	assert.ok(large.summary.length < small.summary.length)
})

test('proactive request passes recency and unsaved input, and null when a tab was never viewed', () => {
	const tabs = [tab(1, { lastAccessed: NOW - 45 * 60_000, hasUnsavedInput: true }), tab(2, { lastAccessed: undefined })]
	const sent = JSON.parse(build(tabs).body.messages[1].content).tabs
	assert.equal(sent[0].minutesAgo, 45)
	assert.equal(sent[0].unsaved, true)
	assert.equal(sent[1].minutesAgo, null)
	assert.equal('unsaved' in sent[1], false)
})

test('proactive AI never offers a tab used in the last 30 minutes or never viewed, even if the model lists it', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	const tabs = [tab(1), tab(2, { lastAccessed: NOW - 14 * 60_000 }), tab(3, { lastAccessed: undefined }), tab(4, { lastAccessed: NOW - 31 * 60_000 })]
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ choices: [{ message: { content: JSON.stringify({ groups: [{ name: 'Everything', tabIds: ['1', '2', '3', '4'] }] }) } }] }),
	})
	const result = await runSmartScope(tabs, { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }, { proactive: true, now: NOW })
	assert.equal(result.mode, 'llm')
	assert.deepEqual(result.saveSet.map(t => t.originalTabId), [1, 4])
})

test('proactive model answer maps short ids back, keeps everything it left out, and ignores unknown ids', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	const tabs = [tab(1), tab(2), tab(3)]
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ choices: [{ message: { content: JSON.stringify({ groups: [{ name: 'Old research', tabIds: ['1', '99'] }] }) } }] }),
	})
	const result = await runSmartScope(tabs, { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }, { proactive: true, now: NOW })
	assert.equal(result.mode, 'llm')
	assert.deepEqual(result.saveSet.map(t => t.id), [tabs[0].id])
	assert.deepEqual(result.keepSet.map(t => t.id), [tabs[1].id, tabs[2].id])
	assert.deepEqual(result.categories.map(c => [c.name, c.tabIds]), [['Old research', [tabs[0].id]]])
})

test('the model\'s own picks, before the recency guard, come back as ids for the tab habits log', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	const settings = { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }
	// 1 and 4 idle 4 h, so the goal top-up may add them (it needs 3 h).
	const tabs = [tab(1, { lastAccessed: NOW - 240 * 60_000 }), tab(2, { lastAccessed: NOW - 14 * 60_000 }), tab(3, { lastAccessed: undefined }), tab(4, { lastAccessed: NOW - 240 * 60_000 })]
	globalThis.fetch = answer({ groups: [{ name: 'A', tabIds: ['2', '99', '1'] }, { name: 'B', tabIds: ['1', '3'] }] })
	const proactive = await runSmartScope(tabs, settings, { proactive: true, now: NOW })
	assert.deepEqual(proactive.saveSet.map(t => t.originalTabId), [1])
	assert.deepEqual(proactive.modelPicks, [tabs[1].id, tabs[0].id, tabs[2].id]) // listed order, unknown dropped, once each

	globalThis.fetch = answer({ groups: [{ name: 'A', tabIds: ['2'] }] })
	const manual = await runSmartScope(tabs, settings, { now: NOW, minSaveCount: 2 })
	assert.equal(manual.saveSet.length, 2) // the floor tops up; picks stay the model's own
	assert.deepEqual(manual.modelPicks, [tabs[1].id])

	globalThis.fetch = async () => { throw new Error('offline') }
	const local = await runSmartScope(tabs, settings, { proactive: true, now: NOW })
	assert.equal(local.mode, 'heuristic')
	assert.equal(local.modelPicks, undefined)
})

test('manual Smart request is compact too, asks to clear clutter, and aims at the goal as a target', () => {
	const { body } = build([tab(1), tab(2), tab(3)], { minSaveCount: 2 })
	assert.equal(body.reasoning_effort, 'low')
	assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ['groups'])
	assert.match(body.messages[0].content, /asked Neat Freak to clear their tab clutter/)
	assert.match(body.messages[0].content, /Aim to put away about 2 of these tabs if there are good candidates/)
	assert.doesNotMatch(body.messages[0].content, /at least/)
	assert.doesNotMatch(body.messages[0].content, /optional suggestion/)
})

test('manual Smart keeps the tabs the model leaves out', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	const tabs = [tab(1), tab(2), tab(3)]
	globalThis.fetch = answer({ groups: [{ name: 'Old research', tabIds: ['1'] }] })
	const result = await runSmartScope(tabs, { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }, { now: NOW, minSaveCount: 0 })
	assert.equal(result.mode, 'llm')
	assert.deepEqual(result.saveSet.map(t => t.originalTabId), [1])
})

test('manual Smart never closes a tab used in the last 30 minutes on the model\'s say-so', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	const tabs = [tab(1, { lastAccessed: NOW - 5 * 60_000 }), tab(2)]
	globalThis.fetch = answer({ groups: [{ name: 'Everything', tabIds: ['1', '2'] }] })
	const result = await runSmartScope(tabs, { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }, { now: NOW, minSaveCount: 0 })
	assert.deepEqual(result.saveSet.map(t => t.originalTabId), [2])
})

test('manual Smart tab-limit floor still closes enough, oldest first, when the model under-delivers', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	const tabs = [tab(1, { lastAccessed: NOW - 5 * 60_000 }), tab(2, { lastAccessed: NOW - 300 * 60_000 }), tab(3, { lastAccessed: NOW - 10 * 60_000 })]
	globalThis.fetch = answer({ groups: [] })
	const result = await runSmartScope(tabs, { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }, { now: NOW, minSaveCount: 1 })
	assert.deepEqual(result.saveSet.map(t => t.originalTabId), [2])
})

test('manual Smart gives up on the model after 25 seconds and tidies locally', async t => {
	const originalFetch = globalThis.fetch
	const originalTimeout = globalThis.setTimeout
	t.after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout })
	const delays = []
	globalThis.setTimeout = (fn, ms, ...args) => { delays.push(ms); return originalTimeout(fn, 0, ...args) }
	globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
	const result = await runSmartScope(Array.from({ length: 70 }, (_, i) => tab(i + 1)), { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }, { now: NOW, minSaveCount: 0 })
	assert.equal(result.mode, 'heuristic')
	assert.ok(delays.length > 0)
	assert.ok(Math.max(...delays) <= 25_000, `model wait was ${Math.max(...delays)} ms`)
})

test('the model run reports its token totals, and nothing else from the response', async t => {
	const original = globalThis.fetch
	t.after(() => { globalThis.fetch = original })
	globalThis.fetch = async () => ({ ok: true, json: async () => ({
		usage: { prompt_tokens: 5267, completion_tokens: 236, total_tokens: 5503 },
		choices: [{ message: { content: JSON.stringify({ groups: [{ name: 'Old research', tabIds: ['1'] }] }) } }],
	}) })
	const result = await runSmartScope([tab(1), tab(2)], { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }, { proactive: true, now: NOW })
	assert.deepEqual(result.usage, { promptTokens: 5267, completionTokens: 236 })
})
