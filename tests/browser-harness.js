import { createChromeHarness } from './helpers/chrome-harness.js'
const groups = [
	['Furniture research', 'https://furniture.example.com/article/'],
	['Neat Freak development', 'https://development.example.com/article/'],
	['Summer travel', 'https://travel.example.com/article/'],
]
const tabs = Array.from({ length: 13 }, (_, index) => ({
	id: index + 1, windowId: 1, index, active: index === 0,
	title: index === 0 ? 'Current workspace' : `${groups[Math.floor((index - 1) / 4)][0]} ${index}`,
	url: index === 0 ? 'https://workspace.example.com' : `${groups[Math.floor((index - 1) / 4)][1]}${index}`,
	lastAccessed: Date.now() - 120 * 60_000,
}))
const baseUrl = new URL('../', location.href).href
const harness = createChromeHarness({ tabs, baseUrl, browser: true })
// Test-only API substitutes are deliberately confined to this page.
window.chrome = harness.chrome
if (new URL(location.href).searchParams.has('popup')) {
	const originalGetURL = chrome.runtime.getURL
	chrome.runtime.getURL = path => path === 'popup.html' ? location.href : originalGetURL(path)
}
await import('../src/background.js')
await chrome.runtime.sendMessage({ type: 'REFRESH_RECOMMENDATION' })
await import('../src/neat-freak-panel.js')

function updateStatus() {
	const state = harness.data.session.neatFreakPanelState
	document.getElementById('status').textContent = JSON.stringify({
		mode: state?.mode, prepared: harness.data.session.neatFreakRecommendation?.plan?.tabs.length,
		openSyntheticTabs: harness.tabs.length, closedSyntheticTabIds: harness.removed,
		sessions: harness.data.local.tabAtlasSessions.map(session => ({ status: session.closeStatus, savedTabs: session.tabs.length, pending: session.pendingTabIds })),
	}, null, 2)
}
chrome.storage.onChanged.addListener(updateStatus)
async function nudge() {
	const response = await chrome.runtime.sendMessage({ type: 'GET_RECOMMENDATION' })
	await chrome.storage.session.set({ neatFreakPanelState: { mode: 'clutter', ...response.recommendation } })
}
document.getElementById('nudge').onclick = nudge
document.getElementById('toolbar').onclick = async () => {
	await chrome.storage.session.set({ neatFreakPanelState: { mode: 'idle' } })
}
document.getElementById('change').onclick = () => {
	const tab = harness.tabs.find(tab => tab.id === 3)
	if (tab) { tab.lastAccessed = Date.now(); tab.url += '?new-document' }
	const formTab = harness.tabs.find(tab => tab.id === 4)
	if (formTab) formTab.hasUnsavedInput = true
	harness.tabs.push({ ...tabs[2], id: 99, url: 'https://new.example.com/article/99', lastAccessed: Date.now() })
	chrome.tabs.onUpdated.emit(3, { url: tab?.url })
	updateStatus()
}
document.getElementById('refresh-age').onclick = async () => {
	for (const tab of harness.tabs) tab.lastAccessed = Date.now() - 120 * 60_000
	const record = harness.data.session.neatFreakRecommendation
	if (record) record.lastAttemptAt = 0
	await chrome.runtime.sendMessage({ type: 'REFRESH_RECOMMENDATION' })
	updateStatus()
}
document.getElementById('popup').onclick = () => { location.search = '?popup=1' }
await nudge()
updateStatus()
