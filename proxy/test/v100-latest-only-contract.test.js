import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const writer = readFileSync(new URL('../src/supabase-writer.js', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../frontend/supabase/schema_v100_latest_only.sql', import.meta.url), 'utf8')

const currentRpcs = [
  'persist_v100_settled_round',
  'issue_v100_prediction',
  'settle_v100_prediction',
  'reconcile_v100_prediction_lifecycle',
  'get_v100_prediction_lifecycle_stats',
]

const retiredRpcPattern = /persist_v098_settled_round|issue_v09821_prediction|settle_v09821_prediction|reconcile_v09823_prediction_lifecycle|get_v09823_prediction_lifecycle_stats/

test('v100 runtime calls only current prediction RPC names', () => {
  for (const name of currentRpcs) assert.match(writer, new RegExp(`rpc/${name}`))
  assert.doesNotMatch(writer, retiredRpcPattern)
})

test('v100 additive schema defines every current RPC without dropping predecessors before cutover', () => {
  for (const name of currentRpcs) {
    assert.match(migration, new RegExp(`create or replace function public\\.${name}\\b`, 'i'))
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\b`, 'i'))
  }
  assert.doesNotMatch(migration, /drop function/i)
})
