import test from 'node:test'
import assert from 'node:assert/strict'

const runTable = (runLengths, { start = 'banker', ties = false } = {}) => {
  const runs = runLengths.map((length, index) => ({
    side: index % 2 === 0 ? start : start === 'banker' ? 'player' : 'banker',
    length,
  }))
  const outcomes = runs.flatMap(({ side, length }) => Array(length).fill(side))
  const beadPlateRaw = outcomes.flatMap((side) => [side === 'banker' ? '02' : '01', ...(ties ? ['03'] : [])]).join('')
  const bigRoadRaw = runs.map(({ side, length }) => Array(length).fill(side === 'banker' ? 'B' : 'P').join(',')).join('#')
  return { tableId: 'BAG01', shoe: 105, round: outcomes.length, beadPlateRaw, bigRoadRaw }
}

test('V10 generic structure detects repeated 1,1,2 columns and switches after the completed player-two column', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const result = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 1, 2, 1, 1, 2]))
  assert.equal(result.eligible, true)
  assert.deepEqual(result.motifRunLengths, [1, 1, 2])
  assert.equal(result.currentSide, 'player')
  assert.equal(result.currentRunLength, 2)
  assert.equal(result.targetRunLength, 2)
  assert.equal(result.currentPhase, 'target_reached_switch')
  assert.equal(result.direction, 'banker')
})

test('V10 generic structure detects repeated 1,2,2 columns and switches after the completed player-two column', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const result = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 2, 2, 1, 2, 2]))
  assert.equal(result.eligible, true)
  assert.deepEqual(result.motifRunLengths, [1, 2, 2])
  assert.equal(result.direction, 'banker')
  assert.equal(result.currentPhase, 'target_reached_switch')
})

test('V10 structure continues the current side while the current column is below its inferred motif target', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const result = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 1, 2, 1, 1, 2, 1, 1, 1]))
  assert.equal(result.eligible, true)
  assert.deepEqual(result.motifRunLengths, [1, 1, 2])
  assert.equal(result.currentSide, 'banker')
  assert.equal(result.currentRunLength, 1)
  assert.equal(result.targetRunLength, 2)
  assert.equal(result.currentPhase, 'continuing_current_run')
  assert.equal(result.direction, 'banker')
})

test('V10 structure is generic for an arbitrary repeated 1,3,2 motif', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const result = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 3, 2, 1, 3, 2]))
  assert.equal(result.eligible, true)
  assert.deepEqual(result.motifRunLengths, [1, 3, 2])
  assert.equal(result.repeats, 2)
  assert.equal(result.direction, 'banker')
})

test('V10 structure fails closed for insufficient data, no complete repeat, and an overrun current column', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const insufficient = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 2]))
  const incomplete = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 1, 2, 1, 1]))
  const overrun = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 1, 2, 1, 1, 2, 1, 1, 3]))
  for (const result of [insufficient, incomplete, overrun]) {
    assert.equal(result.eligible, false)
    assert.equal(result.direction, null)
  }
  assert.equal(insufficient.reason, 'insufficient_run_history')
  assert.equal(incomplete.reason, 'no_complete_repeated_motif')
  assert.equal(overrun.reason, 'current_run_exceeds_motif_target')
})

test('V10 structure rejects inconsistent bead and big-road inputs', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const inconsistent = runTable([1, 1, 2, 1, 1, 2])
  inconsistent.bigRoadRaw += '#B'
  const result = analyzeV105ShadowV10UncommonRoadStructure(inconsistent)
  assert.equal(result.eligible, false)
  assert.equal(result.direction, null)
  assert.equal(result.reason, 'big_road_bead_mismatch')
})

test('V10 structure ignores ties when restoring column runs', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const withTies = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 1, 2, 1, 1, 2], { ties: true }))
  const withoutTies = analyzeV105ShadowV10UncommonRoadStructure(runTable([1, 1, 2, 1, 1, 2]))
  assert.deepEqual(withTies, withoutTies)
  assert.equal(withTies.eligible, true)
})

test('V10 structure does not treat fallback roads as authoritative', async () => {
  const { analyzeV105ShadowV10UncommonRoadStructure } = await import('../src/v105-shadow-v10-structure.js')
  const table = { ...runTable([1, 1, 2, 1, 1, 2]), roadSource: 'real_round_fallback', roadFallbackFields: ['bigRoadRaw'] }
  const result = analyzeV105ShadowV10UncommonRoadStructure(table)
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'authoritative_big_road_required')
})
