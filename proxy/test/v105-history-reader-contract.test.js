import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const writer = readFileSync(new URL('../src/supabase-writer.js', import.meta.url), 'utf8')
const start = writer.indexOf('async getV105FormalHistory')
const end = writer.indexOf('async getRecentPredictionRows', start)
const block = writer.slice(start, end)

test('v105 hydration bounds JSON extraction per formal table and keeps restart-state projection small', () => {
  assert.match(block, /PRODUCTION_TABLE_IDS\.map/)
  assert.match(block, /table_id:\s*`eq\.\$\{tableId\}`/)
  assert.match(block, /settlement_final:\s*'eq\.true'/)
  assert.match(block, /PRODUCTION_TABLE_IDS\.slice\(index, index \+ 5\)/)
  assert.match(block, /Promise\.all\(batch\.map\(fetcher\)\)/)
  assert.match(block, /limit:\s*'70'/)
  assert.match(block, /limit:\s*'1'/)
  assert.match(block, /validSettledRows\.length < 60/)
  assert.match(block, /requires latest issuance state/)
  assert.match(block, /prediction_timing:prediction_features->>prediction_timing/)
  assert.match(block, /baseline_v104_predicted_result:issued_prediction_payload->>baselineV104PredictedResult/)
  assert.match(block, /baseline_v104_same_side_streak:issued_prediction_payload->>baselineV104SameSideStreak/)
  assert.match(block, /issued_same_side_streak:issued_prediction_payload->>sameSideStreak/)
  assert.doesNotMatch(block, /prediction_features,issued_prediction_payload/)
})
