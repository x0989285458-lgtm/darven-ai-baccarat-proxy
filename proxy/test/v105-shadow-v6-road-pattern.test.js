import test from 'node:test'
import assert from 'node:assert/strict'
const contract = await import('../src/v105-shadow-contract.js')
const { analyzeV105ShadowV6RoadPattern, decodeV105ShadowV6BigRoad } = contract

const PLAYER = '0001'
const BANKER = '0002'

function column(side, length, { tieOverlayAt = -1 } = {}) {
  const base = side === 'player' ? PLAYER : BANKER
  return Array.from({ length }, (_, index) => index === tieOverlayAt
    ? `03${base.slice(-2)}`
    : base).join(',')
}

function bigRoad(runs) {
  return runs.map(({ side, length, tieOverlayAt }) => column(side, length, { tieOverlayAt })).join('#')
}

const fixtures = [
  { name: '閒2莊2閒2', runs: [['player', 2], ['banker', 2], ['player', 2]], direction: 'banker' },
  { name: '閒2莊1閒2', runs: [['player', 2], ['banker', 1], ['player', 2]], direction: 'banker' },
  { name: '閒3莊3閒1', runs: [['player', 3], ['banker', 3], ['player', 1]], direction: 'player' },
  { name: '閒1莊3閒1莊3', runs: [['player', 1], ['banker', 3], ['player', 1], ['banker', 3]], direction: 'player' },
]

test('V6 road-pattern contract exposes an authoritative Big Road decoder and analyzer', () => {
  assert.equal(typeof decodeV105ShadowV6BigRoad, 'function')
  assert.equal(typeof analyzeV105ShadowV6RoadPattern, 'function')
})

for (const fixture of fixtures) {
  test(`V6 road pattern keeps chronological run order for ${fixture.name}`, () => {
    const raw = bigRoad(fixture.runs.map(([side, length]) => ({ side, length })))
    const analysis = analyzeV105ShadowV6RoadPattern({ bigRoadRaw: raw })

    assert.equal(analysis.roadPatternSignal.clear, true)
    assert.equal(analysis.roadPatternSignal.direction, fixture.direction)
    assert.deepEqual(analysis.decodedRecentRuns.map(({ side, length }) => [side, length]), fixture.runs)
    assert.deepEqual(analysis.windows.near6, decodeV105ShadowV6BigRoad(raw).slice(-6))
    assert.deepEqual(analysis.windows.near12, decodeV105ShadowV6BigRoad(raw).slice(-12))
    assert.deepEqual(analysis.windows.background24, decodeV105ShadowV6BigRoad(raw).slice(-24))
  })
}

test('V6 Big Road tie overlay remains one outcome and never adds a bead', () => {
  const raw = bigRoad([
    { side: 'player', length: 2, tieOverlayAt: 1 },
    { side: 'banker', length: 1 },
    { side: 'player', length: 2 },
  ])

  assert.deepEqual(decodeV105ShadowV6BigRoad(raw), ['player', 'player', 'banker', 'player', 'player'])
  assert.equal(analyzeV105ShadowV6RoadPattern({ bigRoadRaw: raw }).roadPatternSignal.direction, 'banker')
})

test('V6 Big Road decoder fails if implementation reverses chronology or reads only row zero', () => {
  const raw = bigRoad([
    { side: 'player', length: 2 },
    { side: 'banker', length: 3 },
    { side: 'player', length: 1 },
  ])

  const chronological = decodeV105ShadowV6BigRoad(raw)
  assert.deepEqual(chronological, ['player', 'player', 'banker', 'banker', 'banker', 'player'])
  assert.notDeepEqual(chronological, ['player', 'banker', 'banker', 'banker', 'player', 'player'])
  assert.notDeepEqual(chronological, ['player', 'banker', 'player'])
})

test('V6 road pattern rejects reconstructed fallback roads and does not invent a pattern', () => {
  const analysis = analyzeV105ShadowV6RoadPattern({
    bigRoadRaw: bigRoad([
      { side: 'player', length: 2 },
      { side: 'banker', length: 2 },
      { side: 'player', length: 2 },
    ]),
    roadSource: 'real_round_fallback',
    roadFallbackFields: ['bigRoadRaw'],
  })

  assert.equal(analysis.roadPatternSignal.clear, false)
  assert.equal(analysis.roadPatternSignal.direction, null)
  assert.equal(analysis.roadPatternSignal.reason, 'authoritative_big_road_required')
})
