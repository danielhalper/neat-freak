import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecommendationBudget, AUTOMATIC_AI_LIMIT } from '../src/recommendation-budget.js'

test('automatic AI attempts are bounded across concurrency, restart and UTC rollover', async () => {
	let state
	let clock = Date.UTC(2026, 10, 4, 12)
	const deps = { read: async () => state, write: async value => { state = value }, now: () => clock }
	const budget = createRecommendationBudget(deps)
	const granted = await Promise.all(Array.from({ length: 20 }, () => budget.reserve()))
	assert.equal(granted.filter(Boolean).length, AUTOMATIC_AI_LIMIT)
	assert.equal(await createRecommendationBudget(deps).reserve(), false)
	clock += 86_400_000
	assert.equal(await createRecommendationBudget(deps).reserve(), true)
	assert.equal(state.used, 1)
})

test('failed budget storage never grants an automatic AI request or poisons later attempts', async () => {
	let fail = true
	const budget = createRecommendationBudget({
		read: async () => undefined,
		write: async () => { if (fail) throw new Error('storage unavailable') },
	})
	await assert.rejects(budget.reserve(), /storage unavailable/)
	fail = false
	assert.equal(await budget.reserve(), true)
})

test('the automatic AI cap is 12 a day and can be checked without spending an attempt', async () => {
	let state
	const budget = createRecommendationBudget({ read: async () => state, write: async value => { state = value }, now: () => Date.UTC(2026, 10, 18, 12) })
	assert.equal(AUTOMATIC_AI_LIMIT, 12)
	assert.equal(await budget.available(), true)
	assert.equal(state, undefined, 'checking spends nothing')
	for (let i = 0; i < AUTOMATIC_AI_LIMIT; i++) await budget.reserve()
	assert.equal(await budget.available(), false)
})
