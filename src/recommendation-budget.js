// Local, durable attempt counter. Reserving before the request also bounds
// failures and worker restarts. Explicit user requests do not use this budget.
export const AUTOMATIC_AI_LIMIT = 8

export function createRecommendationBudget({ read, write, now = Date.now }) {
	let queue = Promise.resolve()
	function reserve() {
		const pending = queue.then(async () => {
			const day = Math.floor(now() / 86_400_000)
			const previous = await read()
			const used = previous?.day === day ? previous.used || 0 : 0
			if (used >= AUTOMATIC_AI_LIMIT) return false
			await write({ day, used: used + 1 })
			return true
		})
		queue = pending.catch(() => {})
		return pending
	}
	return { reserve }
}
