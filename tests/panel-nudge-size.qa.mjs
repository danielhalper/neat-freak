// Usage: node tests/panel-nudge-size.qa.mjs /path/to/jsdom/lib/api.js
// Nudge lists now aim at the tab goal, so a card can carry 30-50 tabs. The
// card must still show the count and keep Review next to Tidy now, and the
// list must open with every tab. Synthetic tabs only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const { JSDOM, VirtualConsole } = await import(pathToFileURL(process.argv[2]).href)
const output = `/tmp/neat-freak-qa/panel-nudge-size-${process.pid}.html`
execFileSync(process.execPath, ['tests/render-browser-harness.mjs', output])
const errors = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', error => errors.push(error.message))
const dom = new JSDOM(fs.readFileSync(output, 'utf8'), {
	url: 'https://qa.example.test/?tabs=41', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
	beforeParse(window) {
		window.structuredClone = structuredClone
		window.fetch = async () => { throw new Error('Offline QA') }
		window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
		window.confirm = () => true
	},
})
const shadow = () => dom.window.document.getElementById('__neat-freak-panel__')?.shadowRoot
async function settle(predicate, label) {
	for (let i = 0; i < 300; i++) {
		await new Promise(resolve => setTimeout(resolve, 10))
		if (predicate()) return
	}
	throw new Error(`Did not settle: ${label}; title=${shadow()?.getElementById('title')?.textContent}; errors=${errors}`)
}
try {
	await settle(() => shadow()?.getElementById('title')?.textContent === '40 tabs ready to tidy', '40-tab nudge card')
	const tidy = shadow().querySelector('#actions [data-action="tidy-recommendation"]')
	const review = tidy?.previousElementSibling
	assert.equal(review?.textContent, 'Review', 'Review sits just left of Tidy now')
	// One press can close 40 tabs, so Review is a bordered button, not a text
	// link. jsdom lets page styles leak into the shadow root, so read the
	// panel's own rule rather than computed styles.
	assert.equal(review.tagName, 'BUTTON')
	assert.equal(review.classList.contains('tertiary-link'), false)
	const toggleRule = shadow().querySelector('style').textContent.match(/\n\s*\.offer-toggle \{[^}]*\}/)?.[0] || ''
	assert.match(toggleRule, /border: 1px solid #/, 'Review has a visible border')
	assert.match(toggleRule, /align-self: stretch/, 'Review matches Tidy now in height')
	// Nothing is saved yet, so the card says what will happen.
	assert.equal(shadow().getElementById('sub').textContent, "They'll go into a folder you can reopen.")
	review.click()
	await settle(() => shadow().querySelectorAll('.review-item').length === 40, 'list opens with all 40 tabs')
	assert.equal(shadow().getElementById('title').textContent, '40 tabs ready to tidy', 'the count stays in the header with the list open')
	const hide = shadow().querySelector('.review-footer [data-action="tidy-recommendation"]')?.previousElementSibling
	assert.equal(hide?.textContent, 'Hide list', 'Hide list sits just left of Tidy now')
	assert.ok(hide.classList.contains('offer-toggle'), 'Hide list is the same bordered button')
	assert.doesNotMatch(shadow().getElementById('sub').textContent, /saved/i)
	assert.deepEqual(errors, [])
	process.stdout.write('PASS: 40-tab nudge card shows its count, bordered Review/Hide list next to Tidy now, future-tense copy, and a 40-row list\n')
} finally { dom.window.close() }
