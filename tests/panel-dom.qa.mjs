// Usage: node tests/panel-dom.qa.mjs /path/to/jsdom/lib/api.js
// Optional DOM QA dependency stays outside the no-build extension.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const { JSDOM, VirtualConsole } = await import(pathToFileURL(process.argv[2]).href)
const output = `/tmp/neat-freak-qa/panel-dom-${process.pid}.html`
execFileSync(process.execPath, ['tests/render-browser-harness.mjs', output])
const errors = []
const console = new VirtualConsole()
console.on('jsdomError', error => errors.push(error.message))
const dom = new JSDOM(fs.readFileSync(output, 'utf8'), {
	url: process.argv.includes('--popup') ? 'https://qa.example.test/?popup=1' : 'https://qa.example.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
	beforeParse(window) {
		window.structuredClone = structuredClone
		window.fetch = async () => { throw new Error('Offline QA') }
		window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
		window.confirm = () => true
	},
})
async function settle(predicate, label) {
	for (let i = 0; i < 100; i++) {
		await new Promise(resolve => setTimeout(resolve, 10))
		if (predicate()) return
	}
	throw new Error(`Did not settle: ${label}; status=${dom.window.document.getElementById('status').textContent}; errors=${errors}`)
}
const document = dom.window.document
function shadow() { return document.getElementById('__neat-freak-panel__')?.shadowRoot }
function click(selector) { const node = shadow()?.querySelector(selector); assert.ok(node, `Missing ${selector}`); node.click() }
const popup = process.argv.includes('--popup')
try {
	// The panel has one Tidy button. Its second line says what a press does.
	const tidyCta = () => shadow().getElementById('tidy-cta')
	const tidySub = () => shadow()?.getElementById('tidy-cta-sub')
	const tidyArea = () => shadow().getElementById('tidy-area')
	const offerLine = text => tidySub()?.classList.contains('ready') && tidySub().textContent === text
	const savedLine = /^Saved (into \d+ folders|to a folder)\.$/
	// The popup opens on the panel; a page gets the nudge card.
	await settle(() => popup ? offerLine('12 tabs ready to review')
		: shadow()?.getElementById('title').textContent === '12 tabs ready to tidy', 'prepared offer')
	if (!popup) {
		assert.match(shadow().getElementById('sub').textContent, savedLine)
		const review = shadow().querySelector('#actions .offer-toggle[aria-expanded="false"] + [data-action="tidy-recommendation"]')?.previousElementSibling
		assert.equal(review?.textContent, 'Review', 'Review sits just left of Tidy now')
	}
	const stored = await dom.window.chrome.storage.session.get('neatFreakRecommendation')
	const record = stored.neatFreakRecommendation
	const createdAt = record.plan.createdAt
	record.plan.stale = true
	await dom.window.chrome.storage.session.set({ neatFreakRecommendation: record })
	document.getElementById('toolbar').click()
	await settle(() => offerLine('12 tabs ready to review'), 'stale offer stays useful')
	assert.doesNotMatch(tidyArea().textContent, /tabs have changed|expired|checked .*ago/i)
	// Same button with or without an offer, and for every scope; switching
	// scope keeps the offer.
	const offerCard = () => shadow().getElementById('recommendation-card')
	assert.equal(tidyArea().classList.contains('pending'), false)
	assert.equal(tidyCta().hidden, false, 'A ready offer keeps the one Tidy button')
	assert.equal(tidyCta().querySelector('.tidy-cta-title').textContent, 'Tidy my tabs')
	assert.ok(tidySub().querySelector('svg'), 'A prepared list is marked on the button')
	assert.equal(tidyArea().querySelector('[data-action="tidy-recommendation"], [data-action="toggle-offer-list"], [data-action="find-recommendation"]'), null, 'No second call to action in the panel')
	click('[data-scope-value="allWindows"]')
	assert.equal(offerCard().hidden, true)
	assert.equal(tidyCta().hidden, false)
	await settle(() => /across windows/.test(tidySub().textContent), 'All windows preview')
	assert.equal(tidySub().classList.contains('ready'), false, 'Only Smart has a prepared list')
	click('[data-scope-value="smart"]')
	assert.equal(offerCard().hidden, false)
	assert.ok(offerLine('12 tabs ready to review'), 'The offer is still there after switching scope')
	assert.ok((await dom.window.chrome.storage.session.get('neatFreakRecommendation')).neatFreakRecommendation.plan, 'Switching scope keeps the prepared offer')
	// AI picks follow "Review before closing"; local picks always open the list.
	record.plan.reviewRequired = false
	await dom.window.chrome.storage.session.set({ neatFreakRecommendation: record })
	await settle(() => offerLine('12 tabs ready to review'), 'review on: a press opens the list')
	click('#opt-review')
	assert.ok(offerLine('12 tabs ready to tidy'), 'review off: a press closes AI picks')
	click('#opt-review')
	assert.ok(offerLine('12 tabs ready to review'))
	record.plan.reviewRequired = true
	record.plan.createdAt = Date.now() - 61 * 60_000
	await dom.window.chrome.storage.session.set({ neatFreakRecommendation: record })
	await settle(() => /Smart will pick/.test(tidySub()?.textContent), 'expired offer falls back to a plain Tidy')
	assert.equal(tidySub().classList.contains('ready'), false)
	assert.equal(tidyCta().hidden, false)
	assert.doesNotMatch(tidyArea().textContent, /expired|tabs have changed|No tabs suggested/i)
	assert.equal(tidyArea().querySelector('[data-action="execute-recommendation"], [data-action="find-recommendation"]'), null)
	await dom.window.chrome.storage.session.set({ neatFreakPanelState: { mode: 'hidden', retiredSuggestion: true } })
	assert.ok(shadow(), 'Retiring a nudge does not close an expanded panel')
	record.plan.createdAt = createdAt
	record.plan.expired = false
	await dom.window.chrome.storage.session.set({ neatFreakRecommendation: record })
	document.getElementById('nudge').click()
	// Popup: the Tidy button opens the list. Page: Tidy now on the nudge does,
	// because local picks must be seen first.
	const offerTidy = popup ? '#tidy-cta' : '#actions [data-action="tidy-recommendation"]'
	await settle(() => popup ? offerLine('12 tabs ready to review') : shadow()?.querySelector(offerTidy), 'usable offer restored')
	click(offerTidy)
	await settle(() => shadow()?.querySelectorAll('.review-item').length === 12, 'Tidy on a local pick opens the list')
	assert.match(document.getElementById('status').textContent, /"closedSyntheticTabIds": \[\]/, 'Tidy on a local pick closes nothing before the list is seen')
	assert.equal(shadow().getElementById('title').textContent, '12 tabs ready to tidy')
	// The nudge's Tidy now explains why nothing closed; the panel's button
	// already said "ready to review".
	assert.match(shadow().getElementById('sub').textContent, popup ? savedLine : /Check the list/)
	assert.match(shadow().querySelector('.review-footer .review-meta').textContent, /^Picked (just now|\d+ min ago) without AI · Refresh$/)
	assert.equal(shadow().querySelector('.review-footer .offer-toggle').getAttribute('aria-expanded'), 'true')
	assert.equal(shadow().querySelector('.review-footer .offer-toggle').textContent, 'Hide list')
	click('.review-footer .offer-toggle')
	assert.ok(shadow().getElementById('card').classList.contains('offer-collapsed'), 'Hide list folds the list')
	assert.equal(shadow().querySelector('#actions .offer-toggle').getAttribute('aria-expanded'), 'false')
	assert.equal(shadow().querySelector('#actions .offer-toggle').textContent, 'Review')
	shadow().getElementById('title').click()
	assert.equal(shadow().getElementById('card').classList.contains('offer-collapsed'), false, 'Clicking the card opens the list')
	assert.equal(shadow().getElementById('card').classList.contains('expanded'), false, 'Review header must be visible')
	await new Promise(resolve => setTimeout(resolve, 240))
	assert.equal(shadow()?.querySelectorAll('.review-item').length, 12, 'An old dismissal animation cannot remove a newly opened review')
	click('.review-remove')
	await settle(() => shadow()?.querySelectorAll('.review-item.removed').length === 1, 'keep choice')
	assert.equal(shadow().getElementById('title').textContent, '11 tabs ready to tidy')
	assert.equal(shadow().querySelector('.review-remove').getAttribute('aria-checked'), 'false')
	assert.equal(shadow().querySelector('.review-group-keep').getAttribute('aria-checked'), 'mixed')
	const body = shadow().getElementById('review-body')
	body.scrollTop = 84
	for (let i = 0; i < 20; i++) shadow().querySelectorAll('.review-remove')[1].click()
	await new Promise(resolve => setTimeout(resolve, 100))
	assert.equal(shadow().querySelectorAll('.review-item.removed').length, 1, 'Rapid toggles preserve final choice')
	assert.equal(shadow().getElementById('review-body'), body, 'Keep acknowledgments preserve DOM nodes')
	assert.equal(body.scrollTop, 84, 'Keep acknowledgments preserve review scroll')
	click('[data-action="refresh-recommendation"]')
	await settle(() => shadow()?.querySelectorAll('.review-item').length === 11, 'refresh preserves keep')
	document.getElementById('change').click()
	click('.review-footer [data-action="tidy-recommendation"]')
	await settle(() => shadow()?.getElementById('title').textContent.includes('tucked away'), 'close result')
	assert.match(shadow().getElementById('title').textContent, /9 tabs tucked away/)
	assert.match(document.getElementById('status').textContent, /"savedTabs": 9/)
	// The done card's "Tidy without reviewing next time" toggle must not show once
	// that card is opened into the full panel. jsdom has no layout, so check the rule.
	const css = [...shadow().querySelectorAll('style')].map(style => style.textContent).join('\n')
	assert.match(css, /\.has-auto-tidy:not\(\.expanded\) \.done-auto \{ display: flex; \}/, 'done toggle is limited to the small card')
	assert.doesNotMatch(css, /\.has-auto-tidy \.done-auto \{ display: flex/, 'no done toggle rule for the full panel')
	document.getElementById('toolbar').click()
	await settle(() => shadow()?.querySelector('[data-action="enable-suggestions"]'), 'background opt-in')
	click('[data-action="enable-suggestions"]')
	await settle(() => !shadow()?.querySelector('[data-action="enable-suggestions"]'), 'opt-in persists and updates the panel')
	assert.equal(errors.length, 0, errors.join('\n'))
	// Exercise the actual settings controls against the same background routes.
	const settingsDom = new JSDOM(fs.readFileSync('options.html', 'utf8'), { url: 'https://settings.example.test/', runScripts: 'outside-only' })
	let exportedBlob
	settingsDom.window.chrome = dom.window.chrome
	settingsDom.window.Blob = Blob
	settingsDom.window.URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:synthetic-export' }
	settingsDom.window.URL.revokeObjectURL = () => {}
	settingsDom.window.HTMLAnchorElement.prototype.click = function () { assert.match(this.download, /^neat-freak-diagnostics-.*\.json$/) }
	settingsDom.window.eval(fs.readFileSync('src/options.js', 'utf8'))
	const settingsDoc = settingsDom.window.document
	await settle(() => settingsDoc.getElementById('diagnostics-enabled').checked, 'diagnostics enabled in Settings')
	settingsDoc.getElementById('export-diagnostics').click()
	await settle(() => exportedBlob, 'diagnostics download')
	const report = JSON.parse(await exportedBlob.text())
	assert.equal(report.build, 'proactive-trial-8')
	assert.equal(report.extensionVersion, '1.3.0')
	assert.ok(report.entries.some(entry => entry.event === 'close_finished' && entry.closedCount === 9))
	assert.doesNotMatch(JSON.stringify(report), /furniture\.example|travel\.example|Current workspace/)
	settingsDoc.getElementById('diagnostics-enabled').checked = false
	settingsDoc.getElementById('settings-form').dispatchEvent(new settingsDom.window.Event('submit', { cancelable: true }))
	await settle(() => settingsDoc.getElementById('settings-status').textContent === 'Settings saved.', 'diagnostics opt-out saved')
	settingsDoc.getElementById('clear-diagnostics').click()
	await settle(() => settingsDoc.getElementById('diagnostics-status').textContent === 'Diagnostics cleared.', 'clear diagnostics')
	const cleared = await dom.window.chrome.runtime.sendMessage({ type: 'EXPORT_DIAGNOSTICS' })
	assert.equal(cleared.diagnostics.enabled, false)
	assert.equal(cleared.diagnostics.entries.length, 0)
	settingsDom.window.close()
	// Start as a user opening the panel when the worker fails the initial read.
	const chrome = dom.window.chrome
	const send = chrome.runtime.sendMessage
	chrome.runtime.sendMessage = message => message.type === 'GET_POPUP_STATE'
		? Promise.reject(new Error('Worker connection failed')) : send(message)
	await chrome.storage.session.set({ neatFreakPanelState: { mode: 'review', groups: [] } })
	await chrome.storage.session.set({ neatFreakPanelState: { mode: 'idle' } })
	await settle(() => shadow()?.querySelector('[data-action="retry-suggestion-load"]'), 'failed load offers Retry')
	assert.match(shadow().getElementById('suggestion-status').textContent, /Couldn’t load/)
	chrome.runtime.sendMessage = send
	click('[data-action="retry-suggestion-load"]')
	await settle(() => !shadow()?.querySelector('[data-action="retry-suggestion-load"]') && /Smart will pick/.test(tidySub()?.textContent), 'Retry brings back a working Tidy button')
	assert.equal(shadow().getElementById('suggestion-status').textContent, '')
	const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve))
	const openTabs = async () => (await new Promise(resolve => chrome.tabs.query({}, resolve))).length
	for (const tab of tabs) chrome.tabs.update(tab.id, { pinned: true })
	// With nothing prepared, the same button runs a tidy now. Nothing savable:
	// it says so.
	click('#tidy-cta')
	await settle(() => shadow()?.getElementById('title').textContent === 'Nothing to close', 'a press with nothing savable says so')
	// With review on, the press stops at the same kind of list a prepared
	// offer opens, and closes nothing until Tidy now.
	const candidate = tabs.find(tab => tab.url.startsWith('https://new.example.com/'))
	chrome.tabs.update(candidate.id, { pinned: false, lastAccessed: Date.now() - 2 * 60 * 60_000, hasUnsavedInput: false })
	document.getElementById('toolbar').click()
	// (A real popup reopens and recounts; this one stays open, so only the
	// page run shows the fresh count of 1.)
	await settle(() => (popup ? /^\d+ tabs? eligible — Smart will pick$/ : /^1 tab eligible — Smart will pick$/).test(tidySub()?.textContent), 'no offer: the button says Smart will pick')
	let releaseSave
	const saveGate = new Promise(resolve => { releaseSave = resolve })
	chrome.runtime.sendMessage = async message => {
		if (message.type === 'SAVE_TABS') await saveGate
		return send(message)
	}
	click('#tidy-cta')
	await settle(() => shadow()?.getElementById('title').textContent === 'Checking your tabs', 'the working card says Checking while a list is coming')
	releaseSave()
	await settle(() => shadow()?.querySelector('[data-action="confirm-review"]') && shadow().querySelectorAll('.review-item').length === 1, 'a press without an offer stops at a list')
	chrome.runtime.sendMessage = send
	assert.equal(shadow().getElementById('title').textContent, '1 tab ready to tidy')
	assert.match(shadow().getElementById('sub').textContent, savedLine)
	assert.equal(shadow().querySelector('[data-action="confirm-review"]').textContent, 'Tidy now')
	const cancel = shadow().querySelector('.review-footer [data-action="cancel-review"]')
	assert.ok(cancel, 'A list from a press can be cancelled')
	assert.equal(await openTabs(), tabs.length, 'The list closes nothing until Tidy now')
	// Cancel closes the popup window, which would end this run; send its
	// message instead there.
	if (popup) await chrome.runtime.sendMessage({ type: 'PANEL_DISCARD_REVIEW', sessionId: cancel.dataset.sessionId })
	else cancel.click()
	await settle(() => !shadow()?.querySelector('[data-action="confirm-review"]') || shadow().getElementById('review-shell').hidden, 'cancel leaves the list')
	assert.equal(await openTabs(), tabs.length, 'Cancel closes nothing')
	if (!popup) {
		// A page can also get a count-only nudge whose button asks for a check.
		chrome.tabs.update(candidate.id, { pinned: true })
		const findButton = () => shadow()?.querySelector('#actions [data-action="find-recommendation"]')
		const showCountNudge = () => chrome.storage.session.set({ neatFreakPanelState: { mode: 'clutter', needsPreparation: true, tabCount: tabs.length } })
		async function allowImmediateCheck() {
			const { neatFreakRecommendation: record } = await chrome.storage.session.get('neatFreakRecommendation')
			await chrome.storage.session.set({ neatFreakRecommendation: { ...record, lastExplicitAttemptAt: 0 } })
		}
		await showCountNudge()
		await settle(findButton, 'count-only nudge')
		chrome.runtime.sendMessage = message => message.type === 'REFRESH_RECOMMENDATION'
			? Promise.reject(new Error('Worker connection failed')) : send(message)
		findButton().click()
		await settle(() => shadow()?.getElementById('panel-error').textContent.includes("Couldn't finish"), 'failed check shows an error on the card')
		assert.equal(findButton().textContent, 'Find suggestions')
		await allowImmediateCheck()
		let releaseCheck
		const gate = new Promise(resolve => { releaseCheck = resolve })
		let checks = 0
		chrome.runtime.sendMessage = async message => {
			if (message.type === 'REFRESH_RECOMMENDATION') { checks++; await gate }
			return send(message)
		}
		findButton().click()
		await settle(() => checks === 1, 'Find suggestions starts one check')
		assert.equal(findButton().textContent, 'Checking tabs…')
		assert.equal(findButton().disabled, true)
		releaseCheck()
		await settle(() => shadow()?.querySelector('#suggestion-content .suggestion-none')?.textContent === 'No tabs suggested right now.', 'zero results are explicit')
		assert.equal(tidyCta().hidden, false, 'Zero results leave the Tidy button in place')
		assert.equal(shadow().getElementById('review-shell').hidden, true, 'Zero results do not open an empty review')
		chrome.runtime.sendMessage = send
		// The first inactive tab was explicitly Kept earlier in this session.
		// Only the new, previously unreviewed document should enter this preview.
		chrome.tabs.update(candidate.id, { pinned: false })
		await allowImmediateCheck()
		await showCountNudge()
		await settle(findButton, 'count-only nudge again')
		findButton().click()
		await settle(() => shadow()?.getElementById('review-shell').hidden === false && shadow().querySelectorAll('.review-item').length === 1, 'one click opens a real preview')
		assert.equal(await openTabs(), tabs.length, 'Finding suggestions never closes a tab')
	}
	const background = fs.readFileSync('src/background.js', 'utf8')
	const start = background.indexOf('function collectPageSignals(maxChars) {')
	const end = background.indexOf('async function closeSavedTabs(', start)
	const collector = background.slice(start, end).trim()
	const forms = new JSDOM('<!doctype html><input id="field"><textarea id="text"></textarea><div id="editor" contenteditable="true"></div>', { url: 'https://forms.example.test/', runScripts: 'outside-only' })
	forms.window.HTMLElement.prototype.getClientRects = function () { return [{}] }
	forms.window.eval(collector)
	const form = forms.window.document
	form.getElementById('field').value = 'x'
	assert.equal(forms.window.collectPageSignals(0).hasUnsavedInput, true, 'One-character drafts are protected')
	assert.equal(forms.window.collectPageSignals(0).summary, '', 'Summary opt-out is respected')
	form.getElementById('field').value = ''
	form.getElementById('editor').textContent = 'Unsent draft'
	assert.equal(forms.window.collectPageSignals(0).hasUnsavedInput, true, 'Rich-text drafts are protected')
	form.getElementById('editor').textContent = ''
	assert.equal(forms.window.collectPageSignals(0).hasUnsavedInput, false)
	function checkForm(html, edit, dirty, label) {
		form.body.innerHTML = html
		edit?.(form)
		const signals = forms.window.collectPageSignals(0)
		assert.equal(signals.signalsUnavailable, false, label)
		assert.equal(signals.hasUnsavedInput, dirty, label)
	}
	checkForm('<input value="original">', doc => { doc.querySelector('input').value = '' }, true, 'Cleared text is an unsaved edit')
	checkForm('<input type="checkbox">', doc => { doc.querySelector('input').checked = true }, true, 'Changed checkbox')
	checkForm('<input type="radio" checked>', doc => { doc.querySelector('input').checked = false }, true, 'Changed radio')
	checkForm('<select><option>A</option><option>B</option></select>', null, false, 'Implicit initial selection is clean')
	checkForm('<select><option>A</option><option selected>B</option></select>', null, false, 'Explicit initial selection is clean')
	checkForm('<select size="3"><option>A</option><option>B</option></select>', null, false, 'A listbox without a default selection is clean')
	checkForm('<select><option>A</option><option>B</option></select>', doc => { doc.querySelector('select').selectedIndex = 1 }, true, 'Changed selection')
	checkForm('<select multiple><option selected>A</option><option>B</option></select>', doc => { doc.querySelector('select').options[0].selected = false }, true, 'Cleared multiple selection')
	checkForm('<input type="file">', doc => { Object.defineProperty(doc.querySelector('input'), 'files', { value: [new forms.window.File(['draft'], 'draft.txt')] }) }, true, 'Unsubmitted file')
	checkForm('<div contenteditable="plaintext-only">Draft</div>', null, true, 'Plaintext rich editor')
	checkForm('<section id="host"></section>', doc => {
		const root = doc.getElementById('host').attachShadow({ mode: 'open' })
		root.innerHTML = '<textarea></textarea>'
		root.querySelector('textarea').value = 'Shadow draft'
	}, true, 'Open shadow DOM draft')
	checkForm('<input type="password">', doc => { Object.defineProperty(doc.querySelector('input'), 'value', { get() { throw new Error('Password must not be read') } }) }, false, 'Password value is never inspected')
	checkForm('<input value="x" disabled>', doc => { doc.querySelector('input').value = 'y' }, false, 'Disabled control is not a draft')
	form.body.innerHTML = '<input>'
	Object.defineProperty(form.querySelector('input'), 'value', { get() { throw new Error('Broken page control') } })
	assert.equal(forms.window.collectPageSignals(0).signalsUnavailable, true, 'Failed form inspection fails closed')
	form.body.innerHTML = '<main><p id="public">Public article</p><div contenteditable="true"><p id="draft">Private unsent draft</p></div></main>'
	Object.defineProperty(form.getElementById('public'), 'innerText', { value: 'A public article paragraph long enough to summarize safely.' })
	Object.defineProperty(form.getElementById('draft'), 'innerText', { value: 'Private unsent draft content should never be in the summary.' })
	const signals = forms.window.collectPageSignals(720)
	assert.match(signals.summary, /public article/)
	assert.doesNotMatch(signals.summary, /Private unsent/)
	assert.equal(signals.hasUnsavedInput, true)
	forms.window.close()
	process.stdout.write('PASS: one Tidy button (offer ready / stale / expired / none) -> local Tidy opens list -> fold/unfold -> Keep -> refresh -> safe close -> diagnostics export/opt-out/clear -> press without an offer stops at a list; form protections\n')
} finally { dom.window.close() }
