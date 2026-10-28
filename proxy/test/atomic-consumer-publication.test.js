import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'

const ids = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']
const pid = '11111111-1111-4111-8111-111111111111'
const tables = () => ids.map(tableId => ({ tableId, shoe: '88', round: 7, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString(), bigRoadRaw: 'BPBPBPB' }))
const candidate = table => ({ targetTableId: table.tableId, targetShoe: String(table.shoe), targetRound: table.round + 1, strategyVersion: 'v105', predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2, sidePredictions: { tie: 10, superSix: 10, bankerPair: 10, playerPair: 10, bankerDragon: 10, playerDragon: 10 }, sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false } })
const issued = table => ({ ...candidate(table), predictionId: pid, issuedAt: new Date().toISOString() })
const receipt = input => ({ disposition: 'published', publication_revision: 1, table_id: input.tableId, shoe_no: input.shoe, target_round: input.round, prediction_id: input.predictionId })
function harness(options = {}, overrides = {}, existing = false) {
  const calls = { publish: [], issue: 0, build: 0, reconcile: 0 }
  const writer = {
    configured: true,
    getRuntimeStatus() { return { ready: true, degraded: false } },
    async verifyActiveStrategyReadOnly() { return { ok: true, activeStrategyVersion: 'v105' } },
    async getLatestCloudTableSnapshot() { return { snapshot_at: new Date().toISOString(), tables: tables() } },
    async reconcilePredictionLifecycle() { calls.reconcile++ },
    async issuePrediction(value) { calls.issue++; return { ...value, predictionId: pid, issuedAt: new Date().toISOString() } },
    async readIssuedPrediction({ tableId, shoe, round }) { return existing ? issued({ tableId, shoe, round: round - 1 }) : null },
    async publishV105TablePublication(input) { calls.publish.push(input); return receipt(input) },
    ...overrides,
  }
  const app = createApp({ autoConnect: false, production: true, requireVerifiedStrategy: false, memberAuthRequired: false, captureRoundBasis: 'completed', liveAtomicPublicationsEnabled: true, outboxCoalesceMs: 0, port: 0, supabaseClient: writer,
    v104FormalRuntime: { async start() {}, latestIssuance(tableId) { return existing ? issued({ tableId, shoe: '88', round: 7 }) : null }, async buildPrediction(table) { calls.build++; return candidate(table) }, recordIssuance() {}, recordSettlement() {}, snapshot() { return { status: 'ready' } } },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } }, ...options })
  return { app, calls }
}

test('observer publishes hydrated existing issuance and cached retries without recompute', async () => {
  const { app, calls } = harness({}, {}, true)
  try {
    app.state.setTables([tables()[0]])
    await app.waitForServiceWorkIdle()
    app.state.setTables([tables()[0]])
    await app.waitForServiceWorkIdle()
    assert.equal(calls.publish.length, 2)
    assert.deepEqual(calls.publish[0], { tableId: 'BAV01', shoe: '88', round: 8, predictionId: pid })
    assert.equal(calls.issue, 0)
    assert.equal(calls.build, 0)
  } finally { await app.stop() }
})

test('timer retries failed publication from cached issuance and marks only successful tables', async () => {
  let fail = true
  const attempts = []
  const { app, calls } = harness({}, { async publishV105TablePublication(input) { attempts.push(input.tableId); if (input.tableId === 'BAV01' && fail) { fail = false; throw new Error('publication unavailable') }; return receipt(input) } })
  try {
    await assert.rejects(app.refreshLatestDurablePredictions(), /publication unavailable/)
    await app.refreshLatestDurablePredictions()
    assert.equal(attempts.filter(id => id === 'BAV01').length, 2)
    assert.equal(attempts.filter(id => id === 'BAV02').length, 1)
    assert.equal(calls.issue, ids.length)
  } finally { await app.stop() }
})

test('consumer disabled never publishes or issues through observer, timer or drain', async () => {
  const { app, calls } = harness({ captureOutboxConsumerEnabled: false })
  try {
    app.state.setTables(tables())
    await app.waitForServiceWorkIdle()
    await app.refreshLatestDurablePredictions()
    await app.drainCaptureOutbox()
    assert.equal(calls.publish.length, 0)
    assert.equal(calls.issue, 0)
    assert.equal(calls.reconcile, 0)
  } finally { await app.stop() }
})

test('Final completion waits for publication even when issuance is already cached', async () => {
  const order = []
  let claimed = false
  const { app } = harness({}, {
    async publishV105TablePublication(input) { order.push('publish:' + input.tableId); return receipt(input) },
    async claimCaptureOutbox() {
      if (claimed) return []
      claimed = true
      order.length = 0
      return [{ session_id: 'atomic-test', sequence: 1, claim_token: 'claim', attempts: 1, payload: { work: { sessionId: 'atomic-test', tables: [tables()[0]], rounds: [{ tableId: 'BAV01', shoe: '88', round: 7, winner: 'banker', rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9], sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }] } } }]
    },
    async completeCaptureOutbox() { order.push('complete') },
    async failCaptureOutbox({ error }) { order.push('fail:' + error) },
    async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0 } },
  })
  try {
    await app.drainCaptureOutbox()
    assert.deepEqual(order, ['publish:BAV01', 'complete'])
  } finally { await app.stop() }
})

test('Writer publication sends only identity and read uses a single GET RPC', async () => {
  const requests = []
  const input = { tableId: 'BAV01', shoe: '88', round: 8, predictionId: pid }
  const bundle = [{ table: tables()[0], prediction: null, publication: { state: 'pending' } }]
  const writer = createSupabaseIngestionClient({ url: 'https://example.supabase.co', serviceKey: 'test', fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init })
    return { ok: true, status: 200, text: async () => JSON.stringify(receipt(input)), json: async () => bundle }
  } })
  assert.deepEqual(await writer.publishV105TablePublication(input), receipt(input))
  assert.deepEqual(JSON.parse(requests[0].init.body), { p_table_id: 'BAV01', p_shoe_no: '88', p_target_round: 8, p_prediction_id: pid })
  assert.deepEqual(await writer.readV105TablePublications(), bundle)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].init.method, 'GET')
  assert.match(requests[1].url, /rpc\/read_v105_table_publications$/)
})

test('Writer uses the existing direct pool for both RPCs without HTTP or a new pool', async () => {
  const queries = []
  const input = { tableId: 'BAV01', shoe: '88', round: 8, predictionId: pid }
  const writer = createSupabaseIngestionClient({
    strategyPool: { async query(query) { queries.push(query); return { rows: [query.text.includes('publish_v105') ? { publish_v105_table_publication: receipt(input) } : { publications: [] }] } } },
    strategyPoolFactory() { throw new Error('unexpected pool') },
    fetchImpl() { throw new Error('unexpected HTTP') },
  })
  assert.deepEqual(await writer.publishV105TablePublication(input), receipt(input))
  assert.deepEqual(await writer.readV105TablePublications(), [])
  assert.deepEqual(queries[0].values, ['BAV01', '88', 8, pid])
  assert.match(queries[1].text, /^select public.read_v105_table_publications/)
  assert.equal(queries.length, 2)
})

test('Writer rejects mismatched ACKs including superseded identity and malformed input', async () => {
  const input = { tableId: 'BAV01', shoe: '88', round: 8, predictionId: pid }
  let response = { ...receipt(input), table_id: 'BAV02' }
  let writes = 0
  const writer = createSupabaseIngestionClient({ strategyPool: { async query() { writes++; return { rows: [{ publish_v105_table_publication: response }] } } } })
  await assert.rejects(writer.publishV105TablePublication(input), /acknowledgement/)
  response = { ...response, disposition: 'superseded', publication_revision: null, prediction_id: null }
  await assert.rejects(writer.publishV105TablePublication(input), /acknowledgement/)
  response.table_id = 'BAV01'
  assert.equal((await writer.publishV105TablePublication(input)).disposition, 'superseded')
  await assert.rejects(writer.publishV105TablePublication({ ...input, predictionId: 'not-a-uuid' }), /identity/)
  assert.equal(writes, 3)
})

test('superseded publication leaves timer success cursor unset for recovery', async () => {
  let superseded = true
  let attempts = 0
  const { app, calls } = harness({}, { async publishV105TablePublication(input) {
    attempts++
    return superseded ? { ...receipt(input), disposition: 'superseded', publication_revision: null, prediction_id: null } : receipt(input)
  } })
  try {
    await assert.rejects(app.refreshLatestDurablePredictions(), /superseded/)
    superseded = false
    await app.refreshLatestDurablePredictions()
    assert.equal(attempts, ids.length * 2)
    assert.equal(calls.issue, ids.length)
  } finally { await app.stop() }
})

test('disabled feature flag preserves old Consumer issuance with zero publication', async () => {
  const { app, calls } = harness({ liveAtomicPublicationsEnabled: false })
  try {
    await app.refreshLatestDurablePredictions()
    assert.equal(calls.issue, ids.length)
    assert.equal(calls.publish.length, 0)
  } finally { await app.stop() }
})

test('lost issuance ACK exact-read fallback publishes without a second issuance', async () => {
  const { app, calls } = harness({}, {
    async issuePrediction() { calls.issue++; throw new Error('lost ACK') },
    async readIssuedPrediction({ tableId, shoe, round }) { return issued({ tableId, shoe, round: round - 1 }) },
  })
  try {
    await app.refreshLatestDurablePredictions()
    assert.equal(calls.publish.length, ids.length)
    assert.equal(calls.issue, ids.length)
  } finally { await app.stop() }
})

test('real refresh timer publishes new targets without a Final', async () => {
  let round = 7
  const { app, calls } = harness({ latestPredictionRefreshMs: 10 }, {
    async getLatestCloudTableSnapshot() { return { snapshot_at: new Date().toISOString(), tables: tables().map(table => ({ ...table, round })) } },
  })
  const waitFor = async predicate => {
    const deadline = Date.now() + 2000
    while (!predicate()) { if (Date.now() > deadline) throw new Error('timer publication timeout'); await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  try {
    await app.start()
    await waitFor(() => calls.publish.some(value => value.round === 8))
    round = 8
    await waitFor(() => calls.publish.some(value => value.round === 9))
  } finally { await app.stop() }
})
