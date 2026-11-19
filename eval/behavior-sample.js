// Writes a SYNTHETIC tab-habits export for trying eval/behavior-rules.js before
// real data exists. It replays two scripted weeks of made-up browsing through
// the real recorder (src/behavior-log.js) with a fake clock and fake storage,
// so the file has exactly the shape of a Settings export. Suggestions come from
// the real heuristic (smart-scope.js) run on made-up titles: automatic ones at
// 11:00 and 14:00, a reviewed one at 17:30, and a labelling pass at 15:00.
// Not real behaviour.
//
// Run:  node eval/behavior-sample.js > /tmp/tab-habits-sample.json
//       node eval/behavior-rules.js /tmp/tab-habits-sample.json

import { pathToFileURL } from 'node:url'
import { createBehaviorLog } from '../src/behavior-log.js'
import { heuristicSignals } from '../src/smart-scope.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// fate: close = you close it after `closeAfterH` idle; keep = you leave it
// open and choose Keep if suggested; idle = you never get round to it.
const TOPICS = ['alpha budget review', 'beta launch checklist', 'gamma hiring loop', 'delta tax filing', 'epsilon trip planning']
const PERSONAS = [
	{ host: 'github.com', weight: 4, opener: 0.6, visits: [2, 6], fates: { close: 0.55, keep: 0.35, idle: 0.1 }, closeAfterH: [0.2, 8] },
	{ host: 'stackoverflow.com', weight: 3, opener: 0.9, visits: [1, 2], fates: { close: 0.85, idle: 0.15 }, closeAfterH: [0.05, 2] },
	{ host: 'www.nytimes.com', weight: 2, opener: 0.8, visits: [0, 1], fates: { close: 0.4, idle: 0.6 }, closeAfterH: [1, 30] },
	{ host: 'www.youtube.com', weight: 2, opener: 0.5, visits: [1, 2], fates: { close: 0.8, idle: 0.2 }, closeAfterH: [0.1, 3] },
	{ host: 'docs.google.com', weight: 3, opener: 0.4, visits: [3, 9], fates: { keep: 0.7, close: 0.3 }, closeAfterH: [4, 48] },
	{ host: 'www.notion.so', weight: 1, opener: 0.2, visits: [2, 6], fates: { keep: 0.8, close: 0.2 }, closeAfterH: [8, 72] },
	{ host: 'www.amazon.com', weight: 1, opener: 0.7, visits: [1, 3], fates: { close: 0.6, idle: 0.4 }, closeAfterH: [0.5, 24] },
]

function rng(seed) {
	return () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648)
}

export async function buildSample({ days = 14, seed = 7 } = {}) {
	const random = rng(seed)
	const between = ([low, high]) => low + random() * (high - low)
	const pick = weights => {
		let roll = random() * Object.values(weights).reduce((a, b) => a + b, 0)
		for (const [key, weight] of Object.entries(weights)) if ((roll -= weight) <= 0) return key
		return Object.keys(weights)[0]
	}
	const start = Date.UTC(2026, 9, 26, 8)
	let clock = start
	const data = {}
	const tabs = new Map() // live fake chrome tabs
	const log = createBehaviorLog({
		storage: {
			async get(key) { return { [key]: structuredClone(data[key]) } },
			async set(values) { Object.assign(data, structuredClone(values)) },
			async remove(keys) { for (const key of keys) delete data[key] },
		},
		enabled: async () => true,
		now: () => clock,
		queryTabs: async query => [...tabs.values()].filter(tab => !query.active || tab.active).map(tab => ({ ...tab })),
	})

	// Build a timeline of events, then replay it in time order.
	const events = []
	const at = (time, run) => events.push({ time, run })
	let nextId = 100
	const sim = new Map() // tabId -> { fate, lastSeen }
	function openTab(time, persona, fate, fromRestore = false) {
		const id = nextId++
		const opener = !fromRestore && random() < persona.opener
		const title = `${TOPICS[Math.floor(random() * TOPICS.length)]} ${persona.host.split('.').at(-2)} ${id}`
		sim.set(id, { fate, persona, lastSeen: time, open: true })
		at(time, async () => {
			const tab = { id, windowId: 1, url: `https://${persona.host}/page-${id}`, title, active: false, pinned: false, lastAccessed: time }
			if (opener) tab.openerTabId = 1
			tabs.set(id, tab)
			await log.tabCreated(tab)
		})
		let time2 = time + between([0.5, 20]) * MIN
		const visits = fromRestore ? 1 : Math.round(between(persona.visits))
		for (let v = 0; v < visits; v += 1) {
			const visitAt = time2
			at(visitAt, async () => {
				if (!tabs.has(id)) return
				for (const tab of tabs.values()) tab.active = tab.id === id
				tabs.get(id).lastAccessed = visitAt
				sim.get(id).lastSeen = visitAt
				await log.tabActivated({ tabId: id, windowId: 1 })
			})
			time2 += between([5, 6 * 60]) * MIN
		}
		if (fate === 'close') {
			const closeAt = time2 + between(persona.closeAfterH) * HOUR
			at(closeAt, async () => {
				if (!tabs.has(id)) return
				tabs.delete(id)
				sim.get(id).open = false
				await log.tabRemoved(id, { isWindowClosing: false })
			})
		}
	}

	// A prepared suggestion: the real heuristic over every inactive tab, minus
	// tabs you already chose to Keep (the extension excludes those too).
	const asCandidate = tab => ({ id: `saved-${tab.id}`, originalTabId: tab.id, url: tab.url, title: tab.title,
		domain: new URL(tab.url).hostname, lastAccessed: tab.lastAccessed, pinned: false })
	let currentPlan = null
	async function prepare(automatic) {
		const candidates = [...tabs.values()].filter(tab => !tab.active).map(asCandidate)
		const signals = heuristicSignals(candidates, clock)
		currentPlan = { mode: 'heuristic', expired: false,
			tabs: candidates.filter(c => signals.get(c.id).offer && !sim.get(c.originalTabId).kept) }
		await log.offerSnapshot(candidates, currentPlan, { automatic, live: [...tabs.values()], signals: heuristicSignals })
		return currentPlan
	}
	const LABEL_ODDS = { keep: { important: 0.7, either: 0.3 }, idle: { close: 0.6, either: 0.4 }, close: { close: 0.5, either: 0.5 } }

	for (let day = 0; day < days; day += 1) {
		const morning = start + day * DAY
		at(morning, () => log.windowFocused(1))
		at(morning + 10 * HOUR, () => log.windowFocused(-1)) // evenings away from Chrome
		const opened = 12 + Math.floor(random() * 10)
		const weights = Object.fromEntries(PERSONAS.map((persona, i) => [i, persona.weight]))
		for (let i = 0; i < opened; i += 1) {
			const persona = PERSONAS[pick(weights)]
			openTab(morning + random() * 9 * HOUR, persona, pick(persona.fates))
		}
		// Memory Saver unloads some long-idle tabs in the afternoon.
		at(morning + 6 * HOUR, async () => {
			for (const [id, state] of sim) {
				if (state.open && tabs.has(id) && clock - state.lastSeen > 4 * HOUR && random() < 0.3) {
					await log.tabUpdated(id, { discarded: true })
				}
			}
		})
		at(morning + 3 * HOUR, () => prepare(true))
		at(morning + 6 * HOUR + 1, () => prepare(true))
		// Labelling pass: your own call on each open tab; about 1 in 10 skipped.
		at(morning + 7 * HOUR, async () => {
			const labels = []
			for (const [id, state] of sim) {
				if (state.open && tabs.has(id) && random() > 0.1) labels.push({ tabId: id, label: pick(LABEL_ODDS[state.fate]) })
			}
			await log.saveLabels(labels, { capture: async list => list.map(asCandidate), signals: heuristicSignals, offer: currentPlan })
		})
		// Evening review of a fresh suggestion: you Keep most of the tabs you
		// want, a few slip through, and the rest are saved and closed.
		at(morning + 9.5 * HOUR, async () => {
			const plan = await prepare(false)
			currentPlan = null // used up by the review
			for (const { originalTabId: id } of plan.tabs) {
				const state = sim.get(id)
				if (state.fate === 'keep' && random() < 0.75) {
					await log.kept([{ originalTabId: id }])
					state.kept = true
					continue
				}
				const url = tabs.get(id).url
				log.markSaved([id])
				tabs.delete(id)
				state.open = false
				await log.tabRemoved(id, {})
				const mistake = state.fate === 'keep' && random() < 0.8
				const later = state.fate === 'idle' && random() < 0.1
				if (mistake || later) { // next morning (a wrong save) or days later (the save did its job)
					const back = clock + (mistake ? between([10, 14]) * HOUR : between([2, 4]) * DAY)
					events.push({ time: back, run: async () => {
						await log.restored([{ originalTabId: id, url }])
					} })
					openTab(back + MIN, state.persona, random() < 0.5 ? 'keep' : 'close', true)
				}
			}
		})
	}

	// Replay; events added during replay (restores) are merged in time order.
	while (events.length) {
		events.sort((a, b) => a.time - b.time)
		const event = events.shift()
		clock = event.time
		await event.run()
	}
	clock = start + days * DAY
	return log.exportLog()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.log(JSON.stringify(await buildSample(), null, 2))
}
