import { tabChangeReason } from './tidy-plan.js'

// Durable storage is the caller's responsibility BEFORE entering this function.
// Bounded workers avoid a string of slow page probes blocking an entire tidy.
export async function closeValidatedTabs(tabs, deps, options = {}) {
	const outcomes = new Array(tabs.length)
	let cursor = 0
	async function inspect(saved) {
		const id = saved.originalTabId
		let live = await deps.getTab(id)
		let reason = tabChangeReason(saved, live, options)
		if (!reason && !live.discarded) {
			const signals = await deps.probe(id).catch(() => ({ signalsUnavailable: true }))
			if (signals.signalsUnavailable || signals.hasUnsavedInput) reason = 'unsaved-or-unknown'
			if (signals.url && signals.url !== saved.url) reason = 'navigated'
		}
		// Chrome offers no atomic compare-and-remove. Recheck immediately before
		// remove; never await a model or storage operation in that final gap.
		if (!reason) {
			live = await deps.getTab(id)
			reason = tabChangeReason(saved, live, options)
		}
		if (reason === 'closed') return { kind: 'gone', tab: saved }
		if (reason) return { kind: 'skipped', tab: saved, reason }
		try {
			await deps.remove(id)
			return { kind: 'closed', tab: saved }
		} catch {
			return { kind: await deps.getTab(id) ? 'failed' : 'gone', tab: saved }
		}
	}
	async function worker() {
		while (cursor < tabs.length) {
			const index = cursor++
			outcomes[index] = await inspect(tabs[index])
		}
	}
	await Promise.all(Array.from({ length: Math.min(4, tabs.length) }, worker))
	return {
		closed: outcomes.filter(item => item.kind === 'closed').map(item => item.tab),
		gone: outcomes.filter(item => item.kind === 'gone').map(item => item.tab),
		failed: outcomes.filter(item => item.kind === 'failed').map(item => item.tab),
		skipped: outcomes.filter(item => item.kind === 'skipped'),
	}
}
