import {
	PLAN_REFRESH_MS, PLAN_MAX_AGE_MS, MANUAL_REFRESH_MS, reconcileRecommendation,
	settingsIdentity, excludeFromPlan, tabIdentity, recommendationInputKey, aiPickFields,
} from './tidy-plan.js'

// Dependency injection keeps MV3 lifecycle, concurrent refreshes and delayed
// clicks testable without changing the shipped algorithm or mocking its output.
export function createRecommendationService(deps) {
	let mutations = Promise.resolve()
	let computation = null
	let computationGeneration = -1
	let generation = 0
	const now = deps.now || Date.now

	async function record(event, fields) {
		try { await deps.record?.(event, fields) } catch { /* diagnostics are optional */ }
	}

	function mutate(fn) {
		const next = mutations.then(fn, fn)
		mutations = next.catch(() => {})
		return next
	}

	async function readState() {
		return { exclusions: [], ...(await deps.read()) }
	}

	async function get() {
		return mutate(async () => {
			const state = await readState()
			const settings = await deps.settings()
			if (state.plan?.settingsKey !== settingsIdentity(settings)) return null
			const plan = excludeFromPlan(reconcileRecommendation(state.plan, await deps.queryTabs(), now()), state.exclusions)
			if (JSON.stringify(plan) !== JSON.stringify(state.plan)) {
				await deps.write({ ...state, plan })
				if (plan.tabs.length < state.plan.tabs.length) await record('suggestion_pruned', {
					run: plan.id.replace(/^plan-/, 'run_'), previousCount: state.plan.tabs.length,
					suggestedCount: plan.tabs.length, ageMs: now() - plan.createdAt,
				})
			}
			return plan
		})
	}

	async function compute(force) {
		const startedAt = now()
		const stamp = generation
		const settings = await deps.settings()
		const snapshot = await deps.queryTabs()
		const inputKey = recommendationInputKey(snapshot, now())
		const reserved = await mutate(async () => {
			const state = await readState()
			if (!force && state.plan?.settingsKey === settingsIdentity(settings)
				&& state.inputKey === inputKey && now() - state.plan.createdAt < PLAN_MAX_AGE_MS) return false
			const interval = force ? MANUAL_REFRESH_MS : PLAN_REFRESH_MS
			const last = force ? state.lastExplicitAttemptAt : state.lastAttemptAt
			if (last && now() - last < interval) return false
			await deps.write({ ...state, lastAttemptAt: now(), ...(force ? { lastExplicitAttemptAt: now() } : {}) })
			return true
		})
		if (!reserved) return get()
		const tabs = await deps.capture(snapshot.filter(tab => /^https?:/.test(tab.url || '') && !tab.active && !tab.pinned && !tab.incognito), settings)
		const result = await deps.select(tabs, settings, { automatic: !force })
		const plan = {
			id: deps.createId(), createdAt: now(), settingsKey: settingsIdentity(settings),
			snapshot: snapshot.map(tab => ({ id: tab.id, url: tab.url })),
			tabs: result.saveSet, categories: result.categories,
			mode: result.mode, error: result.error || '', stale: false, ...aiPickFields(result, tabs),
			localReason: result.localReason || (settings.llmEnabled ? 'ai-unavailable' : 'ai-off'),
			reviewRequired: result.mode !== 'llm', reviewed: false,
		}
		return mutate(async () => {
			const state = await readState()
			if (stamp !== generation || settingsIdentity(await deps.settings()) !== plan.settingsKey) return null
			const next = excludeFromPlan(reconcileRecommendation(plan, await deps.queryTabs(), now()), state.exclusions)
			await deps.write({ ...state, inputKey, plan: next })
			await record('suggestion_prepared', {
				run: next.id.replace(/^plan-/, 'run_'), automatic: !force,
				candidateCount: tabs.length, suggestedCount: next.tabs.length,
				folderCount: next.categories.length, mode: next.mode,
				reason: next.mode === 'llm' ? undefined : next.localReason,
				errorCode: result.errorCode, durationMs: now() - startedAt,
			})
			// Opt-in tab habits log: every candidate and whether it was offered.
			try { deps.prepared?.({ tabs, plan: next, automatic: !force, live: snapshot }) } catch { /* optional */ }
			return next
		})
	}

	async function refresh({ force = false } = {}) {
		if (computation && computationGeneration === generation) return computation
		computationGeneration = generation
		const pending = compute(force).finally(() => { if (computation === pending) computation = null })
		computation = pending
		return pending
	}

	async function exclude(planId, tabIds) {
		return mutate(async () => {
			const state = await readState()
			if (state.plan?.id !== planId) throw new Error('This recommendation changed. Refresh to review the latest tabs.')
			const ids = new Set(tabIds)
			const exclusions = [...new Set([...state.exclusions, ...(state.review?.planId === planId ? state.review.tabs : state.plan.tabs).filter(tab => ids.has(tab.id)).map(tabIdentity)])]
			const plan = excludeFromPlan(state.plan, exclusions)
			await deps.write({ ...state, exclusions, plan })
			return plan
		})
	}

	async function beginReview(planId) {
		generation += 1
		return mutate(async () => {
			const state = await readState()
			if (state.plan?.id !== planId) throw new Error('This recommendation changed. Refresh to review the latest tabs.')
			await deps.write({ ...state, plan: { ...state.plan, reviewed: true }, review: { planId, tabs: state.plan.tabs } })
		})
	}

	function cancelRefresh() { generation += 1 }

	async function claim(planId) {
		generation += 1
		return mutate(async () => {
			const state = await readState()
			if (!state.plan || state.plan.id !== planId) throw new Error('This suggestion was already used or replaced. Refresh for a new one.')
			if (state.plan.reviewRequired && !state.plan.reviewed) throw new Error('Review these local suggestions before closing tabs.')
			await deps.write({ ...state, plan: null, consumedPlanId: planId })
		})
	}

	async function invalidate() {
		generation += 1
		await mutate(async () => {
			const state = await readState()
			await deps.write({ ...state, plan: null })
		})
	}

	return { get, refresh, exclude, invalidate, cancelRefresh, claim, beginReview }
}
