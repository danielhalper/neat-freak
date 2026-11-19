// Usage: node tests/panel-intent.qa.mjs /path/to/jsdom/lib/api.js
// Opening the panel with AI on and no fresh list starts a run: the Tidy line
// reads "Checking your tabs" until the list arrives, and a press before then
// works as a press with nothing prepared. Synthetic tabs only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const { JSDOM, VirtualConsole } = await import(pathToFileURL(process.argv[2]).href)
const output = `/tmp/neat-freak-qa/panel-intent-${process.pid}.html`
execFileSync(process.execPath, ['tests/render-browser-harness.mjs', output])
const errors = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', error => errors.push(error.message))
const dom = new JSDOM(fs.readFileSync(output, 'utf8'), {
	url: 'https://qa.example.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
	beforeParse(window) {
		window.structuredClone = structuredClone
		window.fetch = async () => { throw new Error('Offline QA') }
		window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
		window.confirm = () => true
	},
})
async function settle(predicate, label) {
	for (let i = 0; i < 200; i++) {
		await new Promise(resolve => setTimeout(resolve, 10))
		if (predicate()) return
	}
	throw new Error(`Did not settle: ${label}; sub=${tidySub()?.textContent}; errors=${errors}`)
}
const document = dom.window.document
const shadow = () => document.getElementById('__neat-freak-panel__')?.shadowRoot
const tidySub = () => shadow()?.getElementById('tidy-cta-sub')
const panelMode = async () => (await chrome.storage.session.get('neatFreakPanelState')).neatFreakPanelState?.mode
let chrome
try {
	await settle(() => shadow()?.getElementById('title')?.textContent === '12 tabs ready to tidy', 'harness ready')
	chrome = dom.window.chrome
	// AI on with background preparation; the settings change retires the old list.
	const { tabAtlasSettings } = await chrome.storage.local.get('tabAtlasSettings')
	await chrome.storage.local.set({ tabAtlasSettings: { ...tabAtlasSettings, llmEnabled: true, prepareSuggestions: true } })
	// The harness pressed Refresh at boot; start outside its 30-second cooldown.
	const boot = (await chrome.storage.session.get('neatFreakRecommendation')).neatFreakRecommendation
	await chrome.storage.session.set({ neatFreakRecommendation: { ...boot, lastExplicitAttemptAt: 0 } })
	// Hold page inspection so the run stays in flight.
	let release
	let gate = new Promise(resolve => { release = resolve })
	const execute = chrome.scripting.executeScript.bind(chrome.scripting)
	chrome.scripting.executeScript = async (options, callback) => { if (!options.files) await gate; return execute(options, callback) }

	document.getElementById('toolbar').click()
	await settle(() => tidySub()?.textContent === 'Checking your tabs', 'checking line on open')
	assert.equal(tidySub().classList.contains('ready'), false, 'nothing is offered while checking')
	release()
	await settle(() => tidySub()?.classList.contains('ready') && /^12 tabs ready to (review|tidy)$/.test(tidySub().textContent), 'fresh list arrives')

	// Reopen with a list over 30 minutes old and press Tidy before the run ends.
	const record = (await chrome.storage.session.get('neatFreakRecommendation')).neatFreakRecommendation
	record.plan.createdAt -= 40 * 60_000
	record.lastExplicitAttemptAt = 0
	await chrome.storage.session.set({ neatFreakRecommendation: record, neatFreakPanelState: { mode: 'hidden' } })
	gate = new Promise(resolve => { release = resolve })
	document.getElementById('toolbar').click()
	await settle(() => tidySub()?.textContent === 'Checking your tabs', 'checking line for an old list')
	shadow().getElementById('tidy-cta').click()
	for (let i = 0; i < 50 && (await panelMode()) === 'idle'; i++) await new Promise(resolve => setTimeout(resolve, 10))
	assert.notEqual(await panelMode(), 'idle', 'the press runs a tidy with nothing prepared')
	release()
	for (let i = 0; i < 100 && (await panelMode()) === 'saving'; i++) await new Promise(resolve => setTimeout(resolve, 10))
	assert.notEqual(await panelMode(), 'idle', 'the late check does not reopen the offer')
	assert.deepEqual(errors, [])
	process.stdout.write('PASS: panel open with no fresh list -> "Checking your tabs" -> fresh list; a press during the check tidies as with nothing prepared\n')
} finally { dom.window.close() }
