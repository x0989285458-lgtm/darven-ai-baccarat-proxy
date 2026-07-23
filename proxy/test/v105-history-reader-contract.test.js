import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const writer = readFileSync(new URL('../src/supabase-writer.js', import.meta.url), 'utf8')
const start = writer.indexOf('async getV105FormalHistory')
const end = writer.indexOf('async getRecentPredictionRows', start)
const block = writer.slice(start, end)

test('v105 hydration projects only scalar issuance fields instead of fetching 12MB of JSON payloads', () => {
  assert.match(block, /prediction_timing:prediction_features->>prediction_timing/)
  assert.match(block, /baseline_v104_predicted_result:issued_prediction_payload->>baselineV104PredictedResult/)
  assert.match(block, /baseline_v104_same_side_streak:issued_prediction_payload->>baselineV104SameSideStreak/)
  assert.match(block, /issued_same_side_streak:issued_prediction_payload->>sameSideStreak/)
  assert.doesNotMatch(block, /prediction_features,issued_prediction_payload/)
  assert.match(block, /Math\.min\(10000,\s*Math\.max\(1,/)
})
