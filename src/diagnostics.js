// Local, bounded diagnostics. Never pass arbitrary payloads into the journal.
import { OVER_GOAL_BANDS } from './nudge-cycle.js'
export const DIAGNOSTICS_KEY = 'neatFreakDiagnostics'
export const DIAGNOSTICS_BUILD = 'proactive-trial-7'
export const DIAGNOSTICS_LIMIT = 500
export const DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60_000

const events = new Set(['action', 'suggestion_prepared', 'suggestion_pruned', 'nudge_shown', 'nudge_retired', 'review_opened', 'keep_changed', 'close_finished', 'restore_finished', 'background_error'])
const actions = new Set(['REFRESH_RECOMMENDATION', 'REVIEW_RECOMMENDATION', 'EXECUTE_RECOMMENDATION', 'PANEL_DISMISS', 'PANEL_TIDY_NOW', 'PANEL_CONFIRM_REVIEW', 'PANEL_DISCARD_REVIEW', 'SAVE_TABS', 'CLOSE_SAVED_TABS', 'RESTORE_TAB', 'RESTORE_GROUP', 'RESTORE_SESSION', 'RESTORE_ALL_SESSIONS', 'TEST_LLM', 'OPEN_PANEL_FROM_ICON'])
const counts = ['candidateCount', 'suggestedCount', 'folderCount', 'previousCount', 'keptCount', 'closedCount', 'protectedCount', 'failedCount', 'goneCount', 'restoredCount', 'durationMs', 'ageMs', 'promptTokens', 'completionTokens', 'tabCount', 'doublingStep', 'targetCount', 'floorAdded']
const enums = {
	action: actions,
	mode: new Set(['llm', 'heuristic']),
	reason: new Set(['ai-off', 'ai-unavailable', 'background-limit', 'expired', 'empty', 'unavailable', 'replaced']),
	errorCode: new Set(['timeout', 'connection', 'quota', 'storage', 'busy', 'suggestion-unavailable', 'invalid-session', 'unknown']),
	nudgeKind: new Set(['first', 'reminder']),
	cycleStart: new Set(['time', 'growth']),
	quietBand: new Set(OVER_GOAL_BANDS.map(band => band.name)),
	errorType: new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError']),
}

const locationPattern = /^(background|recommendations|tidy-plan|safe-close|smart-scope|categorizer|storage|diagnostics|neat-freak-panel|options)\.js:\d{1,6}:\d{1,6}$/

export function diagnosticDetails(error) {
	const location = String(error?.stack || '').match(/\/(background|recommendations|tidy-plan|safe-close|smart-scope|categorizer|storage|diagnostics|neat-freak-panel|options)\.js:(\d{1,6}):(\d{1,6})(?:\)|\s|$)/)
	return { errorCode: diagnosticError(error), errorType: error?.name,
		errorLocation: location ? `${location[1]}.js:${location[2]}:${location[3]}` : undefined }
}

export function diagnosticError(error) {
	const message = String(error?.message || error || '').toLowerCase()
	if (/abort|timeout|timed out/.test(message)) return 'timeout'
	if (/quota|429|rate.limit/.test(message)) return 'quota'
	if (/storage/.test(message)) return 'storage'
	if (/fetch|network|token service|backend|connection|receiving end|context invalidated/.test(message)) return 'connection'
	if (/in progress/.test(message)) return 'busy'
	if (/suggestion|recommendation/.test(message)) return 'suggestion-unavailable'
	if (/session/.test(message)) return 'invalid-session'
	return 'unknown'
}

function safeEvent(event, fields, at) {
	if (!events.has(event)) return null
	if (event === 'action' && !actions.has(fields.action)) return null
	const entry = { event, at }
	for (const key of counts) {
		if (Number.isFinite(fields[key]) && fields[key] >= 0) entry[key] = Math.min(1_000_000_000, Math.round(fields[key]))
	}
	for (const [key, allowed] of Object.entries(enums)) {
		if (allowed.has(fields[key])) entry[key] = fields[key]
	}
	for (const key of ['automatic', 'ok', 'discarded']) {
		if (typeof fields[key] === 'boolean') entry[key] = fields[key]
	}
	if (locationPattern.test(fields.errorLocation || '')) entry.errorLocation = fields.errorLocation
	// IDs are generated here, never copied from messages, URLs, or page data.
	if (/^run_[a-z0-9-]{1,80}$/i.test(fields.run || '')) entry.run = fields.run
	return entry
}

export function createDiagnostics({ read, write, enabled, now = Date.now }) {
	let queue = Promise.resolve()
	function serial(operation) {
		const next = queue.then(operation)
		queue = next.catch(() => {})
		return next
	}
	async function retained() {
		const stored = await read()
		return (Array.isArray(stored) ? stored : [])
			.filter(entry => Number.isFinite(entry?.at) && entry.at >= now() - DIAGNOSTICS_MAX_AGE_MS && entry.at <= now())
			.map(entry => safeEvent(entry.event, entry, entry.at)).filter(Boolean).slice(-DIAGNOSTICS_LIMIT)
	}
	function record(event, fields = {}) {
		const entry = safeEvent(event, fields, now())
		if (!entry) return Promise.resolve(false)
		return serial(async () => {
			if (!await enabled()) return false
			await write([...(await retained()), entry].slice(-DIAGNOSTICS_LIMIT))
			return true
		}).catch(() => false) // Diagnostics must never prevent saving or closing.
	}
	function exportLog() {
		return serial(async () => {
			const entries = await retained()
			await write(entries)
			return { schemaVersion: 1, build: DIAGNOSTICS_BUILD, exportedAt: now(), enabled: await enabled(), retentionDays: 7, maxEntries: DIAGNOSTICS_LIMIT, entries }
		})
	}
	function clear() { return serial(() => write([])) }
	function prune() { return serial(async () => write(await retained())).catch(() => false) }
	return { record, exportLog, clear, prune }
}
