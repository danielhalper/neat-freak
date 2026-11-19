import test from 'node:test'
import assert from 'node:assert/strict'
import { heuristicSignals, runSmartScope } from '../src/smart-scope.js'
import { replayHeuristic, offers, POLICIES } from '../eval/behavior-rules.js'

test('heuristicSignals matches the shipped proactive heuristic, and the offline replay matches both', async () => {
	const now = Date.UTC(2026, 10, 9, 12)
	const m = 60_000
	const tabs = [
		['a', 'https://github.com/o/r/pull/1', 'Fix login bug pull request', 200], ['b', 'https://github.com/o/r/pull/2', 'Login bug follow up pull request', 40],
		['c', 'https://news.example.com/x', 'Election coverage live', 500], ['d', 'https://news.example.com/x', 'Election coverage live', 900],
		['e', 'https://docs.google.com/document/d/1', 'Quarterly plan draft', 300], ['f', 'https://shop.example.com/cart', 'Cart', 20],
		['g', 'https://lonely.example.org/', 'Unrelated recipe page', 4000], ['h', 'https://github.com/o/r/issues/9', 'Login bug report issue', 10],
	].map(([id, url, title, ago]) => ({ id, url, title, domain: new URL(url).hostname, lastAccessed: now - ago * m, originalTabId: id }))
	tabs[4].hasUnsavedInput = true
	tabs[1].audible = true
	const signals = heuristicSignals(tabs, now)
	const live = new Set((await runSmartScope(tabs, { llmEnabled: false }, { proactive: true, now })).saveSet.map(tab => tab.id))
	for (const tab of tabs) {
		const s = signals.get(tab.id)
		assert.equal(s.offer, live.has(tab.id), `live ${tab.id}`)
		const features = { ...s, idleMin: (now - tab.lastAccessed) / m, audible: Boolean(tab.audible), unsaved: Boolean(tab.hasUnsavedInput) }
		assert.equal(offers(POLICIES[0], features), s.offer, `replay ${tab.id}`)
		assert.equal(replayHeuristic(features) || !s.offer, true)
	}
	assert.ok(signals.get('d').duplicate)
	assert.ok(live.size > 0 && live.size < tabs.length)
})
