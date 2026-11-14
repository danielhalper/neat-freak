import { classifyDelta } from './clutter-reminder.js'

// A recommendation is an offer to close this exact set. Reconciliation may
// shrink it, but only a new, explicitly presented plan may add tabs.
export const PLAN_REFRESH_MS = 15 * 60_000
export const PLAN_MAX_AGE_MS = 60 * 60_000
export const MANUAL_REFRESH_MS = 30_000

export function tabIdentity(tab) {
	return `${tab.originalTabId ?? tab.id}:${tab.url || ''}`
}

export function settingsIdentity(settings) {
	return JSON.stringify([
		settings.llmEnabled, settings.llmModel, settings.tokenServiceUrl,
		settings.collectPageSummaries, settings.maxSnippetChars,
		settings.prepareSuggestions,
	])
}

export function recommendationInputKey(tabs, now) {
	return JSON.stringify(tabs.map(tab => {
		const minutes = Number.isFinite(tab.lastAccessed) ? (now - tab.lastAccessed) / 60_000 : 0
		return [tab.id, tab.url, tab.title, tab.lastAccessed, tab.active, tab.audible,
			tab.pinned, tab.discarded, tab.status, minutes > 90 ? 2 : minutes > 30 ? 1 : 0]
	}).sort((a, b) => a[0] - b[0]))
}

export function trimPlan(plan, tabs) {
	const ids = new Set(tabs.map(tab => tab.id))
	return {
		...plan,
		tabs,
		categories: (plan.categories || [])
			.map(group => ({ ...group, tabIds: group.tabIds.filter(id => ids.has(id)) }))
			.filter(group => group.tabIds.length),
	}
}

export function tabChangeReason(saved, live, { protectPinned = true, protectAccess = true, protectActive = true } = {}) {
	if (!live) return 'closed'
	if (live.incognito) return 'incognito'
	if (live.url !== saved.url || (live.pendingUrl && live.pendingUrl !== saved.url)) return 'navigated'
	if (live.active && (protectActive || !saved.active)) return 'active'
	if (live.audible) return 'audio'
	if (live.pinned && (protectPinned || !saved.pinned)) return 'pinned'
	if (live.status === 'loading') return 'loading'
	if (live.hasUnsavedInput || live.signalsUnavailable) return 'unsaved-or-unknown'
	if (protectAccess && Number.isFinite(live.lastAccessed)
		&& (!Number.isFinite(saved.lastAccessed) || live.lastAccessed > saved.lastAccessed)) return 'accessed'
	return ''
}

export function reconcileRecommendation(plan, liveTabs, now = Date.now()) {
	if (!plan) return null
	const liveById = new Map(liveTabs.map(tab => [tab.id, tab]))
	const tabs = plan.tabs.filter(tab => !tabChangeReason(tab, liveById.get(tab.originalTabId)))
	const delta = classifyDelta(plan.snapshot, liveTabs)
	const changed = delta.removed.length || delta.added.length || delta.navigated.length
	return {
		...trimPlan(plan, tabs),
		stale: Boolean(plan.stale || changed || tabs.length !== plan.tabs.length || now - plan.createdAt >= PLAN_REFRESH_MS),
		expired: now - plan.createdAt >= PLAN_MAX_AGE_MS,
	}
}

// Keep choices survive a refresh for this tab+URL, without learning a broad
// domain preference from a single click. They expire with this browser session.
export function excludeFromPlan(plan, exclusions) {
	if (!plan) return null
	const keys = new Set(exclusions || [])
	return trimPlan(plan, plan.tabs.filter(tab => !keys.has(tabIdentity(tab))))
}
