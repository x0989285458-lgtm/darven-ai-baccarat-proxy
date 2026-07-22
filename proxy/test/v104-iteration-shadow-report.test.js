import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCycleReports, buildShadowProgress, buildWeightSuggestions } from '../src/v104-iteration-shadow-report.js'
import { renderShadowReportSvg } from '../src/v104-iteration-shadow-svg.js'
import { SHADOW_HEAD_KEYS, V104_ITERATION_SHADOW_SIDE_WEIGHTS, frozenWeightKeys } from '../src/v104-iteration-shadow-contract.js'

function row(index) {
  const hit = index % 2 === 0
  const heads = Object.fromEntries(SHADOW_HEAD_KEYS.map((key) => [key, {
    key, action: key === 'main' || index % 4 === 0,
    status: key === 'main' ? (index % 20 === 0 ? 'push' : hit ? 'hit' : 'miss') : (index % 4 === 0 ? (hit ? 'hit' : 'miss') : 'no_action'),
    isHit: key === 'main' && index % 20 === 0 ? null : (key === 'main' || index % 4 === 0 ? hit : null),
    fixedStakeUnits: key === 'main' || index % 4 === 0 ? 1 : 0,
    weightedStakeUnits: key === 'main' ? 3 : index % 4 === 0 ? 2 : 0,
    fixedNetUnits: key === 'main' && index % 20 === 0 ? 0 : hit ? 1 : -(key === 'main' || index % 4 === 0 ? 1 : 0),
    weightedNetUnits: key === 'main' && index % 20 === 0 ? 0 : hit ? 3 : -(key === 'main' ? 3 : index % 4 === 0 ? 2 : 0),
  }]))
  const predictionHeads = Object.fromEntries(SHADOW_HEAD_KEYS.map((key) => [key, {
    action: key === 'main' || index % 4 === 0,
    confidence: 50 + (index % 20),
    weights: Object.fromEntries((key === 'main' ? frozenWeightKeys.main : frozenWeightKeys[key]).map((name, i) => [name, i === 0 ? 0.5 : 0.5 / Math.max(1, (key === 'main' ? frozenWeightKeys.main : frozenWeightKeys[key]).length - 1)])),
    featureValues: Object.fromEntries((key === 'main' ? frozenWeightKeys.main : frozenWeightKeys[key]).map((name, i) => [name, hit ? 70 - i : 30 + i])),
  }]))
  return {
    prediction_id: `p-${index}`, table_id: `BAG0${(index % 9) + 1}`, shoe_no: '1', round_no: index + 1,
    prediction_payload: { heads: predictionHeads }, head_results: heads,
    settlement_final: true, resolved_at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  }
}

test('every exact 1000 Final rows produces one non-overlapping report with seven metrics', () => {
  const rows = Array.from({ length: 2005 }, (_, i) => row(i))
  const reports = buildCycleReports(rows)
  assert.equal(reports.length, 2)
  assert.equal(reports[0].cycleNumber, 1)
  assert.equal(reports[1].cycleNumber, 2)
  assert.equal(reports[0].settledRounds, 1000)
  assert.equal(reports[0].heads.length, 7)
  const main = reports[0].heads.find((item) => item.key === 'main')
  assert.equal(main.actions, 1000)
  assert.equal(main.pushes, 50)
  assert.equal(main.actionRate, 100)
  assert.equal(Number.isFinite(main.fixedNetUnits), true)
  assert.equal(Number.isFinite(main.weightedNetUnits), true)
  assert.equal(buildShadowProgress(rows).currentCycleProgress, 5)
})

test('permanent DB sequences keep absolute cycle numbers after the history window is truncated', () => {
  const rows = Array.from({ length: 1500 }, (_, i) => {
    const item = row(i + 1000)
    const sequence = i + 1001
    return {
      ...item,
      settlement_sequence: sequence,
      main_action_sequence: sequence,
      tie_action_sequence: Math.floor(sequence / 4),
      super_six_action_sequence: Math.floor(sequence / 4),
      banker_dragon_action_sequence: Math.floor(sequence / 4),
      player_dragon_action_sequence: Math.floor(sequence / 4),
      banker_pair_action_sequence: Math.floor(sequence / 4),
      player_pair_action_sequence: Math.floor(sequence / 4),
    }
  })
  const reports = buildCycleReports(rows)
  assert.deepEqual(reports.map((item) => item.cycleNumber), [2])
  assert.equal(buildShadowProgress(rows).settledRounds, 2500)
  assert.equal(buildShadowProgress(rows).currentCycleProgress, 500)
  assert.equal(buildShadowProgress(rows).heads.find((item) => item.key === 'main').iterationProgress, 500)
})

test('weight suggestions trigger per head at 1000 actions and preserve exact frozen keys with zero key drift', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(i))
  const suggestions = buildWeightSuggestions(rows)
  assert.deepEqual(suggestions.map((item) => item.headKey), ['main'])
  const suggestion = suggestions[0]
  assert.deepEqual(Object.keys(suggestion.currentWeights), frozenWeightKeys.main)
  assert.deepEqual(Object.keys(suggestion.suggestedWeights), frozenWeightKeys.main)
  assert.equal(Object.values(suggestion.suggestedWeights).reduce((sum, value) => sum + value, 0), 1)
  assert.equal(Object.values(suggestion.suggestedWeights).every((value) => value >= 0.05 && Math.round(value * 100) % 5 === 0), true)
  assert.equal('threshold' in suggestion, false)
  assert.equal(suggestion.status, 'pending')
})

test('side suggestions preserve the complete declared keyset and keep original zero weights at zero', () => {
  const rows = Array.from({ length: 4000 }, (_, index) => {
    const item = row(index)
    item.settlement_sequence = index + 1
    item.player_pair_action_sequence = Math.floor(index / 4) + 1
    item.prediction_payload.heads.playerPair.weights = structuredClone(V104_ITERATION_SHADOW_SIDE_WEIGHTS.playerPair)
    return item
  })
  const suggestion = buildWeightSuggestions(rows).find((item) => item.headKey === 'playerPair')
  assert.ok(suggestion)
  const declaredKeys = Object.keys(V104_ITERATION_SHADOW_SIDE_WEIGHTS.playerPair)
  assert.deepEqual(Object.keys(suggestion.currentWeights), declaredKeys)
  assert.deepEqual(Object.keys(suggestion.suggestedWeights), declaredKeys)
  for (const [key, value] of Object.entries(V104_ITERATION_SHADOW_SIDE_WEIGHTS.playerPair)) {
    if (value === 0) {
      assert.equal(suggestion.currentWeights[key], 0)
      assert.equal(suggestion.suggestedWeights[key], 0)
    }
  }
})

test('a completed 1000-action suggestion stays frozen until the next full non-overlapping action block', () => {
  const rows = Array.from({ length: 1001 }, (_, index) => ({
    ...row(index),
    settlement_sequence: index + 1,
    main_action_sequence: index + 1,
  }))
  const first = buildWeightSuggestions(rows.slice(0, 1000)).find((item) => item.headKey === 'main')
  rows[1000].prediction_payload.heads.main.featureValues = Object.fromEntries(frozenWeightKeys.main.map((key) => [key, 100]))
  const afterExtraAction = buildWeightSuggestions(rows).find((item) => item.headKey === 'main')
  assert.deepEqual(afterExtraAction, first)
})

test('Traditional Chinese SVG renders the whole report, signed units, and escapes dynamic text', () => {
  const report = buildCycleReports(Array.from({ length: 1000 }, (_, i) => row(i)))[0]
  const svg = renderShadowReportSvg({ ...report, shadowVersion: '<script>alert(1)</script>' }, buildWeightSuggestions(Array.from({ length: 1000 }, (_, i) => row(i))))
  assert.match(svg, /^<svg/)
  assert.match(svg, /影子預測第1輪/)
  assert.match(svg, /出手率/)
  assert.match(svg, /命中率/)
  assert.match(svg, /固定1單位/)
  assert.match(svg, /信心加權/)
  assert.match(svg, /莊／閒/)
  assert.doesNotMatch(svg, /<script>/)
  assert.match(svg, /&lt;script&gt;/)
  assert.doesNotMatch(svg, /[🟢🔴⚪]/u)
})
