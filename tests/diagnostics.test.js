import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiagnostics, diagnosticError, diagnosticDetails, DIAGNOSTICS_LIMIT, DIAGNOSTICS_MAX_AGE_MS } from '../src/diagnostics.js'

function fixture() {
	let entries = []
	let time = 2_000_000_000_000
	let enabled = true
	let fail = false
	const deps = {
		read: async () => entries,
		write: async value => { if (fail) throw new Error('Storage unavailable'); entries = structuredClone(value) },
		enabled: async () => enabled,
		now: () => time,
	}
	return { deps, log: createDiagnostics(deps), get entries() { return entries },
		set enabled(value) { enabled = value }, set fail(value) { fail = value }, advance(ms) { time += ms } }
}

test('diagnostics allowlist removes content and credentials, including from stored entries on export', async () => {
	const h = fixture()
	await h.log.record('suggestion_prepared', {
		suggestedCount: 12, automatic: true, mode: 'llm', run: 'run_test',
		url: 'https://private.example.com', title: 'Private title', pageSummary: 'Secret draft',
		error: 'Bearer SECRET', action: 'PRIVATE_ACTION', reason: 'private value',
	})
	h.entries[0].url = 'https://injected.example.com'
	const report = await h.log.exportLog()
	assert.deepEqual(Object.keys(report.entries[0]).sort(), ['at', 'automatic', 'event', 'mode', 'run', 'suggestedCount'])
	assert.doesNotMatch(JSON.stringify(report), /private|Secret|SECRET|injected/i)
	const failure = new TypeError('A secret value from a page')
	failure.stack = 'TypeError: private\n at perform (chrome-extension://secret-id/src/background.js:200:10)'
	await h.log.record('background_error', diagnosticDetails(failure))
	assert.equal(h.entries[1].errorLocation, 'background.js:200:10')
	assert.equal(h.entries[1].errorType, 'TypeError')
	assert.doesNotMatch(JSON.stringify(h.entries), /secret|private/)
	assert.equal(await h.log.record('unknown-event', { suggestedCount: 1 }), false)
	assert.equal(await h.log.record('action', { action: 'GET_POPUP_STATE' }), false)
})

test('concurrent recording is bounded, survives replacement, and expires after seven days', async () => {
	const h = fixture()
	await Promise.all(Array.from({ length: 510 }, (_, count) => h.log.record('keep_changed', { keptCount: count })))
	assert.equal(h.entries.length, DIAGNOSTICS_LIMIT)
	assert.equal(h.entries[0].keptCount, 10)
	assert.equal((await createDiagnostics(h.deps).exportLog()).entries.length, DIAGNOSTICS_LIMIT)
	h.advance(DIAGNOSTICS_MAX_AGE_MS + 1)
	await h.log.prune()
	assert.deepEqual(h.entries, [])
})

test('recording can be disabled and cleared; logging failures never poison later actions', async () => {
	const h = fixture()
	h.fail = true
	assert.equal(await h.log.record('action', { action: 'SAVE_TABS', ok: true }), false)
	h.fail = false
	assert.equal(await h.log.record('action', { action: 'SAVE_TABS', ok: true }), true)
	h.enabled = false
	await h.log.record('action', { action: 'SAVE_TABS', ok: false })
	assert.equal(h.entries.length, 1)
	await h.log.clear()
	assert.deepEqual((await h.log.exportLog()).entries, [])
	assert.equal(diagnosticError(new Error('network failed: SECRET')), 'connection')
	assert.equal(diagnosticError(new Error('Something private')), 'unknown')
})

test('token totals, tab counts and nudge kind and backoff level are kept; anything else is dropped', async () => {
	const h = fixture()
	await h.log.record('suggestion_prepared', { promptTokens: 9531, completionTokens: 236, tabCount: 72, discarded: true, title: 'Private' })
	await h.log.record('nudge_shown', { nudgeKind: 'reminder', backoffLevel: 2, tabCount: 72 })
	await h.log.record('nudge_shown', { nudgeKind: 'https://private.example.com', backoffLevel: '3', discarded: 'yes' })
	const [prepared, reminder, junk] = h.entries
	assert.deepEqual([prepared.promptTokens, prepared.completionTokens, prepared.tabCount, prepared.discarded], [9531, 236, 72, true])
	assert.deepEqual([reminder.nudgeKind, reminder.backoffLevel, reminder.tabCount], ['reminder', 2, 72])
	assert.deepEqual(Object.keys(junk).sort(), ['at', 'event'])
	assert.doesNotMatch(JSON.stringify(h.entries), /Private|private/)
})

test('nudge_shown keeps whether the cycle started on time or on growth, and nothing else in that field', async () => {
	const h = fixture()
	await h.log.record('nudge_shown', { cycleStart: 'growth' })
	await h.log.record('nudge_shown', { cycleStart: 'https://private.example.com' })
	assert.equal(h.entries[0].cycleStart, 'growth')
	assert.equal('cycleStart' in h.entries[1], false)
})
