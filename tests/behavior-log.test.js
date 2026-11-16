import test from 'node:test'
import assert from 'node:assert/strict'
import {
	createBehaviorLog, registrableDomain, retainFinished, BEHAVIOR_OPEN_KEY, BEHAVIOR_LOG_KEY,
	BEHAVIOR_MAX_AGE_MS, BEHAVIOR_MAX_RECORDS, BEHAVIOR_MAX_BYTES, BEHAVIOR_MAX_VISITS, BEHAVIOR_MAX_CREDIT_MS,
} from '../src/behavior-log.js'

const MIN = 60_000

function fixture({ enabled = true, tabs = [] } = {}) {
	const data = {}
	let time = 2_000_000_000_000
	let fail = false
	const h = {
		data, tabs: structuredClone(tabs), enabled,
		storage: {
			async get(key) { return { [key]: structuredClone(data[key]) } },
			async set(values) { if (fail) throw new Error('storage unavailable'); Object.assign(data, structuredClone(values)) },
			async remove(keys) { for (const key of keys) delete data[key] },
		},
		now: () => time,
		advance(ms) { time += ms },
		set fail(value) { fail = value },
		get finished() { return data[BEHAVIOR_LOG_KEY] || [] },
		get open() { return data[BEHAVIOR_OPEN_KEY]?.tabs || {} },
	}
	h.log = createBehaviorLog({
		storage: h.storage, now: h.now, enabled: async () => h.enabled,
		queryTabs: async query => h.tabs.filter(tab => !query.active || tab.active),
	})
	return h
}

const tab = (id, url, extra = {}) => ({ id, windowId: 1, url, title: `Private title ${id}`, ...extra })

test('registrableDomain keeps only the registrable domain', () => {
	assert.equal(registrableDomain('https://docs.google.com/document/d/secret/edit'), 'google.com')
	assert.equal(registrableDomain('https://www.bbc.co.uk/news/private?q=1'), 'bbc.co.uk')
	assert.equal(registrableDomain('https://someone.github.io/repo'), 'someone.github.io')
	assert.equal(registrableDomain('http://localhost:5173/admin'), 'localhost')
	assert.equal(registrableDomain('http://192.168.1.20/router'), '(ip)')
	assert.equal(registrableDomain('http://[::1]:8080/'), '(ip)')
	assert.equal(registrableDomain('file:///Users/me/taxes.pdf'), '(file)')
	assert.equal(registrableDomain('chrome://newtab/'), '(browser)')
	assert.equal(registrableDomain('chrome-extension://abc/manager.html'), '(extension)')
	assert.equal(registrableDomain('not a url'), '(none)')
})

test('nothing is recorded while the log is off', async () => {
	const h = fixture({ enabled: false, tabs: [tab(1, 'https://a.example.com')] })
	await h.log.tabCreated(tab(1, 'https://a.example.com'))
	await h.log.tabActivated({ tabId: 1, windowId: 1 })
	await h.log.tabRemoved(1, {})
	assert.deepEqual(h.data, {})
})

test('a tab lifecycle records opener, visits, rough dwell, discards and a manual close', async () => {
	const h = fixture({ tabs: [tab(1, 'https://news.example.com/a', { active: true }), tab(2, 'https://mail.example.org/inbox')] })
	await h.log.tabCreated(tab(1, 'https://news.example.com/a'))
	await h.log.tabCreated({ ...tab(2, ''), pendingUrl: 'https://mail.example.org/inbox', openerTabId: 1 })
	await h.log.tabActivated({ tabId: 1, windowId: 1 })
	h.advance(2 * MIN)
	await h.log.tabActivated({ tabId: 2, windowId: 1 })
	h.advance(3 * MIN)
	await h.log.windowFocused(-1) // user switched to another app: dwell pauses, visit continues
	h.advance(60 * MIN)
	h.tabs[0].active = false
	h.tabs[1].active = true
	await h.log.windowFocused(1) // back in Chrome on the same tab: same visit, dwell resumes
	h.advance(1 * MIN)
	await h.log.tabActivated({ tabId: 1, windowId: 1 })
	await h.log.tabUpdated(2, { discarded: true })
	await h.log.tabUpdated(2, { status: 'loading' }) // ignored
	h.advance(10 * MIN)
	await h.log.tabRemoved(2, { isWindowClosing: false })

	const [closed] = h.finished
	assert.equal(closed.outcome, 'closed')
	assert.equal(closed.domain, 'example.org')
	assert.equal(closed.opener, true)
	assert.equal(closed.activations, 1)
	assert.equal(closed.activeMs, 4 * MIN)
	assert.equal(closed.visits.length, 1)
	assert.equal(closed.visits[0][1] - closed.visits[0][0], 64 * MIN) // wall-clock in front
	assert.equal(closed.discards, 1)
	assert.equal(h.open[1].activations, 2)
	assert.equal(h.open[1].opener, false)
})

test('Neat Freak saves, window closes and late removals get distinct outcomes', async () => {
	const tabs = [1, 2, 3, 4].map(id => tab(id, `https://site${id}.example.com/p`))
	const h = fixture({ tabs })
	for (const item of tabs) await h.log.tabCreated(item)
	// Queued without awaiting, as background.js does right before chrome.tabs.remove.
	h.log.markSaved([1, 3])
	await h.log.tabRemoved(1, {})
	await h.log.tabRemoved(2, { isWindowClosing: true })
	h.advance(5 * MIN) // the remove of tab 3 failed; the user closed it later
	await h.log.tabRemoved(3, {})
	await h.log.tabRemoved(4, {})
	assert.deepEqual(h.finished.map(r => [r.tabId, r.outcome]), [[1, 'saved'], [2, 'window-closed'], [3, 'closed'], [4, 'closed']])
	assert.ok(h.finished.every(record => !('savingAt' in record)))
})

test('Keep in review and restore from a folder are linked to the right tab', async () => {
	const tabs = [tab(5, 'https://docs.example.com/x'), tab(6, 'https://docs.example.com/y')]
	const h = fixture({ tabs })
	for (const item of tabs) await h.log.tabCreated(item)
	await h.log.kept([{ id: 'tab-a', originalTabId: 5, url: tabs[0].url }])
	const firstKeep = h.open[5].keptAt
	h.advance(MIN)
	await h.log.kept([{ originalTabId: 5 }])
	await h.log.markSaved([6])
	await h.log.tabRemoved(6, {})
	h.advance(MIN)
	await h.log.restored([{ id: 'tab-b', originalTabId: 6, url: 'https://docs.example.com/y' }, { originalTabId: 99, url: 'https://x.test' }])
	await h.log.restored([{ originalTabId: 6, url: 'https://docs.example.com/y' }]) // only the first restore counts
	assert.deepEqual([h.open[5].keeps, h.open[5].keptAt], [2, firstKeep])
	assert.equal(h.finished[0].restoredAt - h.finished[0].endedAt, MIN)
})

test('reconcile closes out unobserved tabs; export never reports a gone tab as open', async () => {
	const h = fixture({ tabs: [tab(1, 'https://a.example.com'), tab(2, 'https://b.example.com')] })
	await h.log.tabCreated(h.tabs[0])
	h.tabs = [tab(2, 'https://b.example.com'), tab(7, 'https://c.example.com')] // browser restarted
	await h.log.reconcile()
	assert.deepEqual(h.finished.map(r => [r.tabId, r.outcome]), [[1, 'unknown']])
	assert.equal(h.open[7].seenLate, true)

	h.tabs = [tab(7, 'https://c.example.com')]
	h.enabled = false // paused: storage is left alone, but the export is still honest
	const report = await h.log.exportLog()
	assert.equal(report.enabled, false)
	assert.deepEqual(report.records.map(r => [r.tabId, r.outcome ?? 'open']), [[1, 'unknown'], [2, 'unknown'], [7, 'open']])
	assert.ok(h.open[2])
})

test('export is allowlisted: no URLs, titles or injected fields', async () => {
	const h = fixture({ tabs: [tab(1, 'https://private.example.com/secret-path?token=abc', { active: true })] })
	await h.log.tabCreated(h.tabs[0])
	await h.log.tabActivated({ tabId: 1, windowId: 1 })
	h.data[BEHAVIOR_OPEN_KEY].tabs[1].url = 'https://injected.example.com/secret'
	h.data[BEHAVIOR_OPEN_KEY].tabs[1].title = 'Injected title'
	h.data[BEHAVIOR_OPEN_KEY].tabs[1].domain = 'https://bad/secret'
	h.advance(MIN)
	const report = await h.log.exportLog()
	const text = JSON.stringify(report)
	assert.doesNotMatch(text, /secret|token|Private title|Injected|https?:/i)
	assert.equal(report.records[0].activeMs, MIN) // in-progress dwell counted on export
	assert.deepEqual(Object.keys(report.records[0]).sort(),
		['activations', 'activeMs', 'discards', 'keeps', 'navigations', 'openedAt', 'opener', 'pinned', 'tabId', 'visits'])
})

test('retention caps age, count, bytes, visits and dwell credit', async () => {
	const at = 2_000_000_000_000
	const old = { endedAt: at - BEHAVIOR_MAX_AGE_MS - 1 }
	const fresh = Array.from({ length: BEHAVIOR_MAX_RECORDS + 5 }, (_, i) => ({ endedAt: at - i, tabId: i }))
	const kept = retainFinished([old, ...fresh], at)
	assert.equal(kept.length, BEHAVIOR_MAX_RECORDS)
	assert.equal(kept[0].tabId, 5)
	const bulky = Array.from({ length: 1000 }, (_, i) => ({ endedAt: at, pad: 'x'.repeat(1000), tabId: i }))
	const trimmed = retainFinished(bulky, at)
	assert.ok(JSON.stringify(trimmed).length <= BEHAVIOR_MAX_BYTES)
	assert.equal(trimmed.at(-1).tabId, 999)

	const h = fixture({ tabs: [tab(1, 'https://a.example.com'), tab(2, 'https://b.example.com')] })
	for (let i = 0; i < 2 * (BEHAVIOR_MAX_VISITS + 3); i += 1) {
		await h.log.tabActivated({ tabId: 1 + (i % 2), windowId: 1 })
		h.advance(5 * 60 * MIN) // left in front for hours: credit is capped
	}
	assert.equal(h.open[1].visits.length, BEHAVIOR_MAX_VISITS)
	assert.equal(h.open[1].activations, BEHAVIOR_MAX_VISITS + 3)
	assert.equal(h.open[1].activeMs, h.open[1].activations * BEHAVIOR_MAX_CREDIT_MS)
})

test('storage failures are swallowed and do not poison later writes; clear removes everything', async () => {
	const h = fixture({ tabs: [tab(1, 'https://a.example.com')] })
	h.fail = true
	assert.equal(await h.log.tabCreated(h.tabs[0]), false)
	h.fail = false
	assert.equal(await h.log.tabCreated(h.tabs[0]), true)
	await h.log.clear()
	assert.deepEqual(h.data, {})
	assert.equal(await h.log.tabCreated({ id: 3, url: 'https://x.example.com', incognito: true }), false)
})

test('offer snapshots: one entry per run of the same decision, decoded on export, domain only', async () => {
	const h = fixture({ tabs: [tab(1, 'https://a.example.com/x?secret=1', { active: true }), tab(2, 'https://b.example.com/y', { lastAccessed: 2_000_000_000_000 - 120 * MIN })] })
	const saved = id => ({ id: `tab-${id}`, originalTabId: id, url: h.tabs[id - 1].url, title: 'Private title', lastAccessed: h.tabs[id - 1].lastAccessed, hasUnsavedInput: id === 2 })
	const signals = (candidates, at) => new Map(candidates.map(c => [c.id, { clustered: true, clusterIdleMin: (at - c.lastAccessed) / MIN, duplicate: false, contentScore: 2, offer: true }]))
	const plan = { mode: 'llm', tabs: [saved(2)] }
	await h.log.offerSnapshot([saved(2)], plan, { automatic: true, live: h.tabs, signals })
	h.advance(15 * MIN)
	await h.log.offerSnapshot([saved(2)], plan, { automatic: true, live: h.tabs, signals }) // same run: replaces
	assert.equal(h.open[2].offers.length, 1)
	await h.log.offerSnapshot([saved(2)], { mode: 'heuristic', tabs: [] }, { signals }) // decision changed: new entry
	h.advance(MIN)
	await h.log.tabActivated({ tabId: 2, windowId: 1 })
	h.advance(MIN)
	await h.log.offerSnapshot([saved(2)], { mode: 'heuristic', tabs: [] }, { signals }) // used since: new entry
	const report = await h.log.exportLog()
	const offers = report.records.find(r => r.tabId === 2).offers
	assert.deepEqual(offers.map(o => [o.offered, o.automatic, o.llm]), [[true, true, true], [false, false, false], [false, false, false]])
	assert.equal(offers[0].idleMin, 135)
	assert.equal(offers[0].unsaved, true)
	assert.equal(offers[0].heuristic, true)
	assert.doesNotMatch(JSON.stringify(report), /secret|Private|https?:/)
	let called = false
	h.enabled = false
	await h.log.offerSnapshot([saved(2)], plan, { signals: () => { called = true; return new Map() } })
	assert.equal(called, false) // features are only computed while recording
})

test('offer snapshots record the AI\'s own pick before its recency guard, and manual Smart tidies', async () => {
	const h = fixture({ tabs: [tab(1, 'https://a.example.com/'), tab(2, 'https://b.example.com/'), tab(3, 'https://c.example.com/')] })
	const saved = id => ({ id: `tab-${id}`, originalTabId: id, url: h.tabs[id - 1].url, lastAccessed: h.now() - 20 * MIN })
	const candidates = [saved(1), saved(2), saved(3)]
	await h.log.offerSnapshot(candidates, { mode: 'llm', tabs: [saved(1)], aiPicks: [1, 2] }, { automatic: true })
	h.advance(MIN)
	await h.log.offerSnapshot(candidates, { mode: 'llm', tabs: [saved(1)], aiPicks: [1] }) // tab 2: AI changed its mind, new entry
	h.advance(MIN)
	await h.log.offerSnapshot(candidates, { mode: 'heuristic', tabs: [] }) // local run: no AI pick
	h.advance(MIN)
	await h.log.offerSnapshot([saved(3)], { mode: 'llm', tabs: [saved(3)], aiPicks: [3] }, { manual: true })
	// A row stored before aiPicked existed still decodes.
	h.data[BEHAVIOR_OPEN_KEY].tabs[3].offers.unshift(h.data[BEHAVIOR_OPEN_KEY].tabs[3].offers[0].slice(0, -1))
	const records = Object.fromEntries((await h.log.exportLog()).records.map(r => [r.tabId, r.offers]))
	const view = offers => offers.map(o => [o.offered, o.aiPicked, o.manual])
	assert.deepEqual(view(records[1]), [[true, 1, false], [false, null, false]])
	assert.deepEqual(view(records[2]), [[false, 1, false], [false, 0, false], [false, null, false]])
	assert.deepEqual(view(records[3]), [[false, null, false], [false, 0, false], [false, null, false], [true, 1, true]])
})

test('labelling passes store labels and features, never titles; heuristic sees all open candidates', async () => {
	const now = 2_000_000_000_000
	const h = fixture({ tabs: [
		tab(1, 'https://docs.example.com/a', { lastAccessed: now - 300 * MIN }),
		tab(2, 'https://news.example.org/b', { lastAccessed: now - 50 * MIN }),
		tab(3, 'https://mail.example.net/c', { active: true }),
		tab(4, 'chrome://settings/'),
	] })
	h.enabled = false
	assert.equal(await h.log.saveLabels([{ tabId: 1, label: 'close' }], {}), 0)
	h.enabled = true
	let capturedIds
	const result = await h.log.saveLabels([
		{ tabId: 1, label: 'important' }, { tabId: 3, label: 'either' }, { tabId: 4, label: 'close' }, { tabId: 2, label: 'bogus' },
	], {
		capture: async tabs => { capturedIds = tabs.map(t => t.id); return tabs.map(t => ({ id: `s${t.id}`, originalTabId: t.id, url: t.url, lastAccessed: t.lastAccessed })) },
		signals: captured => new Map(captured.map(c => [c.id, { clustered: true, clusterIdleMin: 50, duplicate: false, contentScore: -3, offer: c.originalTabId === 1 }])),
		offer: { tabs: [{ originalTabId: 1 }] },
	})
	assert.equal(result, 2)
	assert.deepEqual(capturedIds, [1, 2]) // every inactive web tab, labelled or not
	const [pass] = (await h.log.exportLog()).labelPasses
	assert.equal(pass.offerReady, true)
	const byTab = Object.fromEntries(pass.tabs.map(row => [row.tabId, row]))
	assert.deepEqual([byTab[1].label, byTab[1].domain, byTab[1].inOffer, byTab[1].heuristic, byTab[1].idleMin], ['important', 'example.com', true, true, 300])
	assert.deepEqual([byTab[3].label, byTab[3].active, byTab[3].heuristic], ['either', true, false])
	assert.deepEqual([byTab[1].aiPicked, byTab[1].aiIdleMin], [null, null]) // the offer wasn't the AI's
	assert.doesNotMatch(JSON.stringify(pass), /Private title|https?:/)
	await h.log.clear()
	assert.deepEqual(h.data, {})
})

test('a labelling pass is judged as of when the page opened: checking a tab while labelling changes nothing', async () => {
	const h = fixture({ tabs: [
		tab(1, 'https://docs.example.com/a'),
		tab(2, 'https://news.example.org/b'),
		tab(3, 'chrome-extension://neat/label.html'),
	] })
	h.enabled = false
	assert.equal(await h.log.beginLabels(), null)
	h.enabled = true
	const t0 = h.now()
	Object.assign(h.tabs[0], { lastAccessed: t0 })
	Object.assign(h.tabs[1], { lastAccessed: t0 - 50 * MIN })
	await h.log.tabActivated({ tabId: 1 })
	h.advance(5 * MIN)
	h.tabs[2].active = true
	await h.log.tabActivated({ tabId: 3 }) // the label page opens
	h.advance(60 * MIN)
	// An AI suggestion prepared 10 minutes before the page opened.
	const aiPlan = { mode: 'llm', createdAt: t0 + 55 * MIN, tabs: [{ originalTabId: 2 }], aiPicks: [2], aiCandidates: [1, 2] }
	const frozenAt = await h.log.beginLabels({ offer: async () => aiPlan })
	assert.equal(frozenAt, t0 + 65 * MIN)

	// Peek at tab 1 while labelling, then come back.
	h.advance(2 * MIN)
	Object.assign(h.tabs[0], { active: true, lastAccessed: h.now() })
	h.tabs[2].active = false
	await h.log.tabActivated({ tabId: 1 })
	h.advance(MIN)
	Object.assign(h.tabs[0], { active: false })
	h.tabs[2].active = true
	await h.log.tabActivated({ tabId: 3 })
	h.advance(3 * MIN)

	let seen
	const options = {
		frozenAt, offer: { tabs: [] },
		capture: async tabs => { seen = tabs.map(t => [t.id, t.lastAccessed]); return tabs.map(t => ({ id: `s${t.id}`, originalTabId: t.id, url: t.url, lastAccessed: t.lastAccessed })) },
		signals: (captured, at) => new Map(captured.map(c => [c.id, { clustered: true, clusterIdleMin: (at - t0) / MIN, offer: false }])),
	}
	assert.equal(await h.log.saveLabels([{ tabId: 1, label: 'important' }, { tabId: 2, label: 'close' }], options), 2)
	assert.deepEqual(seen, [[1, t0], [2, t0 - 50 * MIN]]) // the heuristic sees last-used times from page open
	let [pass] = (await h.log.exportLog()).labelPasses
	const byTab = Object.fromEntries(pass.tabs.map(row => [row.tabId, row]))
	assert.equal(pass.at, frozenAt)
	assert.deepEqual([byTab[1].idleMin, byTab[1].activations, byTab[1].activeMin, byTab[1].clusterIdleMin, byTab[1].inOffer], [65, 1, 5, 65, false])
	assert.deepEqual([byTab[2].idleMin, byTab[2].inOffer], [115, true]) // the offer as it was at page open
	// The AI's own picks, with idle time when the model saw the tab (not at page open).
	assert.deepEqual([byTab[1].aiPicked, byTab[1].aiIdleMin, byTab[2].aiPicked, byTab[2].aiIdleMin], [0, 55, 1, 105])

	// Saving again from the same page replaces its pass; without a freeze, it's judged now.
	await h.log.saveLabels([{ tabId: 1, label: 'either' }, { tabId: 2, label: 'close' }], options)
	let passes = (await h.log.exportLog()).labelPasses
	assert.deepEqual(passes.map(item => item.tabs[0].label), ['either'])
	await h.log.saveLabels([{ tabId: 1, label: 'either' }], { ...options, frozenAt: frozenAt - 1 })
	passes = (await h.log.exportLog()).labelPasses
	assert.equal(passes.length, 2)
	assert.deepEqual([passes[1].tabs[0].idleMin, passes[1].tabs[0].activations, passes[1].tabs[0].inOffer], [4, 2, false])
	// Without a freeze: a tab used since the AI ran has no pick; an expired or local suggestion gives none.
	await h.log.saveLabels([{ tabId: 1, label: 'either' }, { tabId: 2, label: 'close' }], { ...options, frozenAt: undefined, offer: aiPlan })
	const live = (await h.log.exportLog()).labelPasses[2].tabs
	assert.deepEqual(live.map(row => [row.aiPicked, row.aiIdleMin]), [[null, null], [1, 105]])
	await h.log.saveLabels([{ tabId: 2, label: 'close' }], { ...options, frozenAt: undefined, offer: { ...aiPlan, expired: true } })
	await h.log.saveLabels([{ tabId: 2, label: 'close' }], { ...options, frozenAt: undefined, offer: { ...aiPlan, mode: 'heuristic' } })
	assert.deepEqual((await h.log.exportLog()).labelPasses.slice(3).map(pass => pass.tabs[0].aiPicked), [null, null])
	await h.log.clear()
	assert.deepEqual(h.data, {})
})
