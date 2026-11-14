// Offline keep/close rules from a tab-habits export
// (Settings -> Tab habits log -> Export tab habits). Nothing is sent anywhere.
//
// Run:  node eval/behavior-rules.js <neat-freak-tab-habits-YYYY-MM-DD.json>
//         [--rule='idleMin >= 720 && activations <= 1'] [--open-as-keep] [--min-domain=3]
//
// 1. Your labels (label.html) are the gold standard: Important must never be
//    offered (the gate), Close not offered is a miss, Either way is fine both ways.
// 2. Every prepared suggestion is checked against what you did next:
//    offered, then Keep or restored within 7 days    wrong offer
//    offered, then closed and not restored in 7 days right offer
//    not offered, then closed by hand, unused since  miss
//    not offered, then used again                    right keep
// Both replay the shipped heuristic and rule tweaks on the stored numbers
// (never titles or URLs). --rule takes a JS expression over the feature names
// in FEATURE_NAMES; protected tabs are never offered, whatever the rule says.
//
// 3-6 describe tabs you closed yourself, using these labels:
//   close  closed by you, or saved by Neat Freak and not restored within 7 days
//   keep   Keep in review, or restored within 7 days of a save
//   --open-as-keep also counts tabs still open after a day as keep. Off by
//   default: an untouched old tab may be one you never got round to closing.
// Features there are measured at the decision (close, save, Keep, or export).
// "Idle" is time since the tab was last in front; for a tab closed while in
// front, it is the gap before that final visit.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const RESTORE_WINDOW_MS = 7 * DAY // restored within this: the save was wrong; past it: right
export const OPEN_KEEP_MIN_AGE_MS = DAY
const IN_FRONT_SLACK_MS = 5_000

export function duration(ms) {
	if (!Number.isFinite(ms)) return '—'
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`
	if (ms < HOUR) return `${Math.round(ms / 60_000)}m`
	if (ms < DAY) return `${(ms / HOUR).toFixed(1)}h`
	return `${(ms / DAY).toFixed(1)}d`
}

export function decisionOf(record, exportedAt, { openAsKeep = false } = {}) {
	if (record.outcome === 'closed') return { label: 'close', source: 'closed', at: record.endedAt }
	if (record.outcome === 'saved') {
		const restored = Number.isFinite(record.restoredAt)
		if (restored && record.restoredAt - record.endedAt <= RESTORE_WINDOW_MS) return { label: 'keep', source: 'restored', at: record.endedAt }
		if (restored || exportedAt - record.endedAt >= RESTORE_WINDOW_MS) return { label: 'close', source: 'saved', at: record.endedAt }
		return null // saved less than 7 days ago: could still be restored
	}
	if (record.keeps > 0 && Number.isFinite(record.keptAt)) return { label: 'keep', source: 'kept', at: record.keptAt }
	if (!record.outcome && openAsKeep && exportedAt - record.openedAt >= OPEN_KEEP_MIN_AGE_MS) {
		return { label: 'keep', source: 'open', at: exportedAt }
	}
	return null // window closed, unknown end, or still open
}

export function featuresAt(record, at) {
	const visits = (record.visits || []).filter(visit => visit[0] <= at)
	const last = visits.at(-1)
	const inFront = Boolean(last && (last[1] === null || last[1] > at || at - last[1] <= IN_FRONT_SLACK_MS))
	const idleMs = !last ? at - record.openedAt
		: inFront ? last[0] - (visits.at(-2)?.[1] ?? record.openedAt)
			: at - last[1]
	const later = (record.visits || []).length - visits.length
	return {
		idleH: Math.max(0, idleMs) / HOUR,
		ageH: Math.max(0, at - record.openedAt) / HOUR,
		activations: Math.max(0, (record.activations || 0) - later),
		activeMin: (record.activeMs || 0) / 60_000,
		opener: record.opener ? 1 : 0,
		discarded: Number.isFinite(record.lastDiscardedAt) && record.lastDiscardedAt <= at ? 1 : 0,
		pinned: record.pinned ? 1 : 0,
		inFront,
	}
}

export function labelledRows(report, options) {
	return report.records.flatMap(record => {
		const decision = decisionOf(record, report.exportedAt, options)
		if (!decision) return []
		return [{ record, ...decision, y: decision.label === 'close' ? 1 : 0, x: featuresAt(record, decision.at) }]
	})
}

// --- Policies replayed on stored numbers -------------------------------------

export const FEATURE_NAMES = ['idleMin', 'activations', 'activeMin', 'clusterIdleMin', 'contentScore', 'heuristic',
	'duplicate', 'clustered', 'audible', 'unsaved', 'unreadable', 'discarded', 'opener', 'pinned', 'active', 'domain']

// Never offered by any policy, as in the extension: the active or pinned tab,
// one playing audio, one with unsent input, or one the page check couldn't read.
export const isProtected = f => Boolean(f.active || f.pinned || f.audible || f.unsaved || f.unreadable)

// The shipped proactive heuristic (smart-scope.js applySmartHeuristic):
// older URL duplicates, or clustered tabs idle past 30 min (cold cluster) /
// 90 min (cluster used in the last 30 min). Unclustered tabs are kept.
export const replayHeuristic = f => Boolean(f.duplicate || (f.clustered && f.idleMin > (f.clusterIdleMin <= 30 ? 90 : 30)))

export const POLICIES = [
	{ name: 'heuristic (replayed)', offer: replayHeuristic },
	// Proactive mode skips the work-surface check (docs, mail, carts...) that
	// the manual-tidy fallback applies; this adds it back.
	{ name: 'heuristic, not work surfaces', offer: f => replayHeuristic(f) && f.contentScore > -2 },
	{ name: 'heuristic, idle 4h+', offer: f => replayHeuristic(f) && f.idleMin >= 240 },
	{ name: 'heuristic, idle 12h+', offer: f => replayHeuristic(f) && f.idleMin >= 720 },
	{ name: 'heuristic + any idle 1d+', offer: f => replayHeuristic(f) || f.idleMin >= 1440 },
	{ name: 'heuristic + idle 1d+ seen <=1x', offer: f => replayHeuristic(f) || (f.idleMin >= 1440 && f.activations <= 1) },
	{ name: 'any idle 12h+', offer: f => f.idleMin >= 720 },
]

export function compileRule(expression) {
	const fn = new Function(...FEATURE_NAMES, `return Boolean(${expression})`)
	return { name: expression, offer: f => fn(...FEATURE_NAMES.map(name => f[name])) }
}

export const offers = (policy, features) => !isProtected(features) && policy.offer(features)

// Label one stored offer snapshot (a run of identical decisions, holding its
// latest state) from what happened to the tab afterwards.
export function offerLabel(record, snap, exportedAt) {
	const usedAgain = (record.visits || []).some(visit => visit[0] > snap.at)
	const ended = record.outcome && record.endedAt >= snap.at ? record.outcome : null
	if (snap.offered) {
		const keptAt = record.lastKeptAt ?? record.keptAt
		if (Number.isFinite(keptAt) && keptAt >= snap.at) return 'wrong'
		if (ended === 'saved') {
			if (Number.isFinite(record.restoredAt)) return record.restoredAt - record.endedAt <= RESTORE_WINDOW_MS ? 'wrong' : 'right'
			return exportedAt - record.endedAt >= RESTORE_WINDOW_MS ? 'right' : 'pending'
		}
		if (ended === 'closed') return 'right'
		return usedAgain ? 'ignored' : 'pending'
	}
	if (usedAgain) return 'keep'
	if (ended === 'closed') return 'miss'
	return 'pending'
}

export function offerEntries(report) {
	return report.records.flatMap(record => (record.offers || []).map(snap => ({
		record, snap, label: offerLabel(record, snap, report.exportedAt),
		features: { ...snap, domain: record.domain, opener: Boolean(record.opener), pinned: false, active: false },
	})))
}

export function goldRows(report) {
	return (report.labelPasses || []).flatMap(pass => pass.tabs.map(row => ({ ...row, at: pass.at })))
}

const FEATURES = {
	idleH: { name: 'idle', show: h => duration(h * HOUR) },
	ageH: { name: 'age', show: h => duration(h * HOUR) },
	activations: { name: 'times in front', integer: true },
	activeMin: { name: 'time in front', show: m => duration(m * 60_000) },
	opener: { name: 'opened from another tab', bool: true },
	discarded: { name: 'unloaded by Memory Saver', bool: true },
	pinned: { name: 'pinned', bool: true },
}

function condition(feature, threshold, above) {
	const spec = FEATURES[feature]
	if (spec.bool) return above ? spec.name : `not ${spec.name}`
	if (spec.integer) return `${spec.name} ${above ? '>=' : '<='} ${Math.ceil(threshold) - (above ? 0 : 1)}`
	return `${spec.name} ${above ? '>=' : '<'} ${spec.show(threshold)}`
}

const gini = rows => {
	if (!rows.length) return 0
	const p = rows.reduce((sum, row) => sum + row.y, 0) / rows.length
	return 2 * p * (1 - p)
}

function bestSplit(rows, minLeaf) {
	let best = null
	for (const feature of Object.keys(FEATURES)) {
		const values = [...new Set(rows.map(row => row.x[feature]))].sort((a, b) => a - b)
		const step = Math.max(1, Math.floor(values.length / 64))
		for (let i = step; i < values.length; i += step) {
			const threshold = (values[i - 1] + values[i]) / 2
			const below = rows.filter(row => row.x[feature] < threshold)
			const above = rows.filter(row => row.x[feature] >= threshold)
			if (below.length < minLeaf || above.length < minLeaf) continue
			const score = (below.length * gini(below) + above.length * gini(above)) / rows.length
			if (!best || score < best.score) best = { feature, threshold, below, above, score }
		}
	}
	return best && best.score < gini(rows) - 1e-9 ? best : null
}

export function growTree(rows, { maxDepth = 3, minLeaf = 5 } = {}, depth = 0) {
	const node = { n: rows.length, closes: rows.reduce((sum, row) => sum + row.y, 0) }
	if (depth >= maxDepth || node.closes === 0 || node.closes === node.n) return node
	const split = bestSplit(rows, minLeaf)
	if (!split) return node
	const above = growTree(split.above, { maxDepth, minLeaf }, depth + 1)
	const below = growTree(split.below, { maxDepth, minLeaf }, depth + 1)
	// A split whose two leaves say the same thing adds no rule; drop it.
	if (!above.feature && !below.feature && verdict(above) === verdict(below)) return node
	return Object.assign(node, { feature: split.feature, threshold: split.threshold, above, below })
}

const verdict = node => node.closes * 2 >= node.n ? 'CLOSE' : 'KEEP'

const pct = (part, whole) => whole ? `${Math.round(100 * part / whole)}%` : '—'
const stats = node => `${node.n} tabs, ${pct(node.closes, node.n)} close`

export function printTree(node, indent = '') {
	if (!node.feature) return [`${indent}-> ${verdict(node)}  (${stats(node)})`]
	return [
		`${indent}if ${condition(node.feature, node.threshold, true)}:   (${stats(node.above)})`,
		...printTree(node.above, indent + '    '),
		`${indent}else, ${condition(node.feature, node.threshold, false)}:   (${stats(node.below)})`,
		...printTree(node.below, indent + '    '),
	]
}

function quantile(values, q) {
	if (!values.length) return NaN
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function table(headers, rows) {
	const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => String(row[i]).length)))
	const line = cells => cells.map((cell, i) => i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i])).join('  ')
	return [line(headers), ...rows.map(line)]
}

function timesInFrontBreakdown(rows) {
	const n = rows.length
	const count = test => pct(rows.filter(test).length, n)
	return `never ${count(row => row.x.activations === 0)} · once ${count(row => row.x.activations === 1)} · 2-3 times ${count(row => row.x.activations >= 2 && row.x.activations <= 3)} · 4+ ${count(row => row.x.activations >= 4)}`
}

function goldSection(report, policies) {
	const rows = goldRows(report)
	const by = label => rows.filter(row => row.label === label)
	const [important, either, close] = [by('important'), by('either'), by('close')]
	const out = ['', `1. Your labels (gold standard): ${(report.labelPasses || []).length} passes, ${rows.length} tabs: Important ${important.length} · Either way ${either.length} · Close ${close.length}`]
	if (!rows.length) return [...out, '   None yet. Settings -> Tab habits log -> Label open tabs.']
	const cell = (list, test) => `${list.filter(test).length}/${list.length}`
	const line = (name, offered, subset = row => true) => [`   ${name}`,
		cell(important.filter(subset), offered), cell(close.filter(subset), row => !offered(row)), cell(either.filter(subset), offered)]
	const lines = []
	if (rows.some(row => row.inOffer !== null)) lines.push(line('offered at the time*', row => row.inOffer === true, row => row.inOffer !== null))
	lines.push(line('heuristic (live)', row => row.heuristic))
	for (const policy of policies) lines.push(line(policy.name, row => offers(policy, row)))
	out.push(...table(['   policy', 'Important offered (gate, must be 0)', 'Close not offered (misses)', 'Either way offered'], lines))
	if (rows.some(row => row.inOffer !== null)) out.push('   * only passes saved while a suggestion was prepared')
	const mismatched = rows.filter(row => row.heuristic !== offers(policies[0], row)).length
	if (mismatched && policies[0] === POLICIES[0]) out.push(`   Replay check: replayed heuristic differs from the live one on ${mismatched} tabs.`)
	return out
}

function offerSection(report, policies) {
	const entries = offerEntries(report)
	const tabs = list => new Set(list.map(entry => entry.record)).size
	const out = ['', `2. Suggestions vs what you did next: ${tabs(entries)} tabs were candidates (counts are tabs)`]
	if (!entries.length) return [...out, '   None yet. Prepared suggestions (automatic or Refresh) are recorded while the log is on.']
	const where = (label, offered) => entries.filter(entry => entry.label === label && (offered === undefined || entry.snap.offered === offered))
	const [right, wrong, miss, keep] = ['right', 'wrong', 'miss', 'keep'].map(label => where(label))
	out.push(`   offered:     right ${tabs(right)} · wrong ${tabs(wrong)} · not acted on yet ${tabs(where('pending', true))} · shown, then used again ${tabs(where('ignored'))}`)
	out.push(`   not offered: missed ${tabs(miss)} · right keep ${tabs(keep)} · undecided ${tabs(where('pending', false))}`)
	out.push(`   Wrong-offer rate: ${tabs(wrong)}/${tabs(wrong) + tabs(right)} = ${pct(tabs(wrong), tabs(wrong) + tabs(right))} (the gate: should be near 0). Misses: ${tabs(miss)}.`)
	out.push('', '   Replayed on the stored numbers (vs what was offered):')
	out.push(...table(['   policy', 'misses recovered', 'wrong offers added', 'wrong offers avoided', 'right offers lost', 'wrong-offer rate'], policies.map(policy => {
		const yes = list => list.filter(entry => offers(policy, entry.features))
		const no = list => list.filter(entry => !offers(policy, entry.features))
		const badNow = tabs(yes(wrong)) + tabs(yes(keep))
		const goodNow = tabs(yes(right)) + tabs(yes(miss))
		return [`   ${policy.name}`, `${tabs(yes(miss))}/${tabs(miss)}`, `${tabs(yes(keep))}/${tabs(keep)}`,
			`${tabs(no(wrong))}/${tabs(wrong)}`, `${tabs(no(right))}/${tabs(right)}`, pct(badNow, badNow + goodNow)]
	})))
	return out
}

export function analyse(report, { openAsKeep = false, minDomain = 3, rules = [] } = {}) {
	const out = []
	const records = report.records
	const at = report.exportedAt
	const first = Math.min(...records.map(record => record.openedAt))
	const day = ms => new Date(ms).toISOString().slice(0, 10)
	const outcome = record => record.outcome || 'open'
	const count = test => records.filter(test).length
	out.push(`Neat Freak tab habits: ${records.length} tabs, ${day(first)} to ${day(at)}`)
	out.push(`Outcomes: closed by you ${count(r => r.outcome === 'closed')} · saved by Neat Freak ${count(r => r.outcome === 'saved')} (restored ${count(r => Number.isFinite(r.restoredAt))}) · window closed ${count(r => r.outcome === 'window-closed')} · unknown end ${count(r => r.outcome === 'unknown')} · still open ${count(r => !r.outcome)}`)

	const rows = labelledRows(report, { openAsKeep })
	const sources = {}
	for (const row of rows) sources[row.source] = (sources[row.source] || 0) + 1
	const closes = rows.filter(row => row.y === 1)
	const keeps = rows.filter(row => row.y === 0)
	const policies = [...POLICIES, ...rules.map(compileRule)]
	out.push(...goldSection(report, policies), ...offerSection(report, policies))

	out.push('', `Outcome labels for 3-6: close ${closes.length} (closed ${sources.closed || 0}, saved ${sources.saved || 0}) · keep ${keeps.length} (Keep ${sources.kept || 0}, restored within ${duration(RESTORE_WINDOW_MS)} ${sources.restored || 0}${openAsKeep ? `, open over ${duration(OPEN_KEEP_MIN_AGE_MS)} ${sources.open || 0}` : ''})`)
	if (keeps.length) out.push('  Keep and restore labels exist only for tabs Neat Freak suggested, so they lean towards idle tabs.')
	if (keeps.length < 10) {
		out.push(`  Note: only ${keeps.length} keep labels. Sections 5-6 mostly describe when you close tabs. ${openAsKeep ? '' : 'Try --open-as-keep, or use Keep in review more.'}`)
	}

	const manual = rows.filter(row => row.source === 'closed')
	const stillOpen = records.filter(record => !record.outcome).map(record => ({ x: featuresAt(record, at) }))
	out.push('', `3. Tabs you closed yourself (${manual.length})`)
	if (manual.length) {
		const idle = manual.map(row => row.x.idleH * HOUR)
		out.push(`   times in front:   ${timesInFrontBreakdown(manual)}`)
		if (stillOpen.length) out.push(`   still-open tabs:  ${timesInFrontBreakdown(stillOpen)}`)
		out.push(`   idle before close: median ${duration(quantile(idle, 0.5))} · p75 ${duration(quantile(idle, 0.75))} · p90 ${duration(quantile(idle, 0.9))}`)
		out.push(`   closed while in front: ${pct(manual.filter(row => row.x.inFront).length, manual.length)} (idle for these = gap before that last visit)`)
		out.push(`   opened from another tab: ${pct(manual.filter(row => row.x.opener).length, manual.length)} of your closes vs ${pct(stillOpen.filter(row => row.x.opener).length, stillOpen.length)} of still-open tabs`)
		out.push(`   unloaded by Memory Saver before close: ${pct(manual.filter(row => row.x.discarded).length, manual.length)}`)
	}

	out.push('', `4. By domain (${minDomain}+ tabs; keep rate = keep labels / all labels)`)
	const domains = new Map()
	for (const record of records) {
		const entry = domains.get(record.domain) || { tabs: 0, closed: 0, saved: 0, restored: 0, kept: 0, open: 0, other: 0, keep: 0, labelled: 0 }
		entry.tabs += 1
		if (record.outcome === 'closed') entry.closed += 1
		else if (record.outcome === 'saved') entry.saved += 1
		else if (!record.outcome) entry.open += 1
		else entry.other += 1
		if (Number.isFinite(record.restoredAt)) entry.restored += 1
		if (record.keeps > 0) entry.kept += 1
		const decision = decisionOf(record, at, { openAsKeep })
		if (decision) { entry.labelled += 1; if (decision.label === 'keep') entry.keep += 1 }
		domains.set(record.domain, entry)
	}
	const domainRows = [...domains].filter(([, entry]) => entry.tabs >= minDomain).sort((a, b) => b[1].tabs - a[1].tabs)
		.map(([domain, e]) => [domain, e.tabs, e.closed, e.saved, e.restored, e.kept, e.open, e.labelled ? `${e.keep}/${e.labelled} ${pct(e.keep, e.labelled)}` : '—'])
	out.push(...table(['   domain', 'tabs', 'closed', 'saved', 'restored', 'Keep', 'open', 'keep rate'], domainRows.map(([d, ...rest]) => [`   ${d}`, ...rest])))

	out.push('', '5. Threshold rule: suggest closing tabs idle at least T (labelled tabs)')
	const thresholds = [15 * 60_000, HOUR, 4 * HOUR, 12 * HOUR, DAY, 3 * DAY, 7 * DAY]
	out.push(...table(['   T', 'closes caught', 'keeps wrongly suggested', 'precision', 'open tabs it would suggest'], thresholds.map(t => {
		const caught = closes.filter(row => row.x.idleH * HOUR >= t).length
		const wrong = keeps.filter(row => row.x.idleH * HOUR >= t).length
		const openHit = stillOpen.filter(row => !row.x.inFront && row.x.idleH * HOUR >= t).length
		return [`   ${duration(t)}`, `${caught}/${closes.length} ${pct(caught, closes.length)}`, `${wrong}/${keeps.length} ${pct(wrong, keeps.length)}`, pct(caught, caught + wrong), `${openHit}/${stillOpen.length}`]
	})))

	out.push('', '6. Decision tree (depth 3, leaves of 5+ tabs; numbers are labelled tabs)')
	if (closes.length && keeps.length) out.push(...printTree(growTree(rows)).map(line => `   ${line}`))
	else out.push('   Needs both close and keep labels.')
	return out.join('\n')
}

function main(argv) {
	const file = argv.find(arg => !arg.startsWith('--'))
	if (!file) {
		console.error("Usage: node eval/behavior-rules.js <tab-habits-export.json> [--rule='idleMin >= 720'] [--open-as-keep] [--min-domain=3]")
		process.exit(2)
	}
	const report = JSON.parse(fs.readFileSync(file, 'utf8'))
	if (report.kind !== 'neat-freak-tab-behavior' || !Array.isArray(report.records)) {
		console.error('Not a Neat Freak tab-habits export.')
		process.exit(2)
	}
	if (!report.records.length) {
		console.log('The export has no tabs yet.')
		return
	}
	const minDomain = Number(argv.find(arg => arg.startsWith('--min-domain='))?.split('=')[1]) || 3
	const rules = argv.filter(arg => arg.startsWith('--rule=')).map(arg => arg.slice('--rule='.length))
	console.log(analyse(report, { openAsKeep: argv.includes('--open-as-keep'), minDomain, rules }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
