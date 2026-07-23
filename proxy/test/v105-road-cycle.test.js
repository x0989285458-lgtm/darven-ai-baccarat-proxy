import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeFiveRoadCycles,
  decodeBeadOutcomeSequence,
  decodeBigRoadOutcomeSequence,
  decodeRoadColorSequence,
  detectRepeatedCycle,
} from '../src/v105-road-cycle.js'
import { buildV104ShadowPrediction } from '../src/v104-shadow-strategy.js'

test('decodes one outcome per bead cell without counting pair flags as extra outcomes', () => {
  assert.deepEqual(decodeBeadOutcomeSequence('02011102#2201'), ['banker', 'player', 'player', 'banker', 'banker', 'player'])
})

test('rejects malformed bead cells instead of repairing them into fake outcomes', () => {
  assert.deepEqual(decodeBeadOutcomeSequence('0x2'), [])
  assert.deepEqual(decodeBeadOutcomeSequence('020'), [])
})

test('decodes the authoritative big-road columns as the primary outcome sequence', () => {
  assert.deepEqual(decodeBigRoadOutcomeSequence('0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,'),
    ['banker', 'player', 'player', 'player', 'banker', 'player', 'player', 'player'])
})

test('rejects unsafe cycle parameters without looping or accepting one occurrence', () => {
  const sequence = ['banker', 'player', 'banker', 'player']
  for (const minimumRepeats of [0, 1, -1, 1.5]) {
    assert.equal(detectRepeatedCycle(sequence, { minimumRepeats }).detected, false)
  }
  assert.equal(detectRepeatedCycle(sequence, { maximumWindow: Number.MAX_SAFE_INTEGER }).detected, false)
})

test('detects every repeated outcome motif generically and predicts the next cycle position', () => {
  const cycle = detectRepeatedCycle(['banker', 'player', 'player', 'player', 'banker', 'player', 'player', 'player'])
  assert.deepEqual(cycle, {
    detected: true,
    motif: ['banker', 'player', 'player', 'player'],
    motifRunLengths: [1, 3],
    repeats: 2,
    next: 'banker',
  })
})

test('does not mislabel a single unfinished pattern as a cycle', () => {
  assert.equal(detectRepeatedCycle(['banker', 'player', 'player', 'player']).detected, false)
})

test('does not mislabel a same-side dragon as a repeated cycle', () => {
  assert.equal(detectRepeatedCycle(Array(12).fill('banker')).detected, false)
})

test('decodes derived-road columns in chronological column order', () => {
  assert.deepEqual(decodeRoadColorSequence('1,2,,,,,,#2,1,1,,,,,'), ['1', '2', '2', '1', '1'])
})

test('reconstructs the primary big-road chronology from bead time order only when authoritative big-road counts agree', () => {
  const valid = analyzeFiveRoadCycles({
    beadPlateRaw: '0201010102010101',
    bigRoadRaw: '0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,',
  })
  const mismatch = analyzeFiveRoadCycles({
    beadPlateRaw: '0102020201020202',
    bigRoadRaw: '0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,',
  })
  const layoutMismatch = analyzeFiveRoadCycles({
    beadPlateRaw: '0201010102010101',
    bigRoadRaw: '0002,0002,,,,#0001,0001,0001,0001,0001,0001',
  })
  assert.equal(valid.main.detected, true)
  assert.equal(valid.main.priorityEligible, false)
  assert.equal(valid.main.direction, 'banker')
  assert.equal(valid.main.source, 'chronological_bead_reconstructed_big_road')
  assert.equal(valid.main.invalidReason, 'auxiliary_confirmation_missing')
  assert.equal(mismatch.main.detected, false)
  assert.equal(mismatch.main.invalidReason, 'big_road_bead_mismatch')
  assert.equal(layoutMismatch.main.detected, false)
  assert.equal(layoutMismatch.main.invalidReason, 'big_road_bead_layout_mismatch')
})

test('requires three repeats before a short period can control the main road score', () => {
  const weak = analyzeFiveRoadCycles({ beadPlateRaw: '02010201', bigRoadRaw: 'B#P#B#P' })
  const strong = analyzeFiveRoadCycles({
    beadPlateRaw: '020102010201', bigRoadRaw: 'B#P#B#P#B#P',
    bigEyeRaw: '1#2#1#2#1#2',
    nextBankerRaw: { big_eye: '1#2#1#2#1#2#1' },
    nextPlayerRaw: { big_eye: '1#2#1#2#1#2#2' },
  })
  assert.equal(weak.main.detected, true)
  assert.equal(weak.main.priorityEligible, false)
  assert.deepEqual(weak.roadmapScore, { banker: 0.5, player: 0.5 })
  assert.equal(strong.main.priorityEligible, true)
})

test('does not let a two-repeat short auxiliary cycle approve the main-road gate', () => {
  const analysis = analyzeFiveRoadCycles({
    beadPlateRaw: '0201010102010101',
    bigRoadRaw: '0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,',
    bigEyeRaw: '1#2#1#2',
    nextBankerRaw: { big_eye: '1#2#1#2#1' },
    nextPlayerRaw: { big_eye: '1#2#1#2#2' },
  })
  assert.equal(analysis.auxiliary.bigEye.cycle.detected, true)
  assert.equal(analysis.auxiliary.bigEye.priorityEligible, false)
  assert.equal(analysis.main.priorityEligible, false)
})

test('makes the completed big-road cycle primary and uses the other four roads only as validation', () => {
  const analysis = analyzeFiveRoadCycles({
    beadPlateRaw: '0201010102010101',
    bigRoadRaw: '0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,',
    bigEyeRaw: '1#2#1#2#1#2',
    smallRoadRaw: '2#1#2#1#2#1',
    cockroachRaw: '1,1,#2,2,',
    nextBankerRaw: { big_eye: '1#2#1#2#1#2#1', small: '2#1#2#1#2#1#2', cockroach: '1,1,#2,2,1' },
    nextPlayerRaw: { big_eye: '1#2#1#2#1#2#2', small: '2#1#2#1#2#1#1', cockroach: '1,1,#2,2,2' },
  })
  assert.equal(analysis.main.direction, 'banker')
  assert.equal(analysis.main.reasonText, '大路週期1－3連續2次，2路輔助確認，下一位置支持莊')
  assert.equal(analysis.auxiliary.beadPlate.countedAsIndependentSupport, false)
  assert.equal(analysis.auxiliary.bigEye.validationOnly, true)
  assert.equal(analysis.auxiliary.smallRoad.validationOnly, true)
  assert.equal(analysis.auxiliary.cockroach.validationOnly, true)
  assert.equal(analysis.roadmapScore.banker > analysis.roadmapScore.player, true)
})

test('leaves v104 rollback diagnostics bit-for-bit free of v105 cycle fields by default', () => {
  const legacy = buildV104ShadowPrediction({
    tableId: 'BAG01', shoe: 'S1', round: 8,
    beadPlateRaw: '0201010102010101',
    bigRoadRaw: '0002,,,,,#0001,0001,0001,,,#0002,,,,,#0001,0001,0001,,,',
    bankerCount: 2, playerCount: 6,
  })
  assert.equal(Object.hasOwn(legacy.diagnostics, 'roadCycles'), false)
})

test('fails closed when big road is missing even if the bead plate repeats', () => {
  const analysis = analyzeFiveRoadCycles({ beadPlateRaw: '0201010102010101' })
  assert.equal(analysis.main.detected, false)
  assert.deepEqual(analysis.roadmapScore, { banker: 0.5, player: 0.5 })
})
