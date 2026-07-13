import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDefaultEqualStrategy, buildFormalActiveStrategy, buildShortRunAdjustedStrategy } from '../src/supabase-writer.js'

test('v098 keeps every legacy initializer archived and only v097 formally active', () => {
  assert.deepEqual([
    [buildDefaultEqualStrategy().version, buildDefaultEqualStrategy().status],
    [buildShortRunAdjustedStrategy().version, buildShortRunAdjustedStrategy().status],
    [buildFormalActiveStrategy().version, buildFormalActiveStrategy().status],
  ], [
    ['v012_equal_weight_seed', 'archived'],
    ['v094_no_observe_confidence_30_70', 'archived'],
    ['v097_副預測命中校準與門檻降5版', 'active'],
  ])
})

test('v098 migration archives all non-v097 active rows and enforces one active strategy', () => {
  const sql = readFileSync(new URL('../../frontend/supabase/schema_v098_snapshot_safety.sql', import.meta.url), 'utf8')
  assert.match(sql, /update\s+public\.ai_strategy_versions[\s\S]*status\s*=\s*'archived'[\s\S]*status\s*=\s*'active'[\s\S]*version\s*<>\s*'v097_副預測命中校準與門檻降5版'/i)
  assert.match(sql, /create\s+unique\s+index[\s\S]*on\s+public\.ai_strategy_versions[\s\S]*where\s*\(status\s*=\s*'active'\)/i)
})
