import test from 'node:test'
import assert from 'node:assert/strict'
import { labelRows, keyAction, createLabelState } from '../src/label.js'

const now = 2_000_000_000_000
const tabs = [
	{ id: 3, windowId: 2, index: 0, url: 'https://b.example.com', title: 'B', lastAccessed: now - 3 * 3_600_000 },
	{ id: 1, windowId: 1, index: 1, url: 'https://www.a.example.com/x', title: 'A', lastAccessed: now - 5 * 60_000, pinned: true },
	{ id: 2, windowId: 1, index: 0, url: 'chrome://extensions', title: 'Extensions' },
	{ id: 4, windowId: 1, index: 2, url: 'https://secret.example.com', title: 'Private', incognito: true },
]

test('rows: open web tabs in tab-strip order, with domain and last used', () => {
	const rows = labelRows(tabs, now)
	assert.deepEqual(rows.map(row => [row.tabId, row.domain, row.lastUsed, row.pinned]), [[1, 'a.example.com', '5m ago', true], [3, 'b.example.com', '3h ago', false]])
})

test('keys: one press per label, arrows and j/k move, Cmd/Ctrl+S saves', () => {
	assert.deepEqual(keyAction('1'), { type: 'label', label: 'important' })
	assert.deepEqual(keyAction('E'), { type: 'label', label: 'either' })
	assert.deepEqual(keyAction('3'), { type: 'label', label: 'close' })
	assert.deepEqual(keyAction('Backspace'), { type: 'clear' })
	assert.deepEqual(keyAction('j'), { type: 'move', by: 1 })
	assert.deepEqual(keyAction('ArrowUp'), { type: 'move', by: -1 })
	assert.deepEqual(keyAction('s', { meta: true }), { type: 'save' })
	assert.deepEqual(keyAction('Enter', { ctrl: true }), { type: 'save' })
	assert.equal(keyAction('1', { meta: true }), null) // leave browser shortcuts alone
	assert.equal(keyAction('q'), null)
})

test('state: labelling advances, skipping is allowed, payload holds ids and labels only', () => {
	const state = createLabelState(labelRows([...tabs, { id: 5, windowId: 2, index: 1, url: 'https://c.example.com', title: 'C' }], now))
	state.apply(keyAction('1'))
	assert.equal(state.cursor, 1)
	state.apply(keyAction('ArrowDown')) // skip one
	state.apply(keyAction('3'))
	assert.equal(state.cursor, 2) // stays on the last row
	state.apply(keyAction('home'))
	state.apply(keyAction('x'))
	assert.equal(state.labelOf(1), null)
	state.apply(keyAction('2'), 0)
	assert.deepEqual(state.payload(), [{ tabId: 1, label: 'either' }, { tabId: 5, label: 'close' }])
	assert.deepEqual(state.counts(), { important: 0, either: 1, close: 1, unlabelled: 1 })
	assert.equal(state.dirty, true)
	state.markSaved()
	assert.equal(state.dirty, false)
})
