import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStableReportFromRows, formatReportText } from '../src/stable-report.js'

const sideKeys = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']
const flags = (enabled = []) => Object.fromEntries(sideKeys.map((key) => [key, enabled.includes(key)]))

const rows = [
  {
    source: 'ofalive99', table_id: 'BAG01', shoe_no: '101', round_no: 18,
    strategy_version: 'v101',
    predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    prediction_features: {
      side_actions: flags(['superSix', 'bankerPair', 'playerPair']),
      side_hits: flags(['superSix', 'bankerPair']),
    },
  },
  {
    source: 'ofalive99', table_id: 'BAG01', shoe_no: '101', round_no: 19,
    strategy_version: 'v101',
    predicted_result: 'player', actual_result: 'tie', is_hit: false,
    prediction_features: { side_actions: flags(['tie']), side_hits: flags(['tie']) },
  },
  {
    source: 'ofalive99', table_id: 'BAG01', shoe_no: '102', round_no: 1,
    strategy_version: 'v101',
    predicted_result: 'banker', actual_result: 'banker', is_hit: true,
    prediction_features: { side_actions: flags(['bankerDragon']), side_hits: flags(['bankerDragon']) },
  },
]

test('stable report exactly aggregates immutable saved rows without recomputing predictions or actions', () => {
  assert.deepEqual(buildStableReportFromRows(rows), {
    version: '100-row-contract',
    invalidRows: [],
    tables: [{
      tableId: 'BAG01',
      rounds: 3,
      hits: 2,
      misses: 0,
      pushes: 1,
      mainEvaluated: 2,
      hitRate: 100,
      sideActions: 5,
      sideHits: 4,
      sideHitRate: 80,
      side: {
        tie: { actions: 1, hits: 1, hitRate: 100 },
        superSix: { actions: 1, hits: 1, hitRate: 100 },
        bankerPair: { actions: 1, hits: 1, hitRate: 100 },
        playerPair: { actions: 1, hits: 0, hitRate: 0 },
        bankerDragon: { actions: 1, hits: 1, hitRate: 100 },
        playerDragon: { actions: 0, hits: 0, hitRate: null },
      },
    }],
    total: {
      rounds: 3,
      hits: 2,
      misses: 0,
      pushes: 1,
      mainEvaluated: 2,
      hitRate: 100,
      sideActions: 5,
      sideHits: 4,
      sideHitRate: 80,
      side: {
        tie: { actions: 1, hits: 1, hitRate: 100 },
        superSix: { actions: 1, hits: 1, hitRate: 100 },
        bankerPair: { actions: 1, hits: 1, hitRate: 100 },
        playerPair: { actions: 1, hits: 0, hitRate: 0 },
        bankerDragon: { actions: 1, hits: 1, hitRate: 100 },
        playerDragon: { actions: 0, hits: 0, hitRate: null },
      },
    },
  })
})

test('stable report excludes rows missing immutable identity or complete saved side actions', () => {
  const invalid = structuredClone(rows[0])
  delete invalid.prediction_features.side_actions.playerDragon
  const missingIdentity = { ...structuredClone(rows[1]), shoe_no: null }

  const report = buildStableReportFromRows([invalid, missingIdentity])

  assert.equal(report.total.rounds, 0)
  assert.deepEqual(report.invalidRows, [
    { index: 0, reason: 'missing_or_invalid_side_actions' },
    { index: 1, reason: 'missing_identity' },
  ])
})

test('stable report excludes every saved row for a contradictory settlement key', () => {
  const contradiction = { ...structuredClone(rows[0]), predicted_result: 'player', is_hit: false }

  const report = buildStableReportFromRows([rows[0], contradiction])

  assert.equal(report.total.rounds, 0)
  assert.deepEqual(report.invalidRows, [
    { index: 0, reason: 'duplicate_or_conflicting_row' },
    { index: 1, reason: 'duplicate_or_conflicting_row' },
  ])
})

test('stable report never counts a legacy strategy row', () => {
  const legacy = { ...structuredClone(rows[0]), strategy_version: 'v096_legacy' }

  const report = buildStableReportFromRows([legacy])

  assert.equal(report.total.rounds, 0)
  assert.deepEqual(report.invalidRows, [{ index: 0, reason: 'unapproved_strategy' }])
})

test('saved-row report formats without requiring a live predictor session status', () => {
  const text = formatReportText(buildStableReportFromRows(rows))

  assert.match(text, /100/)
  assert.match(text, /BAG01/)
  assert.match(text, /100%/)
})
