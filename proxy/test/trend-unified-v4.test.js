import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { parseCloudCapturePayload } from '../src/cloud-capture.js'
import { createV105FormalRuntime } from '../src/v105-formal-runtime.js'
const text = readFileSync(new URL('../../frontend/src/test-fixtures/sourcePipeline.ts', import.meta.url), 'utf8')
const fixtures = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('} as const') + 1))
const table = (kind, id = 'BAV03A') => {
  const t = structuredClone(fixtures[kind]); delete t.prediction
  return { ...t, tableId: id, round: 4, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString(), trendBundle: { ...t.trendBundle, tableId: id } }
}
async function merge(current, candidate) {
  const writer = { configured: true, getLatestCloudTableSnapshot: async () => ({ tables: [candidate], snapshot_at: new Date().toISOString() }), claimCaptureOutbox: async () => [], getCaptureOutboxHealth: async () => ({ pending: 0, processing: 0, error: 0, dead_letter: 0 }) }
  const app = createApp({ autoConnect: false, production: false, memberAuthRequired: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: true, supabaseClient: writer })
  try {
    app.state.setTables(parseCloudCapturePayload({ tables: [current] }).tables)
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    return app.state.snapshot().tables[0]
  } finally { await app.stop() }
}
test('v4 complete same identity is not downgraded by pending replay', async () => {
  const actual = await merge(table('recovery'), table('gap'))
  assert.equal(actual.trendBundle.status, 'available')
  assert.equal(actual.beadPlateRaw, '01020202')
})
test('v4 complete update replaces pending', async () => {
  assert.equal((await merge(table('gap'), table('recovery'))).trendBundle.status, 'available')
})
test('v4 different shoe cannot reuse old complete bundle', async () => {
  const next = table('gap'); next.shoe = 1649; next.trendBundle.shoe = '1649'
  const actual = await merge(table('recovery'), next)
  assert.equal(String(actual.shoe), '1649'); assert.equal(actual.trendBundle.status, 'pending')
})
test('v4 next round pending cannot borrow previous completed roads', async () => {
  const next = table('gap'); next.round = 5
  const actual = await merge(table('recovery'), next)
  assert.equal(actual.round, 5); assert.equal(actual.trendBundle.status, 'pending')
})
test('v4 complete provider correction remains accepted', async () => {
  const corrected = table('recovery'); corrected.beadPlateRaw = '02020202'
  assert.equal((await merge(table('recovery'), corrected)).beadPlateRaw, '02020202')
})

test('v4 production six tables pending does not block claim or other complete tables', async () => {
  const ids = ['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
  const tables = ids.map(id => table(id === 'BAV03A' ? 'gap' : 'recovery', id))
  const issued = []; let claims = 0; let completed = 0; let failed = 0
  const writer = { configured: true, getRuntimeStatus: () => ({ ready: true, degraded: false }), getV105FormalHistory: async () => [], readIssuedPrediction: async () => null,
    issuePrediction: async p => { issued.push(p); return { ...p, predictionId: `offline-${p.targetTableId}-${p.targetRound}`, issuedAt: new Date().toISOString() } },
    reconcilePredictionLifecycle: async () => ({ ok: true }),
    getLatestCloudTableSnapshot: async () => ({ tables, snapshot_at: new Date().toISOString() }),
    claimCaptureOutbox: async () => {
      claims++
      return claims === 1 ? [{ session_id: 'offline-complete-table', sequence: 1, claim_token: 'exact-lease-1', attempts: 1,
        payload: { work: { tables: [tables[0]], rounds: [{ tableId: 'BAV01', shoe: 1648, round: 4, winner: 'banker', sourceAction: 'summary', rawResult: [1,2,3,4,0,0,-1,-1,4,6] }] } } }] : []
    },
    completeCaptureOutbox: async () => { completed++ }, failCaptureOutbox: async () => { failed++ },
    getCaptureOutboxHealth: async () => ({ pending: 0, processing: 0, error: 0, dead_letter: 0 }) }
  const runtime = createV105FormalRuntime({ writer }); await runtime.start()
  const app = createApp({ autoConnect: false, production: true, memberAuthRequired: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: true, supabaseClient: writer, v104FormalRuntime: runtime })
  try {
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    assert.equal(issued.filter(p => p.targetTableId === 'BAV03A').length, 0)
    assert.deepEqual(issued.map(p => p.targetTableId).sort(), ids.filter(id => id !== 'BAV03A').sort())
    assert.ok(claims > 0, 'one pending table cannot stop all claiming at beforeClaim')
    assert.equal(completed, 1, 'complete table Final reaches unchanged strict completion')
    assert.equal(failed, 0)
  } finally { await app.stop() }
})

test('v4 production Consumer exact immutable Final retry recovers once and replay does not reissue', async () => {
  let issued = [], completed = 0, failed = 0, offered = false, attempts = 0
  const gap = table('gap')
  let latest = gap
  const otherTables = ['BAV01','BAV02','BAV03','BAV05','BAV06'].map(id => table('recovery', id))
  const work = { tables: [gap], rounds: [{ tableId: 'BAV03A', shoe: 1648, round: 4, winner: 'banker', sourceAction: 'summary', rawResult: [1,2,3,4,0,0,-1,-1,4,6] }] }
  const writer = { configured: true, getRuntimeStatus: () => ({ ready: true, degraded: false }), getV105FormalHistory: async () => [], readIssuedPrediction: async () => null,
    issuePrediction: async p => { issued.push(structuredClone(p)); return { ...p, predictionId: `offline-${p.targetRound}`, issuedAt: new Date().toISOString() } },
    reconcilePredictionLifecycle: async () => ({ ok: true }),
    getLatestCloudTableSnapshot: async () => ({ tables: [latest, ...otherTables], snapshot_at: new Date().toISOString() }),
    claimCaptureOutbox: async () => { if (offered) return []; offered = true; attempts++; return [{ session_id: 'offline', sequence: 1, claim_token: `exact-lease-${attempts}`, attempts, payload: { work } }] },
    completeCaptureOutbox: async () => { completed++ }, failCaptureOutbox: async () => { failed++ },
    getCaptureOutboxHealth: async () => ({ pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null }) }
  const runtime = createV105FormalRuntime({ writer }); await runtime.start()
  const app = createApp({ autoConnect: false, production: true, memberAuthRequired: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: true, supabaseClient: writer, v104FormalRuntime: runtime })
  try {
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    console.log('consumer-gap', JSON.stringify({ issued: issued.length, completed, failed }))
    assert.equal(issued.length, 5, 'five complete tables progress while the gap table stays blocked')
    assert.equal(issued.filter(p => p.targetTableId === 'BAV03A').length, 0)
    assert.equal(failed, 1)
    assert.equal(completed, 0, 'existing next-prediction complete condition must remain strict')
    latest = table('recovery'); offered = false
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    console.log('consumer-recovery', JSON.stringify({ issued: issued.length, completed, failed, metadata: app.state.snapshot().tables[0]?.trendBundle }))
    assert.equal(completed, 1, 'immutable pending work must not overwrite recovered same-identity input forever')
    assert.equal(issued.length, 6)
    assert.equal(issued.find(p => p.targetTableId === 'BAV03A').predictionFeatures.road_features.beadPlateRaw, '01020202')
    offered = false
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    assert.equal(completed, 2, 'same Final replay retains strict completion')
    assert.equal(failed, 1)
    assert.equal(issued.length, 6, 'same Final replay must not reissue')
  } finally { await app.stop() }
})


test('v4 historical missing metadata remains unverified and normalization is idempotent', async () => {
  const { withTrendBundle } = await import('../src/trend-bundle.js')
  for (const tableId of ['BAG03', 'BAV03A']) {
    const first = withTrendBundle({ tableId, shoe: 1, round: 4 })
    assert.equal(first.trendBundle.status, 'pending')
    assert.equal(first.trendBundle.completedRound, null)
    assert.deepEqual(withTrendBundle(first), first)
  }
})
