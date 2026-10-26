import test from 'node:test'
import assert from 'node:assert/strict'
import fixture from './fixtures/published-road-coherence.json' with { type: 'json' }
import { projectMtFinalTrend } from '../src/mt-final-trend.js'

function fromPublic(t) {
  const trend = { current_shoe: String(t.shoe), current_round: String(t.round),
    total_round: String(t.playerCount + t.bankerCount + t.tieCount),
    total_round_player: String(t.playerCount), total_round_banker: String(t.bankerCount), total_round_tie: String(t.tieCount),
    total_round_player_pair: String(t.playerPairCount), total_round_banker_pair: String(t.bankerPairCount),
    bead_plate2: t.beadPlateRaw, big2: t.bigRoadRaw, big_eye2: t.bigEyeRaw, small2: t.smallRoadRaw, cockroach2: t.cockroachRaw,
    next_banker2: t.nextBankerRaw, next_player2: t.nextPlayerRaw }
  // This is the trend's actual coverage, not the possibly newer API screen.
  return { table_id: t.tableId, shoe: t.shoe, round: Number(trend.total_round), trend }
}
function finalFor(table, winner = 'banker') {
  return { tableId: table.table_id, shoe: table.shoe, round: table.round + 1, winner,
    // Synthetic valid cards for testing the provider's hypothetical 7-point asks.
    rawResult: winner === 'banker' ? [1,2,3,5,0,0,0,0,4,7] : [2,1,5,3,0,0,0,0,7,4] }
}
const grid = raw => Object.fromEntries(raw.split('#').flatMap((col,c) => col.split(',').flatMap((v,r) => v ? [[`${c}:${r}`,v]] : [])))
for (const sample of fixture.tables) {
  for (const winner of ['banker','player']) test(`${sample.tableId} recorded ask oracle: ${winner} projection preserves historical points and all five roads`, () => {
    const table = fromPublic(sample), before = structuredClone(table), final = finalFor(table,winner)
    const got = projectMtFinalTrend(table,final)
    assert.ok(got)
    const ask = sample[winner === 'banker' ? 'nextBankerRaw' : 'nextPlayerRaw']
    assert.equal(got.bead_plate2,ask.bead_plate)
    for (const [key,expected] of [['big2','big'],['big_eye2','big_eye'],['small2','small'],['cockroach2','cockroach']]) assert.deepEqual(grid(got[key]),grid(ask[expected]),key)
    assert.equal(Number(got.total_round),table.round + 1)
    assert.equal(Number(got.total_round_banker)+Number(got.total_round_player)+Number(got.total_round_tie),table.round + 1)
    assert.deepEqual(table,before)
  })
}

test('a different raw table cannot supply the Final baseline', () => {
  const table=fromPublic(fixture.tables[0]), final=finalFor(table)
  final.tableId='BAV02'
  assert.equal(projectMtFinalTrend(table,final),null)
})

test('gap, duplicate, different shoe and inconsistent cards never fabricate a trend', () => {
  const table=fromPublic(fixture.tables[0]), final=finalFor(table)
  for (const change of [{round:final.round+1},{round:final.round-1},{shoe:final.shoe+1},{winner:'tie'}]) assert.equal(projectMtFinalTrend(table,{...final,...change}),null)
})

test('corrupt counts, malformed beads, missing historical points and inconsistent derived roads fail closed', () => {
  const table=fromPublic(fixture.tables[0]), final=finalFor(table)
  for (const change of [{total_round:'0'},{total_round_banker:'999'},{bead_plate2:'010'},{big2:''},{big_eye2:'1'}]) {
    assert.equal(projectMtFinalTrend({...table,trend:{...table.trend,...change}},final),null)
  }
})

test('pair-bearing tie advances tie and pair counts while preserving previous winning point', () => {
  const table=fromPublic(fixture.tables[0]), final=finalFor(table)
  const before=grid(table.trend.big2)
  // Both sides pair with equal provided final points; no provisional action.
  final.winner='tie';final.rawResult=[1,1,14,14,0,0,0,0,2,2]
  const got=projectMtFinalTrend(table,final)
  assert.ok(got)
  assert.equal(Number(got.total_round_tie),Number(table.trend.total_round_tie)+1)
  assert.equal(Number(got.total_round_player_pair),Number(table.trend.total_round_player_pair)+1)
  assert.equal(Number(got.total_round_banker_pair),Number(table.trend.total_round_banker_pair)+1)
  const after=grid(got.big2)
  assert.deepEqual(Object.keys(after),Object.keys(before))
  const changed=Object.keys(before).filter(key=>before[key]!==after[key])
  assert.equal(changed.length,1)
  assert.equal(after[changed[0]][1],before[changed[0]][1])
  assert.equal(after[changed[0]][2],'3')
  for (const field of ['big_eye2','small2','cockroach2']) assert.deepEqual(grid(got[field]),grid(table.trend[field]))
})
