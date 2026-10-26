import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { parseCloudCapturePayload, applyCloudCapturePayload } from '../src/cloud-capture.js'
import { createV105FormalRuntime } from '../src/v105-formal-runtime.js'

const text = readFileSync(new URL('../../frontend/src/test-fixtures/sourcePipeline.ts', import.meta.url), 'utf8')
const fixtures = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('} as const') + 1))
const table = (kind, id = 'BAV03A') => {
  const t = structuredClone(fixtures[kind]); delete t.prediction
  return { ...t, tableId: id, round: 4, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString(), trendBundle: { ...t.trendBundle, tableId: id } }
}
const wait = async predicate => {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)) }
  assert.fail('real HTTP SSE handler did not publish same-identity recovery')
}

test('real Formal Final gap must not issue; exact recovery issues once with complete roads', async () => {
  const issued = []
  const writer = { configured: true, getV105FormalHistory: async () => [], readIssuedPrediction: async () => null,
    issuePrediction: async p => { issued.push(structuredClone(p)); return { ...p, predictionId: `offline-${p.targetRound}`, issuedAt: new Date().toISOString() } },
    reconcilePredictionLifecycle: async () => ({ ok: true }) }
  const runtime = createV105FormalRuntime({ writer }); await runtime.start()
  const app = createApp({ autoConnect: false, production: false, memberAuthRequired: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: true, supabaseClient: writer, v104FormalRuntime: runtime })
  try {
    const parsed = parseCloudCapturePayload({ tables: [table('gap')], rounds: [{ tableId: 'BAV03A', shoe: 1648, round: 4, winner: 'banker', sourceAction: 'summary', rawResult: [1,2,3,4,0,0,-1,-1,4,6] }] })
    const applied = await applyCloudCapturePayload({ parsed, state: app.state, writer, completedRoundIdentity: true, persistAncillary: false })
    await app.waitForServiceWorkIdle()
    assert.equal(applied.settlementReceipts[0].disposition, 'no_issuance')
    assert.equal(issued.length, 0, 'known coverage2/completed4 must not issue target5')
    app.state.setTables(parseCloudCapturePayload({ tables: [table('recovery')] }).tables)
    await app.waitForServiceWorkIdle()
    assert.equal(issued.length, 1)
    assert.equal(issued[0].targetRound, 5)
    assert.equal(issued[0].predictionFeatures.road_features.beadPlateRaw, '01020202')
    app.state.setTables(parseCloudCapturePayload({ tables: [table('recovery')] }).tables)
    await app.waitForServiceWorkIdle()
    assert.equal(issued.length, 1)
  } finally { await app.stop() }
})

test('real Consumer must recover immutable gap Final after same-identity source recovery', async () => {
  let issued = [], completed = 0, failed = 0, offered = false, attempts = 0
  const gap = table('gap')
  let latest = gap
  const work = { tables: [gap], rounds: [{ tableId: 'BAV03A', shoe: 1648, round: 4, winner: 'banker', sourceAction: 'summary', rawResult: [1,2,3,4,0,0,-1,-1,4,6] }] }
  const writer = { configured: true, getV105FormalHistory: async () => [], readIssuedPrediction: async () => null,
    issuePrediction: async p => { issued.push(structuredClone(p)); return { ...p, predictionId: `offline-${p.targetRound}`, issuedAt: new Date().toISOString() } },
    reconcilePredictionLifecycle: async () => ({ ok: true }),
    getLatestCloudTableSnapshot: async () => ({ tables: [latest], snapshot_at: new Date().toISOString() }),
    claimCaptureOutbox: async () => { if (offered) return []; offered = true; attempts++; return [{ session_id: 'offline', sequence: 1, claim_token: `exact-lease-${attempts}`, attempts, payload: { work } }] },
    completeCaptureOutbox: async () => { completed++ }, failCaptureOutbox: async () => { failed++ },
    getCaptureOutboxHealth: async () => ({ pending: 0, processing: 0, error: 0, dead_letter: 0, next_wakeup_at: null }) }
  const runtime = createV105FormalRuntime({ writer }); await runtime.start()
  const app = createApp({ autoConnect: false, production: false, memberAuthRequired: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: true, supabaseClient: writer, v104FormalRuntime: runtime })
  try {
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    console.log('consumer-gap', JSON.stringify({ issued: issued.length, completed, failed }))
    assert.equal(issued.length, 0, 'Consumer must not issue from known incomplete roads')
    assert.equal(completed, 0, 'existing next-prediction complete condition must remain strict')
    latest = table('recovery'); offered = false
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    console.log('consumer-recovery', JSON.stringify({ issued: issued.length, completed, failed, metadata: app.state.snapshot().tables[0]?.trendBundle }))
    assert.equal(completed, 1, 'immutable pending work must not overwrite recovered same-identity input forever')
    assert.equal(issued.length, 1)
    assert.equal(issued[0].predictionFeatures.road_features.beadPlateRaw, '01020202')
  } finally { await app.stop() }
})

test('real HTTP SSE handler publishes same-identity enrichment without another table or reconnect', async () => {
  const ids = ['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']
  const app = createApp({ autoConnect: false, production: false, memberAuthRequired: false, captureOutboxConsumerEnabled: false, supabaseClient: { configured: false }, streamHeartbeatMs: 10000 })
  const res = new EventEmitter(), frames = []
  res.writeHead = code => { res.code = code }; res.write = frame => { frames.push(frame); return true }; res.end = () => res.emit('close')
  const tables = () => frames.filter(f => f.includes('event: tables')).map(f => JSON.parse(f.split('data: ')[1]))
  try {
    app.state.setTables(parseCloudCapturePayload({ tables: ids.map(id => table('gap', id)) }).tables)
    app.server.emit('request', { url: '/api/tables/stream', method: 'GET', headers: {} }, res)
    await wait(() => tables().length > 0)
    assert.equal(tables()[0].tables.length, 6)
    app.state.setTables(parseCloudCapturePayload({ tables: ids.map(id => table('recovery', id)) }).tables)
    await wait(() => tables().some(f => f.tables.every(t => t.trendBundle.status === 'available')))
    const legacy = ids.map(id => { const t = table('gap', id); delete t.trendBundle; return t })
    app.state.setTables(parseCloudCapturePayload({ tables: legacy }).tables)
    await wait(() => tables().some(f => f.tables.every(t => t.trendBundle.completedRound === null)))
  } finally { res.emit('close'); await app.stop() }
})
