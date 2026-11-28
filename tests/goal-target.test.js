import test from 'node:test'
import assert from 'node:assert/strict'
import { runSmartScope, buildCompactRequest, FLOOR_MIN_IDLE_MIN } from '../src/smart-scope.js'
import { buildAssociationGraph } from '../src/categorizer.js'
import { createChromeHarness } from './helpers/chrome-harness.js'

// Every list aims at the tab goal, within reason: lists the user asks for
// (panel open, Refresh, Tidy with nothing prepared) and automatic nudge lists.
// Nudge requests say the user has not pressed anything yet.

const NOW = 1_800_000_000_000
const MIN = 60_000
function tab(id, minutes, extra = {}) {
	return { id, originalTabId: id, title: `Article ${id}`, url: `https://example.com/article/${id}`,
		lastAccessed: minutes == null ? undefined : NOW - minutes * MIN, ...extra }
}
function aiReturns(t, pick) {
	const original = globalThis.fetch
	globalThis.fetch = async (_url, options) => {
		const payload = JSON.parse(JSON.parse(options.body).messages[1].content)
		return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ groups: [{ name: 'Done', tabIds: pick(payload.tabs) }] }) } }] }) }
	}
	t.after(() => { globalThis.fetch = original })
}
const ai = { llmEnabled: true, backendUrl: 'https://synthetic.invalid' }
const ids = result => result.saveSet.map(item => item.id).sort()
const mixed = () => [
	tab('recent', 20), tab('idle2h', 120), tab('idle4h', 240), tab('idle5h', 300),
	tab('unsaved', 400, { hasUnsavedInput: true }), tab('never', null), tab('pinned', 500, { pinned: true }),
	tab('audible', 500, { audible: true }), tab('unknown', 500, { signalsUnavailable: true }), tab('active', 500, { active: true }),
]

test('the top-up adds only tabs idle 3 hours or more, never protected ones, and stops short when they run out', async t => {
	assert.equal(FLOOR_MIN_IDLE_MIN, 180)
	aiReturns(t, () => [])
	const result = await runSmartScope(mixed(), ai, { now: NOW, minSaveCount: 9 })
	assert.deepEqual(ids(result), ['idle4h', 'idle5h'], 'used 20 min ago, idle 2 h, unsaved, never viewed, pinned, audible, unknown and active are never added')
	assert.equal(result.targetCount, 9)
	assert.equal(result.floorAdded, 2)
})

test('the AI may pick a tab idle 30 minutes or more, but never a protected or recently used one', async t => {
	aiReturns(t, tabs => tabs.map(row => row.id))
	const result = await runSmartScope(mixed(), ai, { now: NOW, minSaveCount: 2 })
	assert.deepEqual(ids(result), ['idle2h', 'idle4h', 'idle5h'])
	assert.equal(result.floorAdded, 0)
})

test('the top-up ranks stale reading before work surfaces', async t => {
	aiReturns(t, () => [])
	const tabs = [
		tab('doc', 300, { url: 'https://docs.google.com/document/d/a/edit' }),
		tab('mail', 300, { url: 'https://mail.google.com/mail/u/0/#inbox' }),
		tab('search', 300, { url: 'https://www.google.com/search?q=tabs' }),
		tab('blog', 300, { url: 'https://medium.com/blog/post' }),
	]
	const result = await runSmartScope(tabs, ai, { now: NOW, minSaveCount: 2 })
	assert.deepEqual(ids(result), ['blog', 'search'])
})

test('user-asked and nudge requests both aim at the goal; only the opener differs', () => {
	const tabs = Array.from({ length: 17 }, (_, i) => tab(`t${i}`, 300))
	const graph = buildAssociationGraph(tabs)
	const asked = buildCompactRequest(tabs, graph, NOW, { minSaveCount: 11, totalOpenTabCount: 25, clutterThreshold: 15 }).body.messages[0].content
	assert.match(asked, /The user asked Neat Freak to clear their tab clutter\./)
	assert.match(asked, /They want to be under their goal of 15 open tabs and have 25 open\. Aim to put away about 11 of these tabs if there are good candidates, finished and stale content first\. Do not add a tab just to reach the number\./)
	assert.doesNotMatch(asked, /must put away|at least/i)
	const nudge = buildCompactRequest(tabs, graph, NOW, { proactive: true, minSaveCount: 11, totalOpenTabCount: 25, clutterThreshold: 15 }).body.messages[0].content
	assert.match(nudge, /Neat Freak is preparing a suggestion for the user\. They have not pressed anything yet, but they set a goal for how many tabs to keep open and are over it\./)
	assert.match(nudge, /They want to be under their goal of 15 open tabs and have 25 open\. Aim to put away about 11 of these tabs/)
	assert.match(nudge, /Put away read-once and finished content/)
	assert.match(nudge, /Keep the user's active work/)
	assert.doesNotMatch(nudge, /When unsure, leave it out|there is no quota|optional suggestion|asked Neat Freak/)
})

// ---- Service worker ----

const MODEL_URL = 'https://model.example.test/chat/completions'
async function bootWorker(t, tabs, settings = {}) {
	const timers = []
	const originalTimeout = globalThis.setTimeout
	globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
	const h = createChromeHarness({ tabs })
	Object.assign(h.data.local.tabAtlasSettings, { prepareSuggestions: true, llmEnabled: true }, settings)
	globalThis.chrome = h.chrome
	const prompts = []
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url, options) => {
		if (url !== MODEL_URL) return { ok: true, json: async () => ({ key: 'synthetic-key', baseUrl: MODEL_URL, expiresAt: Date.now() + 3_600_000 }) }
		const body = JSON.parse(options.body)
		prompts.push(body.messages[0].content)
		const rows = JSON.parse(body.messages[1].content).tabs
		const picks = rows.filter(row => row.minutesAgo >= 100 && row.minutesAgo < 180).map(row => row.id)
		return { ok: true, json: async () => ({ usage: { prompt_tokens: 900, completion_tokens: 40 }, choices: [{ message: { content: JSON.stringify({ groups: picks.length ? [{ name: 'Done', tabIds: picks }] : [] }) } }] }) }
	}
	t.after(() => { globalThis.setTimeout = originalTimeout; globalThis.fetch = originalFetch; delete globalThis.chrome })
	await import(`../src/background.js?goal=${Math.random()}`)
	const check = () => timers.findLast(timer => timer.ms === 3000).fn()
	return {
		h, prompts, check,
		get plan() { return h.data.session.neatFreakRecommendation?.plan },
		get cycle() { return h.data.local.neatFreakNudgeCycle },
		get diagnostics() { return h.data.local.neatFreakDiagnostics || [] },
	}
}
const liveTab = (id, minutes, extra = {}) => ({ id, windowId: 1, index: id, active: false, title: `Article ${id}`,
	url: `https://example.test/article/${id}`, lastAccessed: minutes == null ? undefined : Date.now() - minutes * MIN, ...extra })

test('panel open, Refresh and the automatic run all send the goal target; only the opener differs', async t => {
	const tabs = [liveTab(1, 1, { active: true }), ...Array.from({ length: 9 }, (_, i) => liveTab(i + 2, 120 + i * 30))]
	const f = await bootWorker(t, tabs)
	const opened = await f.h.send({ type: 'PREPARE_RECOMMENDATION' })
	assert.equal(opened.ok, true, opened.error)
	assert.match(f.prompts.at(-1), /Aim to put away about 6 of these tabs/, '10 open, goal 5: target 10 - 4')
	assert.match(f.prompts.at(-1), /asked Neat Freak to clear their tab clutter/)
	const prepared = f.diagnostics.filter(entry => entry.event === 'suggestion_prepared').at(-1)
	assert.deepEqual([prepared.automatic, prepared.targetCount, prepared.floorAdded], [false, 6, 4], 'the AI picked the two tabs idle about 2 h; the top-up added 4')
	assert.equal(f.plan.requested, true)
	await f.check()
	assert.match(f.prompts.at(-1), /They have not pressed anything yet/, 'a list the user asked for is never reused for a nudge; the cycle runs its own')
	assert.match(f.prompts.at(-1), /Aim to put away about 6 of these tabs/)
	assert.equal(f.plan.requested, false)
	const automatic = f.diagnostics.filter(entry => entry.event === 'suggestion_prepared').at(-1)
	assert.deepEqual([automatic.automatic, automatic.targetCount], [true, 6])
	f.h.data.session.neatFreakRecommendation.lastExplicitAttemptAt = 0
	await f.h.send({ type: 'REFRESH_RECOMMENDATION' })
	assert.match(f.prompts.at(-1), /Aim to put away about 6/)
})

test('opening the panel reuses a nudged cautious list for 15 minutes, otherwise runs the target request', async t => {
	const tabs = [liveTab(1, 1, { active: true }), ...Array.from({ length: 9 }, (_, i) => liveTab(i + 2, 120 + i * 30))]
	const f = await bootWorker(t, tabs)
	await f.check()
	assert.equal(f.h.data.session.neatFreakPanelState.mode, 'clutter', 'the cautious list was nudged')
	const runs = f.prompts.length
	assert.equal((await f.h.send({ type: 'GET_POPUP_STATE' })).recommendationNeedsRun, false)
	const review = await f.h.send({ type: 'REVIEW_RECOMMENDATION', planId: f.plan.id })
	assert.equal(review.reviewOpened, true)
	assert.equal(f.prompts.length, runs, 'clicking the nudge opens its list without a run')
	f.h.data.local.neatFreakNudgeCycle.shownAt -= 16 * MIN
	assert.equal((await f.h.send({ type: 'GET_POPUP_STATE' })).recommendationNeedsRun, true, 'a cautious list not shown recently is replaced')
	f.h.data.session.neatFreakRecommendation.lastExplicitAttemptAt = 0
	await f.h.send({ type: 'PREPARE_RECOMMENDATION' })
	assert.equal(f.plan.requested, true)
	assert.equal((await f.h.send({ type: 'GET_POPUP_STATE' })).recommendationNeedsRun, false, 'a target list stays fresh for 30 minutes')
	f.h.data.session.neatFreakRecommendation.plan.createdAt -= 31 * MIN
	assert.equal((await f.h.send({ type: 'GET_POPUP_STATE' })).recommendationNeedsRun, true)
})

test('a Tidy press with nothing prepared and review off closes only the target list', async t => {
	const tabs = [
		liveTab(1, 1, { active: true }), liveTab(2, 20), liveTab(3, 120), liveTab(4, 240), liveTab(5, 300),
		liveTab(6, 400, { hasUnsavedInput: true }), liveTab(7, null), liveTab(8, 500, { pinned: true }),
	]
	const f = await bootWorker(t, tabs)
	const saved = await f.h.send({ type: 'SAVE_TABS', options: { scope: 'smart', reviewBeforeClose: false, openManager: false } })
	assert.equal(saved.ok, true, saved.error)
	assert.match(f.prompts.at(-1), /Aim to put away about 4 of these tabs/, '8 open, goal 5: target 4')
	assert.deepEqual([...f.h.removed].sort((a, b) => a - b), [3, 4, 5], 'the AI pick (idle 2 h) plus the top-up (idle 4-5 h); short of 4 by design')
})

test('a nudge (automatic) run tops up only tabs idle 3 hours, never protected ones', async t => {
	aiReturns(t, () => [])
	const result = await runSmartScope(mixed(), ai, { proactive: true, now: NOW, minSaveCount: 9 })
	assert.deepEqual(ids(result), ['idle4h', 'idle5h'])
	assert.deepEqual([result.targetCount, result.floorAdded], [9, 2])
})

test('with AI off, nudge runs get the goal top-up but never the 40% "everything looks recent" fallback', async () => {
	const recent = Array.from({ length: 10 }, (_, i) => tab(`r${i}`, 10 + i))
	const asked = await runSmartScope(recent, { llmEnabled: false }, { now: NOW, minSaveCount: 9 })
	assert.equal(asked.saveSet.length, 4, 'a Smart press still has its 40% fallback')
	const nudge = await runSmartScope(recent, { llmEnabled: false }, { proactive: true, now: NOW, minSaveCount: 9 })
	assert.equal(nudge.saveSet.length, 0, 'a nudge does not')
	const mixedAges = [...recent, tab('old1', 300), tab('old2', 400)]
	const topped = await runSmartScope(mixedAges, { llmEnabled: false }, { proactive: true, now: NOW, minSaveCount: 9 })
	assert.deepEqual(ids(topped), ['old1', 'old2'])
})

test('a nudge run at 65 open tabs with a goal of 15 sends the target, not the cautious text', async t => {
	const tabs = [liveTab(1, 1, { active: true }), ...Array.from({ length: 64 }, (_, i) => liveTab(i + 2, 200 + i))]
	const f = await bootWorker(t, tabs, { clutterThreshold: 15 })
	await f.check()
	const prompt = f.prompts.at(-1)
	assert.match(prompt, /They have not pressed anything yet/)
	assert.match(prompt, /They want to be under their goal of 15 open tabs and have 65 open\. Aim to put away about 51 of these tabs/)
	assert.doesNotMatch(prompt, /When unsure, leave it out|there is no quota/)
	const prepared = f.diagnostics.filter(entry => entry.event === 'suggestion_prepared').at(-1)
	assert.deepEqual([prepared.automatic, prepared.targetCount], [true, 51])
	assert.ok(prepared.floorAdded > 0, 'the top-up fills in from tabs idle 3 h or more')
	assert.ok(f.plan.tabs.length <= 51)
})
