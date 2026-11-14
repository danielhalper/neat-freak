// Daily labelling pass for the opt-in tab habits log. The user marks each open
// tab Important / Either way / Close from the keyboard; Save sends tab ids and
// labels to the background, which stores domain-level features only. Titles
// and favicons are shown here and never stored. The pass is judged as of when
// the page opened (BEGIN_TAB_LABELS), so checking a tab doesn't skew it.
import { faviconFallback, formatRelativeActive, getDomain } from './utils.js'

export const LABELS = [
	{ id: 'important', name: 'Important', hint: 'never offer it', keys: ['1', 'i'] },
	{ id: 'either', name: 'Either way', hint: 'offering it is fine', keys: ['2', 'e'] },
	{ id: 'close', name: 'Close', hint: 'done with it', keys: ['3', 'c'] },
]

export function labelRows(tabs, now = Date.now()) {
	return (tabs || [])
		.filter(tab => !tab.incognito && /^https?:/.test(tab.url || ''))
		.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))
		.map(tab => ({
			tabId: tab.id, title: tab.title || tab.url, domain: getDomain(tab.url), favIconUrl: tab.favIconUrl || '',
			lastUsed: formatRelativeActive(tab.lastAccessed, now), pinned: Boolean(tab.pinned),
		}))
}

export function keyAction(key, { meta = false, ctrl = false, alt = false } = {}) {
	const lower = String(key || '').toLowerCase()
	if ((meta || ctrl) && (lower === 's' || lower === 'enter')) return { type: 'save' }
	if (meta || ctrl || alt) return null
	const label = LABELS.find(item => item.keys.includes(lower))
	if (label) return { type: 'label', label: label.id }
	if (['0', 'x', 'backspace', 'delete'].includes(lower)) return { type: 'clear' }
	if (['arrowdown', 'j'].includes(lower)) return { type: 'move', by: 1 }
	if (['arrowup', 'k'].includes(lower)) return { type: 'move', by: -1 }
	if (lower === 'home') return { type: 'move', to: 0 }
	if (lower === 'end') return { type: 'move', to: Infinity }
	return null
}

export function createLabelState(rows) {
	let cursor = 0
	let dirty = false
	const labels = new Map()
	const clamp = index => Math.max(0, Math.min(rows.length - 1, index))
	return {
		rows,
		get cursor() { return cursor },
		get dirty() { return dirty },
		labelOf: tabId => labels.get(tabId) || null,
		focus(index) { cursor = clamp(index) },
		apply(action, index = cursor) {
			if (!rows.length || !action) return
			const row = rows[clamp(index)]
			if (action.type === 'label') {
				labels.set(row.tabId, action.label)
				dirty = true
				cursor = clamp(clamp(index) + 1) // next tab, so a pass is one key per tab
			} else if (action.type === 'clear') {
				dirty = labels.delete(row.tabId) || dirty
			} else if (action.type === 'move') {
				cursor = clamp(Number.isFinite(action.to) ? action.to : action.to === Infinity ? rows.length - 1 : cursor + action.by)
			}
		},
		counts() {
			const counts = { important: 0, either: 0, close: 0, unlabelled: 0 }
			for (const row of rows) counts[labels.get(row.tabId) || 'unlabelled'] += 1
			return counts
		},
		payload: () => rows.filter(row => labels.has(row.tabId)).map(row => ({ tabId: row.tabId, label: labels.get(row.tabId) })),
		markSaved() { dirty = false },
	}
}

function send(type, payload = {}) {
	return chrome.runtime.sendMessage({ type, ...payload })
}

function element(tag, props = {}, children = []) {
	const node = Object.assign(document.createElement(tag), props)
	for (const child of [].concat(children)) node.append(child)
	return node
}

async function mount() {
	const list = document.querySelector('#label-list')
	const status = document.querySelector('#label-status')
	const summary = document.querySelector('#label-summary')
	const saveButton = document.querySelector('#label-save')
	const notice = document.querySelector('#label-off')

	const asOf = document.querySelector('#label-asof')
	let frozenAt = null
	async function begin() {
		frozenAt = (await send('BEGIN_TAB_LABELS').catch(() => null))?.frozenAt ?? null
		const time = frozenAt && new Date(frozenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
		asOf.textContent = time ? `Times are as of ${time}, when you opened this page, so checking a tab won't change them. Reopen the page for a fresh snapshot.` : ''
	}

	const settings = (await send('GET_SETTINGS'))?.settings || {}
	notice.hidden = settings.behaviorLogEnabled === true
	await begin()
	document.querySelector('#label-enable').addEventListener('click', async () => {
		const response = await send('SAVE_SETTINGS', { settings: { behaviorLogEnabled: true } })
		notice.hidden = response?.ok === true
		if (notice.hidden) await begin()
	})

	const state = createLabelState(labelRows(await chrome.tabs.query({}), frozenAt ?? Date.now()))
	const rowNodes = state.rows.map((row, index) => {
		const icon = row.favIconUrl
			? element('img', { src: row.favIconUrl, alt: '', className: 'label-icon', onerror() { this.replaceWith(element('span', { className: 'label-icon', textContent: faviconFallback(row.domain) })) } })
			: element('span', { className: 'label-icon', textContent: faviconFallback(row.domain) })
		const meta = element('span', { className: 'label-meta', textContent: [row.domain, row.lastUsed && `used ${row.lastUsed}`, row.pinned && 'pinned'].filter(Boolean).join(' · ') })
		const chips = LABELS.map(label => element('button', {
			type: 'button', className: `label-chip label-chip-${label.id}`, tabIndex: -1, title: label.hint,
			textContent: `${label.keys[0]} ${label.name}`,
			onclick(event) { event.stopPropagation(); state.apply({ type: 'label', label: label.id }, index); render() },
		}))
		const node = element('li', { className: 'label-row', id: `label-row-${row.tabId}`, onclick() { state.focus(index); render() } }, [
			icon, element('span', { className: 'label-text' }, [element('span', { className: 'label-title', textContent: row.title }), meta]),
			element('span', { className: 'label-chips' }, chips),
		])
		node.setAttribute('role', 'option')
		list.append(node)
		return { node, chips }
	})
	if (!state.rows.length) list.append(element('li', { className: 'label-empty', textContent: 'No open web tabs to label.' }))

	function render() {
		rowNodes.forEach(({ node, chips }, index) => {
			const label = state.labelOf(state.rows[index].tabId)
			node.dataset.label = label || ''
			node.setAttribute('aria-selected', String(index === state.cursor))
			chips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(LABELS[i].id === label)))
		})
		const current = rowNodes[state.cursor]?.node
		if (current) {
			list.setAttribute('aria-activedescendant', current.id)
			current.scrollIntoView({ block: 'nearest' })
		}
		const counts = state.counts()
		summary.textContent = `${counts.important} Important · ${counts.either} Either way · ${counts.close} Close · ${counts.unlabelled} skipped`
		saveButton.disabled = !state.dirty
	}

	async function save() {
		if (!state.dirty) return
		saveButton.disabled = true
		status.textContent = 'Saving…'
		try {
			const response = await send('SAVE_TAB_LABELS', { labels: state.payload(), frozenAt })
			if (!response?.ok) throw new Error(response?.error)
			if (!response.saved) {
				status.textContent = 'Nothing saved. Turn on the tab habits log first.'
				notice.hidden = false
				saveButton.disabled = false
				return
			}
			state.markSaved()
			status.textContent = `Saved ${response.saved} labels. Analyse with: node eval/behavior-rules.js <export>`
		} catch {
			status.textContent = "Couldn't save labels. Reload this page and try again."
		}
		render()
	}

	saveButton.addEventListener('click', save)
	// None of these keys clash with button activation (Enter / Space).
	document.addEventListener('keydown', event => {
		const action = keyAction(event.key, { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey })
		if (!action) return
		event.preventDefault()
		if (action.type === 'save') save()
		else { state.apply(action); render() }
	})
	render()
	list.focus()
}

if (typeof document !== 'undefined' && document.querySelector('#label-list')) mount()
