import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const replay = readFileSync(new URL('../scripts/replay-v105-jsonl.mjs', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../../frontend/supabase/schema_v105_formal.sql', import.meta.url), 'utf8')

test('v105 replay advances evaluation state from the candidate baseline instead of persisted predecessor state', () => {
  assert.match(replay, /state\.priorSameSideStreak\s*=\s*candidate\.baselineV104SameSideStreak/)
  assert.match(replay, /state\.priorDirection\s*=\s*candidate\.baselineV104PredictedResult/)
  const predecessorState = 'state.priorDirection = row.oldPrediction'
  const candidateState = 'state.priorDirection = candidate.baselineV104PredictedResult'
  assert.equal(replay.indexOf(predecessorState), replay.lastIndexOf(predecessorState))
  assert.ok(replay.indexOf(predecessorState) < replay.indexOf(candidateState))
})

test('v105 replay scores only immutable verified Final settlements', () => {
  assert.match(replay, /row\.settlementFinal\s*===\s*true/)
  assert.match(replay, /isVerifiedFinalRoundAction\(row\.settlementSourceAction\)/)
  assert.doesNotMatch(replay, /row\.evaluable/)
})

test('v105 DB active metadata uses the five-road formal runtime identity', () => {
  assert.match(schema, /'main_strategy',\s*'v105_五路通用週期正式版'/)
  assert.doesNotMatch(schema, /v105_主預測防鎖邊正式版/)
})
