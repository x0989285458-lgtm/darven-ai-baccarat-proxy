import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../../supabase/migrations/20260828110000_v105_capture_outbox_three_tier_adaptive_batch.sql', import.meta.url), 'utf8')
const harness = readFileSync(new URL('../../scripts/test-main61-three-tier-adaptive-batch-migration.mjs', import.meta.url), 'utf8')

test('current capture outbox migration keeps low ten, middle thirty, and high hundred claim tiers', () => {
  assert.match(migration, /p_limit integer default 30/)
  assert.match(migration, /offset 300 limit 1[\s\S]*then 100/)
  assert.match(migration, /offset 29 limit 1[\s\S]*then 30[\s\S]*else 10/)
  assert.match(migration, /limit least\(p_limit, \(select batch_policy\.effective_max/)
})

test('current migration harness freezes production state and verifies every adaptive tier', () => {
  assert.match(harness, /\.\.\/proxy\/node_modules\/pg\/lib\/index\.js/)
  assert.match(harness, /lock table public\.v105_capture_settlement_outbox in share row exclusive mode/)
  assert.match(harness, /low\.rows\.length!==10/)
  assert.match(harness, /mid\.rows\.length!==30/)
  assert.match(harness, /high\.rows\.length!==100/)
  assert.match(harness, /await db\.query\('rollback'\)/)
  assert.match(harness, /beforeHash!==afterHash/)
})

test('current migration harness explicitly types every repeated SQL parameter', () => {
  assert.match(harness, /\$\{b\+1\}::text/)
  assert.match(harness, /\$\{b\+2\}::bigint/)
  assert.match(harness, /\$\{b\+3\}::jsonb/)
  assert.match(harness, /bigint::text/)
  assert.match(harness, /bigint\*interval/)
})
