// Opt-in, local-only record of how tabs are actually treated: the human ground
// truth for keep/close rules. Per tab it keeps the registrable domain and
// timings only — never URLs, titles or page content — and nothing here is
// ever sent anywhere. The user exports it from Settings.
export const BEHAVIOR_OPEN_KEY = 'neatFreakBehaviorOpen'
export const BEHAVIOR_LOG_KEY = 'neatFreakBehaviorLog'
export const BEHAVIOR_LABELS_KEY = 'neatFreakBehaviorLabels'
export const BEHAVIOR_FREEZE_KEY = 'neatFreakBehaviorLabelFreeze' // the moment the label page opened
export const BEHAVIOR_MAX_AGE_MS = 30 * 86_400_000
export const BEHAVIOR_MAX_RECORDS = 2000
export const BEHAVIOR_MAX_BYTES = 550_000 // tab records, including their offer snapshots
export const BEHAVIOR_MAX_LABEL_BYTES = 200_000 // labelling passes; 750 KB in all
export const BEHAVIOR_MAX_VISITS = 8
export const BEHAVIOR_MAX_OFFERS = 6 // per tab: runs of the same offer decision
export const TAB_LABELS = ['important', 'either', 'close']
export const BEHAVIOR_MAX_CREDIT_MS = 30 * 60_000 // one uninterrupted stretch in front counts at most this
export const BEHAVIOR_SAVE_MATCH_MS = 2 * 60_000 // a removal this soon after a Neat Freak close is a save
const MAX_OPEN_RECORDS = 1000
const SEED_AFTER_MS = 10 * 60_000 // re-scan for untracked open tabs after a quiet spell or a pause
const NO_WINDOW = -1 // chrome.windows.WINDOW_ID_NONE: Chrome itself lost focus

// Not the full Public Suffix List: common two-part suffixes so e.g.
// bbc.co.uk and someone.github.io stay distinct from co.uk / github.io.
const TWO_PART_SUFFIXES = new Set([
	'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
	'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'co.in', 'org.in', 'com.br', 'com.mx',
	'com.ar', 'com.cn', 'com.hk', 'com.sg', 'com.tw', 'com.tr', 'co.za', 'co.il', 'com.my', 'com.ph',
	'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
	'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net',
])

export function registrableDomain(url) {
	let parsed
	try { parsed = new URL(url) } catch { return '(none)' }
	if (parsed.protocol === 'chrome-extension:') return '(extension)'
	if (/^(chrome|edge|brave|devtools):$/.test(parsed.protocol)) return '(browser)'
	if (parsed.protocol === 'file:') return '(file)'
	if (parsed.protocol === 'about:') return '(blank)'
	if (!/^https?:$/.test(parsed.protocol)) return '(other)'
	const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
	if (!host) return '(none)'
	if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '(ip)'
	if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost'
	const labels = host.split('.')
	if (labels.length <= 2) return host
	const lastTwo = labels.slice(-2).join('.')
	return labels.slice(TWO_PART_SUFFIXES.has(lastTwo) ? -3 : -2).join('.')
}

const OUTCOMES = new Set(['closed', 'saved', 'window-closed', 'unknown'])
const NUMBER_FIELDS = ['tabId', 'openedAt', 'activations', 'activeMs', 'navigations', 'discards', 'lastDiscardedAt', 'keeps', 'keptAt', 'lastKeptAt', 'endedAt', 'restoredAt']
const DOMAIN_PATTERN = /^(\([a-z]+\)|[a-z0-9.-]{1,253})$/

// Candidate features shared by offer snapshots and labelling passes. idleMin
// is what the heuristic sees (Chrome's lastAccessed; unknown counts as 0);
// activations and activeMin come from this log. Never titles or URLs.
const FEATURE_NUMBERS = ['idleMin', 'activations', 'activeMin', 'clusterIdleMin', 'contentScore']
const FEATURE_FLAGS = ['heuristic', 'duplicate', 'clustered', 'audible', 'unsaved', 'unreadable', 'discarded']
const OFFER_FLAGS = [...FEATURE_FLAGS, 'automatic', 'llm', 'manual']
const tenth = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null
const offeredIds = offer => offer && !offer.expired && Array.isArray(offer.tabs) ? offer.tabs.map(tab => tab.originalTabId) : null
const aiPickSet = plan => plan?.mode === 'llm' && Array.isArray(plan.aiPicks) ? new Set(plan.aiPicks) : null
const NO_AI_PICK = { aiPicked: null, aiIdleMin: null }

// The AI's own pick for one tab in a prepared suggestion, before its 30-minute
// recency guard: 1 or 0, and how long the tab had been idle when the model saw
// it. null when the suggestion wasn't the AI's, the tab wasn't shown to it, or
// the tab has been used since (the pick no longer describes it).
function aiPickOf(plan, tabId, lastAccessed) {
	const picks = !plan?.expired && Array.isArray(plan?.aiCandidates) && Number.isFinite(plan.createdAt) ? aiPickSet(plan) : null
	if (!picks || !plan.aiCandidates.includes(tabId) || lastAccessed > plan.createdAt) return NO_AI_PICK
	return { aiPicked: picks.has(tabId) ? 1 : 0, aiIdleMin: tenth(Number.isFinite(lastAccessed) ? (plan.createdAt - lastAccessed) / 60_000 : 0) }
}

function candidateFeatures({ live, saved, signal, record, at }) {
	const lastAccessed = saved?.lastAccessed ?? live?.lastAccessed
	return {
		idleMin: tenth(Number.isFinite(lastAccessed) ? Math.max(0, (at - lastAccessed) / 60_000) : 0),
		activations: record?.activations ?? 0,
		activeMin: tenth((record?.activeMs ?? 0) / 60_000),
		clusterIdleMin: tenth(signal?.clusterIdleMin),
		contentScore: signal?.contentScore ?? 0,
		heuristic: Boolean(signal?.offer), duplicate: Boolean(signal?.duplicate), clustered: Boolean(signal?.clustered),
		audible: Boolean(live?.audible ?? saved?.audible), unsaved: Boolean(saved?.hasUnsavedInput),
		unreadable: Boolean(saved?.signalsUnavailable), discarded: Boolean(live?.discarded),
	}
}

// Offer snapshots are stored as short arrays (they repeat on every prepared
// suggestion) and decoded to objects on export. aiPicked (1, 0, or null when
// the AI didn't run) is last, so rows stored before it decode as null.
const BITS_AT = 2 + FEATURE_NUMBERS.length
const AI_PICKED_AT = BITS_AT + 1
const MANUAL_BIT = 1 << OFFER_FLAGS.indexOf('manual')
const aiPickedValue = value => value === 1 || value === 0 ? value : null
function encodeOffer(row) {
	const bits = OFFER_FLAGS.reduce((sum, name, i) => sum | (row[name] ? 1 << i : 0), 0)
	return [row.at, row.offered ? 1 : 0, ...FEATURE_NUMBERS.map(name => row[name]), bits, aiPickedValue(row.aiPicked)]
}
function decodeOffer(row) {
	if (!Array.isArray(row) || !Number.isFinite(row[0])) return null
	const out = { at: Math.round(row[0]), offered: row[1] === 1 }
	FEATURE_NUMBERS.forEach((name, i) => { out[name] = tenth(row[2 + i]) })
	OFFER_FLAGS.forEach((name, i) => { out[name] = Boolean(row[BITS_AT] & (1 << i)) })
	out.aiPicked = aiPickedValue(row[AI_PICKED_AT])
	return out
}
// Same offer decision, same AI pick, same kind of run (suggestion or manual tidy).
const sameRun = (a, b) => a[1] === b[1] && aiPickedValue(a[AI_PICKED_AT]) === aiPickedValue(b[AI_PICKED_AT])
	&& (a[BITS_AT] & MANUAL_BIT) === (b[BITS_AT] & MANUAL_BIT)

function exportableLabelPass(pass) {
	if (!Number.isFinite(pass?.at) || !Array.isArray(pass.tabs)) return null
	return { at: Math.round(pass.at), offerReady: pass.offerReady === true, tabs: pass.tabs.filter(row => TAB_LABELS.includes(row?.label)).map(row => {
		const out = { label: row.label, inOffer: typeof row.inOffer === 'boolean' ? row.inOffer : null,
			aiPicked: aiPickedValue(row.aiPicked), aiIdleMin: tenth(row.aiIdleMin) }
		if (Number.isFinite(row.tabId)) out.tabId = row.tabId
		if (DOMAIN_PATTERN.test(row.domain || '')) out.domain = row.domain
		for (const name of FEATURE_NUMBERS) out[name] = tenth(row[name])
		for (const name of [...FEATURE_FLAGS, 'opener', 'pinned', 'active']) out[name] = row[name] === true
		return out
	}) }
}

export function retainLabelPasses(passes, at) {
	let kept = (Array.isArray(passes) ? passes : []).filter(pass => Number.isFinite(pass?.at) && pass.at >= at - BEHAVIOR_MAX_AGE_MS)
	while (kept.length && JSON.stringify(kept).length > BEHAVIOR_MAX_LABEL_BYTES) kept = kept.slice(1)
	return kept
}

// Allowlist on the way out, like diagnostics: whatever ends up in storage,
// only these fields can reach an export file.
function exportable(record) {
	const out = {}
	if (DOMAIN_PATTERN.test(record?.domain || '')) out.domain = record.domain
	for (const key of NUMBER_FIELDS) if (Number.isFinite(record?.[key])) out[key] = Math.round(record[key])
	for (const key of ['opener', 'pinned', 'seenLate']) if (typeof record?.[key] === 'boolean') out[key] = record[key]
	if (OUTCOMES.has(record?.outcome)) out.outcome = record.outcome
	out.visits = (Array.isArray(record?.visits) ? record.visits : []).slice(-BEHAVIOR_MAX_VISITS)
		.filter(visit => Array.isArray(visit) && Number.isFinite(visit[0]))
		.map(([start, end]) => [Math.round(start), Number.isFinite(end) ? Math.round(end) : null])
	const offers = (Array.isArray(record?.offers) ? record.offers : []).slice(-BEHAVIOR_MAX_OFFERS).map(decodeOffer).filter(Boolean)
	if (offers.length) out.offers = offers
	return out
}

// Finished records: drop by age, then count, then bytes (oldest first).
export function retainFinished(records, at) {
	let kept = (Array.isArray(records) ? records : [])
		.filter(record => Number.isFinite(record?.endedAt) && record.endedAt >= at - BEHAVIOR_MAX_AGE_MS)
		.slice(-BEHAVIOR_MAX_RECORDS)
	while (kept.length && JSON.stringify(kept).length > BEHAVIOR_MAX_BYTES) kept = kept.slice(Math.ceil(kept.length / 10))
	return kept
}

function newRecord(tab, at, seenLate) {
	const record = {
		tabId: tab.id, domain: registrableDomain(tab.pendingUrl || tab.url), openedAt: at,
		opener: Number.isInteger(tab.openerTabId), pinned: Boolean(tab.pinned),
		activations: 0, activeMs: 0, visits: [], navigations: 0, discards: 0, keeps: 0,
	}
	// Already open when the log first saw it: openedAt is first-seen time.
	if (seenLate) record.seenLate = true
	return record
}

// deps.storage is chrome.storage.local (or a fake with get/set/remove);
// deps.queryTabs(query) resolves to chrome.tabs.Tab[].
export function createBehaviorLog({ storage, enabled, queryTabs, now = Date.now }) {
	let queue = Promise.resolve()
	function serial(operation) {
		const next = queue.then(operation)
		queue = next.catch(() => {})
		return next
	}

	async function readOpen() {
		const stored = (await storage.get(BEHAVIOR_OPEN_KEY))?.[BEHAVIOR_OPEN_KEY]
		return {
			focus: stored?.focus?.tabId != null ? stored.focus : null,
			windowId: Number.isInteger(stored?.windowId) ? stored.windowId : null,
			seenAt: Number.isFinite(stored?.seenAt) ? stored.seenAt : null,
			tabs: stored?.tabs && typeof stored.tabs === 'object' ? stored.tabs : {},
		}
	}
	async function readFinished() {
		const stored = (await storage.get(BEHAVIOR_LOG_KEY))?.[BEHAVIOR_LOG_KEY]
		return Array.isArray(stored) ? stored : []
	}
	async function readLabels() {
		const stored = (await storage.get(BEHAVIOR_LABELS_KEY))?.[BEHAVIOR_LABELS_KEY]
		return Array.isArray(stored) ? stored : []
	}
	async function readFreeze() {
		const stored = (await storage.get(BEHAVIOR_FREEZE_KEY))?.[BEHAVIOR_FREEZE_KEY]
		return Number.isFinite(stored?.at) && stored.tabs && typeof stored.tabs === 'object' ? stored : null
	}

	// Every change is read → mutate → write, strictly in call order. That is
	// what lets markSaved(), queued just before chrome.tabs.remove, be seen by
	// the onRemoved event that follows it. Failures are swallowed: this log
	// must never get in the way of saving or closing tabs.
	function change(mutate) {
		return serial(async () => {
			if (!await enabled()) return false
			const at = now()
			const ctx = { at, open: await readOpen(), ended: [], finished: null, labels: null }
			ctx.loadFinished = async () => (ctx.finished ??= await readFinished())
			ctx.loadLabels = async () => (ctx.labels ??= await readLabels())
			// First event after opting in (or a long gap): pick up tabs that were
			// already open, so closing one of them still gets a label.
			const seeded = !(ctx.open.seenAt >= at - SEED_AFTER_MS) && await seed(ctx).then(() => true, () => false)
			if (await mutate(ctx) !== true && !seeded) return false
			ctx.open.seenAt = at
			const ids = Object.keys(ctx.open.tabs)
			if (ids.length > MAX_OPEN_RECORDS) {
				ids.sort((a, b) => ctx.open.tabs[a].openedAt - ctx.open.tabs[b].openedAt)
					.slice(0, ids.length - MAX_OPEN_RECORDS).forEach(id => { delete ctx.open.tabs[id] })
			}
			const values = { [BEHAVIOR_OPEN_KEY]: ctx.open }
			if (ctx.ended.length || ctx.finished) {
				values[BEHAVIOR_LOG_KEY] = retainFinished([...await ctx.loadFinished(), ...ctx.ended], at)
			}
			if (ctx.labels) values[BEHAVIOR_LABELS_KEY] = retainLabelPasses(ctx.labels, at)
			await storage.set(values)
			return true
		}).catch(() => false)
	}

	// Only ever adds records. Ending records for tabs that are gone is left to
	// reconcile(): the event being handled may be that tab's own removal.
	async function seed(ctx) {
		const live = (await queryTabs({})).filter(tab => !tab.incognito)
		for (const tab of live) ctx.open.tabs[tab.id] ??= newRecord(tab, ctx.at, true)
		return live
	}

	async function ensure(ctx, tabId) {
		if (ctx.open.tabs[tabId]) return ctx.open.tabs[tabId]
		const tab = (await queryTabs({})).find(item => item.id === tabId)
		if (!tab || tab.incognito) return null
		return (ctx.open.tabs[tabId] = newRecord(tab, ctx.at, true))
	}

	// Focus model: at most one tab is "in front" (the active tab of the focused
	// window). A visit runs from when a tab comes to the front until another tab
	// does; activeMs only accrues while Chrome itself has focus.
	function credit(ctx) {
		const focus = ctx.open.focus
		const record = focus && ctx.open.tabs[focus.tabId]
		if (record && Number.isFinite(focus.since)) {
			record.activeMs += Math.max(0, Math.min(ctx.at - focus.since, BEHAVIOR_MAX_CREDIT_MS))
		}
		if (focus) focus.since = null
	}
	function leave(ctx) {
		credit(ctx)
		const record = ctx.open.focus && ctx.open.tabs[ctx.open.focus.tabId]
		const visit = record?.visits.at(-1)
		if (visit && visit[1] === null) visit[1] = ctx.at
		ctx.open.focus = null
	}
	function front(ctx, record) {
		if (ctx.open.focus?.tabId === record.tabId) {
			ctx.open.focus.since ??= ctx.at // back from another app: same visit
			return
		}
		leave(ctx)
		record.activations += 1
		record.visits.push([ctx.at, null])
		if (record.visits.length > BEHAVIOR_MAX_VISITS) record.visits.splice(0, record.visits.length - BEHAVIOR_MAX_VISITS)
		ctx.open.focus = { tabId: record.tabId, since: ctx.at }
	}

	function finish(ctx, tabId, outcome) {
		const record = ctx.open.tabs[tabId]
		if (ctx.open.focus?.tabId === tabId) leave(ctx)
		delete ctx.open.tabs[tabId]
		if (!record) return false
		const saved = Number.isFinite(record.savingAt) && ctx.at - record.savingAt <= BEHAVIOR_SAVE_MATCH_MS
		delete record.savingAt
		ctx.ended.push({ ...record, outcome: saved && outcome !== 'unknown' ? 'saved' : outcome, endedAt: ctx.at })
		return true
	}

	function tabCreated(tab) {
		if (!Number.isInteger(tab?.id) || tab.incognito) return Promise.resolve(false)
		return change(ctx => {
			const existing = ctx.open.tabs[tab.id]
			if (existing && !(existing.seenLate && existing.activations === 0)) return false
			ctx.open.tabs[tab.id] = newRecord(tab, ctx.at, false)
			return true
		})
	}

	function tabActivated(info) {
		return change(async ctx => {
			const record = await ensure(ctx, info?.tabId)
			if (!record) return false
			front(ctx, record)
			if (ctx.open.windowId === NO_WINDOW) credit(ctx)
			return true
		})
	}

	function windowFocused(windowId) {
		return change(async ctx => {
			ctx.open.windowId = windowId
			if (windowId === NO_WINDOW) {
				credit(ctx)
				return true
			}
			const active = (await queryTabs({ active: true, windowId })).find(tab => tab.windowId === windowId)
			const record = active && await ensure(ctx, active.id)
			if (record) front(ctx, record)
			else credit(ctx) // devtools, a popup window, an incognito window
			return true
		})
	}

	function tabUpdated(tabId, changeInfo) {
		const relevant = changeInfo && (changeInfo.url || changeInfo.discarded === true || 'pinned' in changeInfo)
		if (!relevant) return Promise.resolve(false)
		return change(async ctx => {
			const record = await ensure(ctx, tabId)
			if (!record) return false
			if (changeInfo.url) {
				record.navigations += 1
				record.domain = registrableDomain(changeInfo.url)
			}
			if (changeInfo.discarded === true) { // Memory Saver (or another extension) unloaded it
				record.discards += 1
				record.lastDiscardedAt = ctx.at
			}
			if ('pinned' in changeInfo) record.pinned = Boolean(changeInfo.pinned)
			return true
		})
	}

	function tabRemoved(tabId, removeInfo) {
		return change(ctx => finish(ctx, tabId, removeInfo?.isWindowClosing ? 'window-closed' : 'closed'))
	}

	function tabReplaced(addedTabId, removedTabId) {
		return change(ctx => {
			const record = ctx.open.tabs[removedTabId]
			if (!record) return false
			delete ctx.open.tabs[removedTabId]
			ctx.open.tabs[addedTabId] = { ...record, tabId: addedTabId }
			if (ctx.open.focus?.tabId === removedTabId) ctx.open.focus.tabId = addedTabId
			return true
		})
	}

	// Neat Freak is about to close these tabs after saving them.
	function markSaved(tabIds) {
		return change(async ctx => {
			let changed = false
			for (const tabId of tabIds || []) {
				const record = await ensure(ctx, tabId)
				if (record) { record.savingAt = ctx.at; changed = true }
			}
			return changed
		})
	}

	// The user chose Keep for these suggested tabs (saved-tab objects).
	function kept(savedTabs) {
		return change(ctx => {
			let changed = false
			for (const tab of savedTabs || []) {
				const record = ctx.open.tabs[tab?.originalTabId]
				if (!record) continue
				record.keeps += 1
				record.keptAt ??= ctx.at // first Keep: the moment the suggestion was rejected
				record.lastKeptAt = ctx.at
				changed = true
			}
			return changed
		})
	}

	// Saved tabs reopened from a folder. Matched to the save by the original
	// Chrome tab id plus domain; the URL is only read here, never stored.
	function restored(savedTabs) {
		return change(async ctx => {
			const finished = await ctx.loadFinished()
			let changed = false
			for (const tab of savedTabs || []) {
				const domain = registrableDomain(tab?.url)
				const record = finished.findLast(item => item.tabId === tab?.originalTabId && item.domain === domain
					&& item.outcome === 'saved' && !Number.isFinite(item.restoredAt))
				if (record) { record.restoredAt = ctx.at; changed = true }
			}
			return changed
		})
	}

	// One prepared suggestion (automatic or Refresh), or a manual Smart tidy
	// (manual: offered = put away): every candidate, whether it was offered,
	// whether the AI picked it before its recency guard (plan.aiPicks), and the
	// numbers the heuristic decided on. candidates are captured saved-tab
	// objects; signals(candidates, at) runs only while recording.
	function offerSnapshot(candidates, plan, { automatic = false, manual = false, live = [], signals } = {}) {
		return change(async ctx => {
			if (!candidates?.length) return false
			const offered = new Set((plan?.tabs || []).map(tab => tab.originalTabId))
			const picks = aiPickSet(plan)
			const bySignal = signals?.(candidates, ctx.at) || new Map()
			const liveById = new Map((live || []).map(tab => [tab.id, tab]))
			for (const saved of candidates) {
				const tabId = saved.originalTabId
				if (!Number.isInteger(tabId)) continue
				const record = ctx.open.tabs[tabId] ??= newRecord({ id: tabId, url: saved.url, pinned: saved.pinned }, ctx.at, true)
				const row = encodeOffer({ at: ctx.at, offered: offered.has(tabId), automatic, manual, llm: plan?.mode === 'llm',
					aiPicked: picks ? Number(picks.has(tabId)) : null,
					...candidateFeatures({ live: liveById.get(tabId), saved, signal: bySignal.get(saved.id), record, at: ctx.at }) })
				record.offers ??= []
				const last = record.offers.at(-1)
				// One entry per run of the same decision, holding its latest state;
				// a visit to the tab in between starts a new run.
				if (last && sameRun(last, row) && !record.visits.some(visit => visit[0] > last[0])) record.offers[record.offers.length - 1] = row
				else record.offers.push(row)
				if (record.offers.length > BEHAVIOR_MAX_OFFERS) record.offers.splice(0, record.offers.length - BEHAVIOR_MAX_OFFERS)
			}
			return true
		})
	}

	// Called when label.html opens. Freezes each web tab as it is right now:
	// last used, in front or unloaded, and this log's counts. Save then judges
	// the pass at this moment, so opening a tab to check it while labelling
	// doesn't reset its idle time or add a visit. One freeze at a time, tab
	// ids and numbers only. Resolves to its timestamp, or null while off.
	function beginLabels({ offer } = {}) {
		return serial(async () => {
			if (!await enabled()) return null
			const plan = typeof offer === 'function' ? await offer().catch(() => null) : offer
			const at = now()
			const open = await readOpen()
			const tabs = {}
			for (const tab of await queryTabs({})) {
				if (tab.incognito || !/^https?:/.test(tab.url || '')) continue
				const record = open.tabs[tab.id]
				const inFront = open.focus?.tabId === tab.id && Number.isFinite(open.focus.since)
					? Math.max(0, Math.min(at - open.focus.since, BEHAVIOR_MAX_CREDIT_MS)) : 0
				tabs[tab.id] = {
					lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null, active: Boolean(tab.active),
					discarded: Boolean(tab.discarded), activations: record?.activations ?? 0, activeMs: (record?.activeMs ?? 0) + inFront,
					...aiPickOf(plan, tab.id, tab.lastAccessed),
				}
			}
			await storage.set({ [BEHAVIOR_FREEZE_KEY]: { at, offered: offeredIds(plan), tabs } })
			return at
		}).catch(() => null)
	}

	// A labelling pass from label.html: the user's own call on each open tab
	// (important / either / close). Features are those of the moment the page
	// opened (frozenAt, from beginLabels), or of now without one. Titles shown
	// on the page are never stored. Resolves to the number saved.
	async function saveLabels(labels, { capture, signals, offer, frozenAt } = {}) {
		if (!await enabled().catch(() => false)) return 0
		const wanted = new Map((labels || []).filter(item => TAB_LABELS.includes(item?.label) && Number.isInteger(item?.tabId))
			.map(item => [item.tabId, item.label]))
		const web = (await queryTabs({})).filter(tab => !tab.incognito && /^https?:/.test(tab.url || ''))
		const live = web.filter(tab => wanted.has(tab.id))
		if (!live.length) return 0
		const freeze = Number.isFinite(frozenAt) ? await readFreeze().catch(() => null) : null
		const frozen = freeze?.at === frozenAt ? freeze : null
		const at = frozen?.at ?? now()
		const was = tab => frozen?.tabs[tab.id]
		// A tab as it was when the page opened; tabs opened since are left out.
		const asOf = tab => was(tab) ? { ...tab, lastAccessed: was(tab).lastAccessed ?? undefined, active: was(tab).active, discarded: was(tab).discarded } : tab
		// All open candidates, as for a prepared suggestion: clusters depend on
		// the whole set, so the heuristic flag matches what it would have done.
		const candidates = web.filter(tab => !frozen || was(tab)).map(asOf).filter(tab => !tab.active && !tab.pinned)
		const captured = capture ? await capture(candidates) : []
		const bySignal = signals && captured.length ? signals(captured, at) : new Map()
		const savedById = new Map(captured.map(saved => [saved.originalTabId, saved]))
		const offeredList = frozen ? frozen.offered : offeredIds(offer)
		const offered = Array.isArray(offeredList) ? new Set(offeredList) : null
		const written = await change(async ctx => {
			const tabs = live.map(liveTab => {
				const tab = asOf(liveTab)
				const saved = savedById.get(tab.id)
				const current = ctx.open.tabs[tab.id]
				const record = was(tab) ? { ...current, activations: was(tab).activations, activeMs: was(tab).activeMs } : current
				return {
					tabId: tab.id, domain: registrableDomain(tab.url), label: wanted.get(tab.id),
					inOffer: offered ? offered.has(tab.id) : null,
					...(frozen ? { aiPicked: was(tab)?.aiPicked ?? null, aiIdleMin: was(tab)?.aiIdleMin ?? null } : aiPickOf(offer, tab.id, tab.lastAccessed)),
					opener: Boolean(record?.opener), pinned: Boolean(tab.pinned), active: Boolean(tab.active),
					...candidateFeatures({ live: tab, saved, signal: saved && bySignal.get(saved.id), record, at }),
				}
			})
			const passes = await ctx.loadLabels()
			const pass = { at, offerReady: Boolean(offered), tabs }
			// Saving again from the same page replaces its pass rather than adding a copy.
			const same = frozen ? passes.findIndex(item => item.at === at) : -1
			if (same >= 0) passes[same] = pass
			else passes.push(pass)
			return true
		})
		return written ? live.length : 0
	}

	// Close out records for tabs that ended while unobserved (browser quit,
	// logging paused) and start records for open tabs the log hasn't seen.
	// Run at browser startup and before export — never on every worker wake,
	// where the event that woke the worker may be the removal itself.
	function reconcile() {
		return change(async ctx => {
			const liveIds = new Set((await seed(ctx)).map(tab => String(tab.id)))
			for (const tabId of Object.keys(ctx.open.tabs)) {
				if (!liveIds.has(tabId)) finish(ctx, Number(tabId), 'unknown')
			}
			return true
		})
	}

	async function exportLog() {
		await reconcile() // no-op while recording is off; the liveness check below still applies
		return serial(async () => {
			const at = now()
			const open = await readOpen()
			const live = await queryTabs({}).then(tabs => new Set(tabs.map(tab => tab.id)), () => null)
			const openRecords = Object.values(open.tabs).map(record => {
				const copy = structuredClone(record)
				if (live && !live.has(record.tabId)) return { ...copy, outcome: 'unknown', endedAt: at }
				if (open.focus?.tabId === record.tabId && Number.isFinite(open.focus.since)) {
					copy.activeMs += Math.max(0, Math.min(at - open.focus.since, BEHAVIOR_MAX_CREDIT_MS))
				}
				return copy
			})
			return {
				kind: 'neat-freak-tab-behavior', schemaVersion: 2, exportedAt: at, enabled: await enabled(),
				retentionDays: BEHAVIOR_MAX_AGE_MS / 86_400_000, maxRecords: BEHAVIOR_MAX_RECORDS,
				records: [...retainFinished(await readFinished(), at), ...openRecords].map(exportable),
				labelPasses: retainLabelPasses(await readLabels(), at).map(exportableLabelPass).filter(Boolean),
			}
		})
	}

	function clear() {
		return serial(() => storage.remove([BEHAVIOR_OPEN_KEY, BEHAVIOR_LOG_KEY, BEHAVIOR_LABELS_KEY, BEHAVIOR_FREEZE_KEY]))
	}

	// Register synchronously at the service worker's top level (MV3 rule).
	function attach(api) {
		api.tabs?.onCreated?.addListener(tab => tabCreated(tab))
		api.tabs?.onActivated?.addListener(info => tabActivated(info))
		api.tabs?.onUpdated?.addListener((tabId, changeInfo) => tabUpdated(tabId, changeInfo))
		api.tabs?.onRemoved?.addListener((tabId, removeInfo) => tabRemoved(tabId, removeInfo))
		api.tabs?.onReplaced?.addListener((addedTabId, removedTabId) => tabReplaced(addedTabId, removedTabId))
		api.windows?.onFocusChanged?.addListener(windowId => windowFocused(windowId))
		api.runtime?.onStartup?.addListener(() => reconcile())
	}

	return {
		attach, tabCreated, tabActivated, windowFocused, tabUpdated, tabRemoved, tabReplaced,
		markSaved, kept, restored, offerSnapshot, beginLabels, saveLabels, reconcile, exportLog, clear,
	}
}
