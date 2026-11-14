import test from 'node:test'
import assert from 'node:assert/strict'
import {
	decisionOf, featuresAt, growTree, printTree, analyse, offerLabel, offers, replayHeuristic, compileRule, POLICIES,
} from '../eval/behavior-rules.js'
import { buildSample } from '../eval/behavior-sample.js'

const H = 3_600_000
const D = 24 * H
const T0 = 2_000_000_000_000

test('outcome labels: decisive outcomes only; a save is judged after the 7-day restore window', () => {
	const exportedAt = T0 + 10 * D
	assert.deepEqual(decisionOf({ outcome: 'closed', endedAt: T0 + H }, exportedAt), { label: 'close', source: 'closed', at: T0 + H })
	assert.equal(decisionOf({ outcome: 'saved', endedAt: T0, restoredAt: T0 + 6 * D }, exportedAt).label, 'keep')
	assert.equal(decisionOf({ outcome: 'saved', endedAt: T0, restoredAt: T0 + 8 * D }, exportedAt).label, 'close')
	assert.equal(decisionOf({ outcome: 'saved', endedAt: T0 }, exportedAt).label, 'close')
	assert.equal(decisionOf({ outcome: 'saved', endedAt: T0 + 5 * D }, exportedAt), null) // could still be restored
	assert.deepEqual(decisionOf({ keeps: 2, keptAt: T0 + 5 * H }, exportedAt), { label: 'keep', source: 'kept', at: T0 + 5 * H })
	assert.equal(decisionOf({ outcome: 'window-closed', endedAt: T0 }, exportedAt), null)
	assert.equal(decisionOf({ openedAt: T0 }, exportedAt), null)
	assert.equal(decisionOf({ openedAt: T0 }, exportedAt, { openAsKeep: true }).label, 'keep')
})

test('offer snapshots: wrong and right offers, misses and right keeps', () => {
	const exportedAt = T0 + 20 * D
	const snap = offered => ({ at: T0, offered })
	const visits = [[T0 - H, T0 - H + 60_000]]
	// Offered, then kept in review / restored within 7 days / closed / saved and left.
	assert.equal(offerLabel({ visits, lastKeptAt: T0 + H }, snap(true), exportedAt), 'wrong')
	assert.equal(offerLabel({ visits, outcome: 'saved', endedAt: T0 + H, restoredAt: T0 + 2 * D }, snap(true), exportedAt), 'wrong')
	assert.equal(offerLabel({ visits, outcome: 'closed', endedAt: T0 + H }, snap(true), exportedAt), 'right')
	assert.equal(offerLabel({ visits, outcome: 'saved', endedAt: T0 + H }, snap(true), exportedAt), 'right')
	assert.equal(offerLabel({ visits, outcome: 'saved', endedAt: T0 + H }, snap(true), T0 + 2 * D), 'pending')
	assert.equal(offerLabel({ visits, lastKeptAt: T0 - H }, snap(true), exportedAt), 'pending') // that Keep was for an earlier offer
	// Not offered, then closed by hand without a visit / used again first.
	assert.equal(offerLabel({ visits, outcome: 'closed', endedAt: T0 + 3 * H }, snap(false), exportedAt), 'miss')
	assert.equal(offerLabel({ visits: [...visits, [T0 + H, T0 + 2 * H]], outcome: 'closed', endedAt: T0 + 3 * H }, snap(false), exportedAt), 'keep')
	assert.equal(offerLabel({ visits }, snap(false), exportedAt), 'pending')
})

test('the replayed heuristic follows the shipped cutoffs; protected tabs are never offered', () => {
	const f = extra => ({ idleMin: 60, clustered: true, clusterIdleMin: 60, duplicate: false, ...extra })
	assert.equal(replayHeuristic(f()), true) // cold cluster: past 30 min
	assert.equal(replayHeuristic(f({ clusterIdleMin: 10 })), false) // warm cluster: needs 90 min
	assert.equal(replayHeuristic(f({ clusterIdleMin: 10, idleMin: 95 })), true)
	assert.equal(replayHeuristic(f({ clustered: false, idleMin: 5000 })), false)
	assert.equal(replayHeuristic(f({ clustered: false, idleMin: 1, duplicate: true })), true)
	for (const flag of ['active', 'pinned', 'audible', 'unsaved', 'unreadable']) {
		assert.equal(offers(POLICIES[0], f({ [flag]: true })), false, flag)
	}
	const rule = compileRule("idleMin >= 720 && activations <= 1 && domain !== 'google.com'")
	assert.equal(rule.offer({ idleMin: 800, activations: 1, domain: 'github.com' }), true)
	assert.equal(rule.offer({ idleMin: 800, activations: 1, domain: 'google.com' }), false)
})

test('gold labels: gate, misses and either-way offers per policy', () => {
	const row = (label, extra) => ({ label, inOffer: null, idleMin: 0, activations: 0, clustered: true, clusterIdleMin: 600, heuristic: false, ...extra })
	const report = {
		kind: 'neat-freak-tab-behavior', exportedAt: T0 + D, records: [{ openedAt: T0, visits: [], domain: 'example.com' }],
		labelPasses: [{ at: T0, offerReady: false, tabs: [
			row('important', { idleMin: 600, heuristic: true }), // offered by the heuristic: breaks the gate
			row('important', { idleMin: 10, unsaved: true }),
			row('close', { idleMin: 600, heuristic: true }),
			row('close', { idleMin: 5 }), // a miss
			row('either', { idleMin: 600, heuristic: true }),
		] }],
	}
	const text = analyse(report, { rules: ['idleMin >= 700'] })
	assert.match(text, /1\. Your labels \(gold standard\): 1 passes, 5 tabs: Important 2 · Either way 1 · Close 2/)
	assert.match(text, /heuristic \(replayed\)\s+1\/2\s+1\/2\s+1\/1/)
	assert.match(text, /idleMin >= 700\s+0\/2\s+2\/2\s+0\/1/)
	assert.doesNotMatch(text, /Replay check/)
})

test('idle is time since last in front, or the gap before a final visit that ended in a close', () => {
	const base = { openedAt: T0, activations: 2, activeMs: 0 }
	const background = featuresAt({ ...base, visits: [[T0 + H, T0 + 2 * H]] }, T0 + 5 * H)
	assert.equal(background.idleH, 3)
	assert.equal(background.inFront, false)
	const inFront = featuresAt({ ...base, visits: [[T0 + H, T0 + 2 * H], [T0 + 6 * H, T0 + 6 * H + 1000]] }, T0 + 6 * H + 1000)
	assert.equal(inFront.idleH, 4)
	assert.equal(inFront.inFront, true)
	assert.equal(featuresAt({ ...base, activations: 0, visits: [] }, T0 + 9 * H).idleH, 9)
	assert.equal(featuresAt({ ...base, visits: [[T0, T0 + H], [T0 + 8 * H, null]] }, T0 + 3 * H).activations, 1)
})

test('the tree finds a clean rule and prints it plainly', () => {
	const rows = Array.from({ length: 40 }, (_, i) => ({
		y: i % 4 === 0 ? 0 : 1,
		x: { idleH: 1 + (i % 7), ageH: 10, activations: i % 4 === 0 ? 5 : 1, activeMin: 3, opener: 1, discarded: 0, pinned: 0 },
	}))
	const tree = growTree(rows)
	assert.equal(tree.feature, 'activations')
	const text = printTree(tree).join('\n')
	assert.match(text, /if times in front >= 3:.*\n\s+-> KEEP  \(10 tabs, 0% close\)/)
	assert.match(text, /else, times in front <= 2:.*\n\s+-> CLOSE  \(30 tabs, 100% close\)/)
})

test('the synthetic sample (real recorder and real heuristic) analyses end to end', async () => {
	const report = await buildSample({ days: 4 })
	assert.equal(report.kind, 'neat-freak-tab-behavior')
	assert.doesNotMatch(JSON.stringify(report), /https?:|page-\d|budget|launch|hiring/)
	assert.ok(report.labelPasses.length >= 3)
	assert.ok(report.records.some(record => record.offers?.length))
	const text = analyse(report)
	for (const heading of ['1. Your labels', '2. Suggestions vs what you did next', '3. Tabs you closed yourself', '4. By domain', '5. Threshold rule', '6. Decision tree']) {
		assert.ok(text.includes(heading), heading)
	}
	assert.doesNotMatch(text, /Replay check/) // the replayed heuristic matches the live one
})
