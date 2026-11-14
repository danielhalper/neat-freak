// Synthetic browser only. No user tabs or backend requests are touched.
export function createChromeHarness({ tabs = [], baseUrl = 'chrome-extension://test/', browser = false } = {}) {
	function event() {
		const listeners = []
		return { addListener(fn) { listeners.push(fn) }, removeListener(fn) { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1) }, emit(...args) { return Promise.all(listeners.map(fn => fn(...args))) }, listeners }
	}
	const changed = event()
	const data = {
		local: { tabAtlasSettings: { llmEnabled: false, installId: 'test-install', settingsVersion: 9, collectPageSummaries: true, clutterThreshold: 5 }, tabAtlasSessions: [] },
		session: {},
	}
	let currentTabs = structuredClone(tabs)
	const removed = []
	const probes = []
	const injected = []
	const failures = new Set()
	let focused = true
	let failStorage = false
	let onRemove = null
	function area(name) {
		return {
			async get(keys, callback) {
				const result = keys == null ? structuredClone(data[name]) : typeof keys === 'string' ? { [keys]: data[name][keys] }
					: Array.isArray(keys) ? Object.fromEntries(keys.map(key => [key, data[name][key]])) : { ...keys, ...data[name] }
				callback?.(structuredClone(result)); return structuredClone(result)
			},
			async set(values, callback) {
				if (failStorage && name === 'local') {
					chrome.runtime.lastError = { message: 'Simulated storage failure' }
					callback?.(); chrome.runtime.lastError = null; return
				}
				const changes = {}
				for (const [key, value] of Object.entries(values)) {
					if (JSON.stringify(data[name][key]) === JSON.stringify(value)) continue
					changes[key] = { oldValue: data[name][key], newValue: structuredClone(value) }
					data[name][key] = structuredClone(value)
				}
				callback?.()
				if (Object.keys(changes).length) await changed.emit(changes, name)
			},
			async remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[name][key]; callback?.() },
			async setAccessLevel() {},
		}
	}
	const messages = event()
	async function send(message) {
		return new Promise(resolve => messages.listeners[0](message, {}, resolve))
	}
	const chrome = {
		runtime: { id: 'test', lastError: null, onMessage: messages, onInstalled: event(), onStartup: event(), onConnect: event(),
			getManifest: () => ({ version: '1.3.0' }),
			getURL: path => new URL(path, baseUrl).href,
			sendMessage: message => message.type === 'SAVE_PROGRESS' ? Promise.resolve() : send(message),
			connect() { return { onDisconnect: event(), disconnect() {} } }, openOptionsPage() {},
		},
		storage: { local: area('local'), session: area('session'), onChanged: changed },
		tabs: {
			onCreated: event(), onRemoved: event(), onUpdated: event(), onActivated: event(), onReplaced: event(),
			query(query, callback) { callback(structuredClone(currentTabs.filter(tab => (!query.active || tab.active) && (!query.currentWindow || tab.windowId === 1) && (!query.lastFocusedWindow || tab.windowId === 1)))) },
			get(id, callback) { const tab = currentTabs.find(tab => tab.id === id); if (!tab) chrome.runtime.lastError = { message: 'No tab' }; callback(tab ? structuredClone(tab) : null); chrome.runtime.lastError = null },
			remove(ids, callback) {
				for (const id of ids) {
					if (failures.has(id)) { chrome.runtime.lastError = { message: 'Simulated close failure' }; callback?.(); chrome.runtime.lastError = null; return }
					onRemove?.(id)
					removed.push(id); currentTabs = currentTabs.filter(tab => tab.id !== id)
				}
				callback?.(); chrome.tabs.onRemoved.emit(ids[0], {})
			},
			create(props, callback) { const tab = { id: Math.max(0, ...currentTabs.map(tab => tab.id)) + 1, windowId: 1, ...props }; currentTabs.push(tab); callback?.(tab) },
			update(id, props, callback) { const tab = currentTabs.find(tab => tab.id === id); Object.assign(tab, props); callback?.(tab) },
		},
		windows: { onFocusChanged: event(), async getLastFocused() { return { id: 1, focused } }, update(id, props, callback) { callback?.({ id, ...props }) } },
		scripting: { async executeScript(options, callback) {
			let result
			if (options.files) { injected.push(options.target.tabId); result = []; }
			else {
				const tab = currentTabs.find(tab => tab.id === options.target.tabId)
				probes.push(tab?.id)
				result = !tab || tab.probeFails ? [] : [{ frameId: 0, result: { url: tab.url, summary: tab.title, hasUnsavedInput: Boolean(tab.hasUnsavedInput), signalsUnavailable: Boolean(tab.signalsUnavailable) } }]
			}
			callback?.(result); return result
		} },
		action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
		notifications: { onClicked: event(), create(id, options, callback) { callback?.() }, clear() {} },
		alarms: { onAlarm: event(), create() {}, async get() { return { name: 'neat-freak-clutter-check' } } },
	}
	return { chrome, data, removed, probes, injected, failures, send,
		get tabs() { return currentTabs }, set tabs(value) { currentTabs = value },
		set focused(value) { focused = value }, set failStorage(value) { failStorage = value },
		set onRemove(fn) { onRemove = fn },
	}
}
