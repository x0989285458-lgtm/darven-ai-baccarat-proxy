import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.js'
import { createV105FormalRuntime } from '../src/v105-formal-runtime.js'
test('unknown child Final cannot turn into an empty successful heartbeat', async () => {
 let sent=false, completed=0, failed=0
 const writer={configured:true,claimCaptureTableWork:async()=>sent?[]:(sent=true,[{id:'9',table_id:'BAV01',session_id:'s',sequence:1,claim_token:'x',attempts:1,payload:{work:{tables:[],rounds:[{tableId:'BAV01',unexpected:'unknown'}]}}}]),completeCaptureTableWork:async()=>{completed++},failCaptureTableWork:async()=>{failed++},getCaptureTableWorkHealth:async()=>({pending:0,error:0,processing:0})}
 const app=createApp({autoConnect:false,captureOutboxMode:'table-lanes-v1',supabaseClient:writer})
 try { await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle(); assert.equal(completed,0); assert.equal(failed,1) } finally { await app.stop() }
})
const text = readFileSync(new URL('../../frontend/src/test-fixtures/sourcePipeline.ts', import.meta.url), 'utf8')
const fixture = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('} as const') + 1))
const ids = ['BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06']

test('CT06 persistence rejection isolates a lane without advancing its successful refresh cursor', async () => {
  let rejectPersistence = true
  let clock = Date.now()
  let latest
  const attempts = []
  const done = []
  const failed = []
  const children = ['BAV03A', 'BAV01'].map((id, i) => ({
    id: String(i + 1), table_id: id, session_id: 'ct06', sequence: 1,
    claim_token: `ct06-${i}`, attempts: 1,
    payload: { work: { tables: [table(id)], rounds: [{ tableId: id, shoe: 1648, round: 4, winner: 'banker', sourceAction: 'summary', rawResult: [1,2,3,4,0,0,-1,-1,4,6] }] } },
  }))
  const offered = [...children]
  const writer = {
    configured: true, getRuntimeStatus: () => ({ ready: true, degraded: false }),
    getV105FormalHistory: async () => [], readIssuedPrediction: async () => null,
    reconcilePredictionLifecycle: async () => ({ ok: true }),
    issuePrediction: async p => {
      attempts.push(p.targetTableId)
      if (rejectPersistence && p.targetTableId === 'BAV03A') throw new Error('CT06 persistence unavailable')
      return { ...p, predictionId: `ct06-${p.targetTableId}-${p.targetRound}`, issuedAt: new Date().toISOString() }
    },
    getLatestCloudTableSnapshot: async () => ({ tables: latest, snapshot_at: new Date().toISOString() }),
    claimCaptureTableWork: async () => offered.length ? [offered.shift()] : [],
    completeCaptureTableWork: async c => { done.push(c); return true },
    failCaptureTableWork: async c => { failed.push(c); return true },
    getCaptureTableWorkHealth: async () => ({ pending: 0, processing: 0, error: failed.length, next_wakeup_at: null }),
  }
  latest = ids.map(id => table(id))
  const runtime = createV105FormalRuntime({ writer }); await runtime.start()
  const app = createApp({ now: () => clock, autoConnect: false, production: true, memberAuthRequired: false, captureRoundBasis: 'completed', captureOutboxMode: 'table-lanes-v1', supabaseClient: writer, v104FormalRuntime: runtime })
  try {
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    assert.deepEqual(done.map(c => c.id), ['2'], 'healthy child must complete despite beforeClaim persistence exception')
    assert.deepEqual(failed.map(c => c.id), ['1'], 'failed child must not be acknowledged complete')
    const before = attempts.filter(id => id === 'BAV03A').length
    clock += 11000 // Advance the existing issuance retry backoff, not product policy.
    await app.refreshLatestDurablePredictions({ beforeClaim: true })
    assert.ok(attempts.filter(id => id === 'BAV03A').length > before, 'failed signature must remain retryable')
    rejectPersistence = false
    clock += 11000
    await app.refreshLatestDurablePredictions({ beforeClaim: true })
    const recovered = attempts.length
    await app.refreshLatestDurablePredictions({ beforeClaim: true })
    assert.equal(attempts.length, recovered, 'successful signatures may advance only after durable issuance')
    offered.push({ ...children[0], attempts: 2, claim_token: 'ct06-retry' })
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    assert.deepEqual(done.map(c => c.id), ['2', '1'])
    latest = latest.slice(1)
    await assert.rejects(app.refreshLatestDurablePredictions({ beforeClaim: true }), /fresh complete cloud snapshot/)
  } finally { await app.stop() }
  const legacy = createApp({ autoConnect: false, production: true, memberAuthRequired: false, captureRoundBasis: 'completed', supabaseClient: writer, v104FormalRuntime: createV105FormalRuntime({ writer }) })
  try {
    latest = ids.map(id => table(id)); rejectPersistence = true
    await assert.rejects(legacy.refreshLatestDurablePredictions({ beforeClaim: true }), /latest actionable cloud tables require durable v105 predictions/)
  } finally { await legacy.stop() }
})
const table = (id, gap = false) => { const t = structuredClone(fixture[gap ? 'gap' : 'recovery']); delete t.prediction; return { ...t, tableId: id, round: 4, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString(), trendBundle: { ...t.trendBundle, tableId: id } } }
test('table lanes real App/Formal/Consumer isolates mixed parent and recovers immutable gap child', async () => {
  let latest = ids.map(id => table(id, id === 'BAV03A'))
  const children = ['BAV03A','BAV01'].map((id, i) => ({ id: String(i + 1), parent_id: '1', session_id: 'same', sequence: 1, table_id: id, claim_token: `lease-${i}`, attempts: 1, payload: { work: { tables: [table(id, id === 'BAV03A')], rounds: [{ tableId: id, shoe: 1648, round: 4, winner: 'banker', sourceAction: 'summary', rawResult: [1,2,3,4,0,0,-1,-1,4,6] }] } } }))
  const offered = [...children]; const done = []; const failures = []; const issued = []
  const writer = { configured: true, getRuntimeStatus: () => ({ ready: true, degraded: false }), getV105FormalHistory: async () => [], readIssuedPrediction: async () => null,
    issuePrediction: async p => { issued.push(p); return { ...p, predictionId: `local-${p.targetTableId}-${p.targetRound}`, issuedAt: new Date().toISOString() } }, reconcilePredictionLifecycle: async () => ({ ok: true }),
    getLatestCloudTableSnapshot: async () => ({ tables: latest, snapshot_at: new Date().toISOString() }),
    claimCaptureOutbox: async () => { throw Error('legacy claim forbidden') },
    claimCaptureTableWork: async () => offered.length ? [offered.shift()] : [],
    completeCaptureTableWork: async c => { done.push(c); return true }, failCaptureTableWork: async c => { failures.push(c); return true },
    getCaptureTableWorkHealth: async () => ({ pending: 0, processing: 0, error: failures.length, next_wakeup_at: null }) }
  const runtime = createV105FormalRuntime({ writer }); await runtime.start()
  const app = createApp({ autoConnect: false, production: true, memberAuthRequired: false, captureRoundBasis: 'completed', captureOutboxMode: 'table-lanes-v1', supabaseClient: writer, v104FormalRuntime: runtime })
  try {
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    assert.deepEqual(done.map(x => x.id), ['2'])
    assert.deepEqual(failures.map(x => x.id), ['1'])
    assert.equal(issued.filter(p => p.targetTableId === 'BAV03A').length, 0)
    latest = ids.map(id => table(id)); offered.push({ ...children[0], attempts: 2, claim_token: 'retry' })
    await app.drainCaptureOutbox(); await app.waitForCaptureOutboxIdle()
    assert.deepEqual(done.map(x => x.id), ['2','1'])
    assert.equal(done[1].attempt, 2); assert.equal(done[1].claimToken, 'retry')
    assert.equal(issued.filter(p => p.targetTableId === 'BAV03A').length, 1)
  } finally { await app.stop() }
})
