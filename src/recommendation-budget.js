// Local, durable attempt counter. Reserving before the request also bounds
// failures and worker restarts. Explicit user requests do not use this budget.
// A backstop: the nudge cycle (nudge-cycle.js) allows one automatic run per
// cycle, so normal use stays well under it.
export const AUTOMATIC_AI_LIMIT = 12

export function createRecommendationBudget({ read, write, now = Date.now }) {
	let queue = Promise.resolve()
	async function used() {
		const previous = await read()
		return previous?.day === Math.floor(now() / 86_400_000) ? previous.used || 0 : 0
	}
	function reserve() {
		const pending = queue.then(async () => {
			const day = Math.floor(now() / 86_400_000)
			const count = await used()
			if (count >= AUTOMATIC_AI_LIMIT) return false
			await write({ day, used: count + 1 })
			return true
		})
		queue = pending.catch(() => {})
		return pending
	}
	// Read-only check, so a capped day inspects no pages at all.
	async function available() {
		return (await used()) < AUTOMATIC_AI_LIMIT
	}
	return { reserve, available }
}
