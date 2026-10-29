import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { parseCloudCapturePayload, PRODUCTION_TABLE_IDS as ids } from '../src/cloud-capture.js'
import { buildCloudTableSnapshotRow, createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { normalizeMtTable } from '../src/normalize-table.js'

const epoch = '1970-01-01T00:00:00.000Z'
const rooms = ['48', '49', '50', '51', '52', '57']
// Exact missing-table producer + snapshot-pusher wire contract: pusher removes
// catalogScreenInvalid, retains catalogMissing; no invented shoe/trend/round.
const missingWire = (id = 'BAV06') => ({ table_id: id, tableId: id,
  room_id: rooms[ids.indexOf(id)], hall: 3, table_type: 'BAC',
  catalogMissing: true, sourceUpdatedAt: epoch, updated_at: epoch })
const validWire = (id) => ({ table_id: id, tableId: id, table_type: 'BAC',
  room_id: rooms[ids.indexOf(id)], hall: 3, shoe: 88, round: 7,
  trend: { current_shoe: 88, current_round: 8, total_round: 7 }, updated_at: new Date().toISOString() })
const parse = rows => parseCloudCapturePayload({ tables: rows }).tables
const six = () => ids.map(validWire)
const final = (tableId = 'BAV01') => ({ tableId, shoe: 88, round: 7, winner: 'banker',
  rawResult: [1, 9, 2, 10, -1, -1, -1, -1, 1, 9],
  sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary' })
const candidate = table => ({ targetTableId: table.tableId, targetShoe: String(table.shoe), targetRound: table.round + 1,
  strategyVersion: 'v105', predictionTiming: 'pre_result_context', predictedResult: 'banker', sameSideStreak: 2,
  sidePredictions: { tie: 10, superSix: 10, bankerPair: 10, playerPair: 10, bankerDragon: 10, playerDragon: 10 },
  sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false } })
function harness({ rows = [...six().slice(0, 5), missingWire()], work, overrides = {} } = {}) {
  const calls = { issue: [], publish: [], claims: [], complete: [], fail: [], persist: [] }
  let snapshot = { snapshot_at: new Date().toISOString(), tables: parse(rows) }, claimed = false
  const writer = { configured: true,
    async getLatestCloudTableSnapshot() { return structuredClone(snapshot) },
    async reconcilePredictionLifecycle() {},
    async issuePrediction(p) { calls.issue.push(p); return { ...p, predictionId: `p-${p.targetTableId}-${p.targetRound}`, issuedAt: new Date().toISOString() } },
    async readIssuedPrediction() { return null },
    async publishV105TablePublication(p) { calls.publish.push(p); return { disposition: 'published', publication_revision: 1,
      table_id: p.tableId, shoe_no: p.shoe, target_round: p.round, prediction_id: p.predictionId } },
    async claimCaptureOutbox(input) {
      calls.claims.push(input)
      if (claimed) return []
      claimed = true
      return [{ session_id: 'fixture', sequence: 1, claim_token: 'exact-lease', attempts: 2,
        payload: { work: work ?? { tables: rows, rounds: [final()] } } }]
    },
    async completeCaptureOutbox(p) { calls.complete.push(p) },
    async failCaptureOutbox(p) { calls.fail.push(p) },
    async getCaptureOutboxHealth() { return { pending: 0, processing: 0, error: 0, dead_letter: 0 } },
    ...overrides,
  }
  const app = createApp({ autoConnect: false, production: true, requireVerifiedStrategy: false, memberAuthRequired: false,
    captureRoundBasis: 'completed', liveAtomicPublicationsEnabled: true, outboxCoalesceMs: 0, port: 0, supabaseClient: writer,
    v104FormalRuntime: { async start() {}, latestIssuance() { return null }, async buildPrediction(table) { return candidate(table) },
      recordIssuance() {}, recordSettlement() {}, snapshot() { return { status: 'ready' } } },
    v100FormalRuntime: { enabled: true, async processSnapshot({ tables }) { return { tables } } } })
  return { app, calls, setRows(rows) { snapshot = { snapshot_at: new Date().toISOString(), tables: parse(rows) } },
    setSnapshot(value) { snapshot = value } }
}

test('real drain: five valid plus strict missing wire issues five and claims/ACKs exact lease', async () => {
  const { app, calls } = harness()
  try {
    await app.drainCaptureOutbox()
    assert.deepEqual(calls.issue.map(p => p.targetTableId).sort(), ids.slice(0, 5).sort())
    assert.equal(calls.fail.length, 0)
    assert.deepEqual(calls.complete, [{ sessionId: 'fixture', sequence: 1, claimToken: 'exact-lease', attempt: 2 }])
    assert.equal(calls.publish.some(p => p.tableId === 'BAV06'), false)
    const absent = app.state.snapshot().tables.find(t => t.tableId === 'BAV06')
    assert.equal(absent.availability, 'catalog_missing')
    assert.equal(absent.shoe, null)
    assert.equal(absent.round, null)
    assert.equal(absent.sourceUpdatedAt, epoch)
  } finally { await app.stop() }
})

test('all missing still claims heartbeat without issuance or publication', async () => {
  const rows = ids.map(missingWire)
  const { app, calls } = harness({ rows, work: { tables: rows, rounds: [] } })
  try {
    await app.drainCaptureOutbox()
    assert.equal(calls.complete.length, 1)
    assert.equal(calls.issue.length, 0)
    assert.equal(calls.publish.length, 0)
    assert.equal(app.state.snapshot().tables.length, 6)
  } finally { await app.stop() }
})

test('missing revokes prior screen including lastRound and recovers naturally without replaying claimed old screen', async () => {
  const { app, calls, setRows } = harness({ rows: six(), work: { tables: six(), rounds: [final('BAV06')] } })
  try {
    await app.refreshLatestDurablePredictions()
    app.state.setTables(app.state.snapshot().tables.map(t => t.tableId === 'BAV06' ? { ...t, lastRound: final('BAV06') } : t))
    await app.waitForServiceWorkIdle()
    setRows([...six().slice(0, 5), missingWire()])
    const issued = calls.issue.length, published = calls.publish.length
    await app.drainCaptureOutbox()
    assert.equal(calls.complete.length, 1)
    assert.equal(calls.issue.length, issued)
    assert.equal(calls.publish.slice(published).some(p => p.tableId === 'BAV06'), false)
    const absent = app.state.snapshot().tables.find(t => t.tableId === 'BAV06')
    assert.equal(absent.shoe, null)
    assert.equal(absent.round, null)
    assert.equal(absent.lastRound, undefined)
    assert.equal(absent.prediction, undefined)
    assert.equal(absent.sourceUpdatedAt, epoch)
    setRows(six())
    await app.refreshLatestDurablePredictions()
    assert.ok(calls.publish.slice(published).some(p => p.tableId === 'BAV06'))
    assert.equal(app.state.snapshot().tables.find(t => t.tableId === 'BAV06').round, 7)
  } finally { await app.stop() }
})

test('parser and real writer/read roundtrip preserve typed missing with no fabricated identity', async () => {
  const tables = parse([...six().slice(0, 5), missingWire()])
  const missing = tables.at(-1)
  assert.equal(missing.availability, 'catalog_missing')
  assert.equal(missing.catalogMissing, true)
  assert.equal(missing.roundBasis, undefined)
  assert.equal(missing.round, null)
  assert.deepEqual(parse(tables), tables)
  let stored
  const client = createSupabaseIngestionClient({ url: 'https://example.invalid', serviceKey: 'fixture-only',
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') { stored = JSON.parse(init.body).p_snapshot; return { ok: true, text: async () => JSON.stringify({ ok: true }) } }
      return { ok: true, text: async () => JSON.stringify([stored]), json: async () => [structuredClone(stored)] }
    } })
  await client.writeCloudTableSnapshot({ tables })
  const read = await client.getLatestCloudTableSnapshot()
  assert.equal(read.tables.at(-1).availability, 'catalog_missing')
  assert.equal(read.tables.at(-1).sourceUpdatedAt, epoch)
  assert.equal(read.tables.at(-1).shoe, null)
})

test('only exact trusted missing wire is typed; malformed/forged markers fail closed', async t => {
  for (const [name, patch] of Object.entries({ wrongRoom: { room_id: '48' }, wrongHall: { hall: 9 },
    wrongType: { table_type: 'BAS' }, wrongAlias: { tableId: 'BAV05' }, unknownId: { table_id: 'UNKNOWN', tableId: 'UNKNOWN' },
    fresh: { updated_at: new Date().toISOString() }, partial: { shoe: 88 }, trend: { trend: {} },
    oldPrediction: { prediction: {} }, oldRoad: { bigRoadRaw: 'BP' }, unknownKind: { availability: 'unknown' } })) {
    await t.test(name, () => assert.throws(() => parse([{ ...missingWire(), ...patch }]), /unavailable|missing/i))
  }
  assert.throws(() => parse([...six(), missingWire()]), /duplicate/i)
})

test('typed unavailable proof is validated at parser, writer and DB read boundaries', async t => {
  const missing = parse([missingWire()])[0]
  for (const [name, patch] of Object.entries({ identity: { tableId: 'BAV99' }, room: { roomId: '48' },
    flag: { catalogMissing: false }, round: { round: 0 }, basis: { roundBasis: 'completed' },
    road: { bigRoadRaw: 'BP' }, prediction: { prediction: candidate({ tableId: 'BAV06', shoe: 88, round: 7 }) },
    time: { sourceUpdatedAt: new Date().toISOString() } })) await t.test(name, async () => {
    const bad = { ...missing, ...patch }
    assert.throws(() => parse([bad]), /unavailable/)
    assert.throws(() => buildCloudTableSnapshotRow({ tables: [bad] }), /unavailable/)
    const client = createSupabaseIngestionClient({ url: 'https://example.invalid', serviceKey: 'fixture-only',
      fetchImpl: async () => ({ ok: true, json: async () => [{ tables: [bad] }], text: async () => JSON.stringify([{ tables: [bad] }]) }) })
    await assert.rejects(client.getLatestCloudTableSnapshot(), /unavailable/)
  })
})

test('claimed normalized malformed and duplicates fail exact lease instead of ACK', async t => {
  for (const kind of ['malformed', 'forged', 'duplicate', 'wrongId']) await t.test(kind, async () => {
    const tables = parse(six())
    if (kind === 'malformed') tables[5] = { tableId: 'BAV06', round: null, shoe: null }
    if (kind === 'forged') tables[5].availability = 'catalog_missing'
    if (kind === 'duplicate') tables[5] = tables[4]
    if (kind === 'wrongId') tables[5].tableId = 'BAV99'
    const { app, calls } = harness({ work: { status: {}, tables, rounds: [final()] } })
    try {
      await app.drainCaptureOutbox()
      assert.equal(calls.complete.length, 0)
      assert.equal(calls.fail.length, 1)
      assert.equal(calls.fail[0].claimToken, 'exact-lease')
      assert.equal(calls.fail[0].attempt, 2)
    } finally { await app.stop() }
  })
})

test('recovery cannot rewind prior same-shoe round or shoe chronology', async t => {
  for (const kind of ['round', 'shoe']) await t.test(kind, async () => {
    const { app, calls, setRows } = harness({ rows: six() })
    try {
      await app.refreshLatestDurablePredictions()
      setRows([...six().slice(0, 5), missingWire()])
      await app.refreshLatestDurablePredictions()
      const issued = calls.issue.length, published = calls.publish.length
      const recovery = validWire('BAV06')
      if (kind === 'round') { recovery.round = 6; recovery.trend.total_round = 6; recovery.trend.current_round = 7 }
      else { recovery.shoe = 87; recovery.trend.current_shoe = 87 }
      setRows([...six().slice(0, 5), recovery])
      await assert.rejects(app.drainCaptureOutbox(), /regression/)
      assert.equal(calls.claims.length, 0)
      assert.equal(calls.issue.length, issued)
      assert.equal(calls.publish.length, published)
      assert.equal(app.state.snapshot().tables.at(-1).round, null)
    } finally { await app.stop() }
  })
})

test('all missing drains unissued Final without invention, and stale claimed tombstone cannot revoke recovered inventory', async t => {
  for (const kind of ['allMissing', 'recovered']) await t.test(kind, async () => {
    const missing = ids.map(missingWire)
    const { app, calls } = harness({ rows: kind === 'allMissing' ? missing : six(),
      work: { tables: missing, rounds: [final('BAV06')] } })
    try {
      await app.drainCaptureOutbox()
      assert.equal(calls.complete.length, 1, app.state.snapshot().status.persistenceError)
      assert.equal(calls.fail.length, 0)
      assert.equal(calls.issue.length, kind === 'allMissing' ? 0 : 6)
      assert.equal(app.state.snapshot().tables.at(-1).round, kind === 'allMissing' ? null : 7)
    } finally { await app.stop() }
  })
})

test('fresh inventory unknown malformed, duplicates, wrong identity, stale and transport errors prevent claim', async t => {
  const cases = {
    unknownMalformed: tables => { tables[5] = { tableId: 'BAV06', shoe: null, round: null, sourceUpdatedAt: epoch } },
    forgedTyped: tables => { tables[5] = { ...tables[5], availability: 'catalog_missing' } },
    duplicate: tables => { tables[5] = tables[4] },
    wrongId: tables => { tables[5].tableId = 'BAV99' },
    nullRound: tables => { tables[5].round = null },
    nullShoe: tables => { tables[5].shoe = null },
  }
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const { app, calls, setSnapshot } = harness()
    const tables = parse(six()); mutate(tables)
    setSnapshot({ snapshot_at: new Date().toISOString(), tables })
    try { await assert.rejects(app.drainCaptureOutbox()); assert.equal(calls.claims.length, 0) }
    finally { await app.stop() }
  })
  for (const kind of ['stale', 'transport']) await t.test(kind, async () => {
    const { app, calls, setSnapshot } = harness({ overrides: kind === 'transport' ? { async getLatestCloudTableSnapshot() { throw Error('transport failed') } } : {} })
    if (kind === 'stale') setSnapshot({ snapshot_at: epoch, tables: parse(six()) })
    try { await assert.rejects(app.drainCaptureOutbox()); assert.equal(calls.claims.length, 0) }
    finally { await app.stop() }
  })
})

test('missing table true historical Final settles exact immutable issuance without new issue/publication', async () => {
  const exact = { ...candidate({ tableId: 'BAV06', shoe: 88, round: 6 }), predictionId: 'immutable-final7', issuedAt: new Date().toISOString() }
  const reads = [], persisted = []
  const { app, calls } = harness({ work: { tables: six(), rounds: [final('BAV06')] }, overrides: {
    async readIssuedPrediction(input) { reads.push(input); return input.tableId === 'BAV06' && input.round === 7 ? exact : null },
    async persistRound(round, table, prediction) { persisted.push({ round, table, prediction }); return { compactPrediction: { ...prediction, settlement_final: true } } },
  } })
  try {
    await app.drainCaptureOutbox()
    assert.equal(calls.complete.length, 1, app.state.snapshot().status.persistenceError)
    assert.equal(calls.fail.length, 0)
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].prediction.predictionId, exact.predictionId)
    assert.equal(persisted[0].table.round, 7)
    assert.ok(reads.some(r => r.tableId === 'BAV06' && r.round === 7 && String(r.shoe) === '88'))
    assert.equal(calls.issue.some(p => p.targetTableId === 'BAV06'), false)
    assert.equal(calls.publish.some(p => p.tableId === 'BAV06'), false)
    assert.equal(app.state.snapshot().tables.find(t => t.tableId === 'BAV06').round, null)
  } finally { await app.stop() }
})

test('authenticated fenced ingest -> real writer RPC JSON -> DB reader -> real drain retains missing proof', async () => {
  let capture, writes = 0
  const response = payload => ({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })
  const client = createSupabaseIngestionClient({ url: 'https://example.invalid', serviceKey: 'fixture-only',
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') {
        assert.match(String(url), /persist_v105_fenced_capture_envelope/)
        capture = JSON.parse(init.body).p_capture; writes++
        return response({ persisted: true, accepted_round_keys: capture.round_keys })
      }
      return response([capture.snapshot])
    } })
  const source = { mode: 'api', ownerId: 'fixture-owner', epoch: 1, fence: 'fixture-fence' }
  const envelope = { protocolVersion: 'v105', timestamp: Date.now(), sequence: 1, source,
    roundKeys: ['BAV01:88:7'], snapshot: { buildVersion: '105', sessionId: 'fixture', connected: true, authenticated: true, source,
      tables: [...six().slice(0, 5), missingWire()], rounds: [{ ...final(), source: { ...source, sequence: 1 } }] } }
  const ingress = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    ingestKey: 'fixture-key', requireFencedIngest: true, supabaseClient: client })
  const send = (value, key = 'fixture-key') => ingress.inject({ method: 'POST', url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': key }, body: JSON.stringify(value) })
  try {
    assert.equal((await send(envelope, 'wrong')).statusCode, 401)
    assert.equal(writes, 0)
    const mismatch = structuredClone(envelope); mismatch.snapshot.source.ownerId = 'wrong-owner'
    assert.equal((await send(mismatch)).statusCode, 409)
    assert.equal(writes, 0)
    const accepted = await send(envelope)
    assert.equal(accepted.statusCode, 200, accepted.body)
    assert.equal(writes, 1)
    assert.equal(capture.work.tables.at(-1).availability, 'catalog_missing')
    assert.equal(capture.snapshot.tables.at(-1).availability, 'catalog_missing')
    const { app, calls } = harness({ work: capture.work, overrides: { getLatestCloudTableSnapshot: client.getLatestCloudTableSnapshot } })
    try {
      await app.drainCaptureOutbox()
      assert.equal(calls.complete.length, 1, app.state.snapshot().status.persistenceError)
      assert.equal(calls.issue.length, 5)
      assert.equal(calls.publish.some(p => p.tableId === 'BAV06'), false)
    } finally { await app.stop() }
    for (const kind of ['duplicate', 'wrongRoom', 'extraIdentity']) {
      const invalid = structuredClone(envelope); invalid.sequence++
      if (kind === 'duplicate') invalid.snapshot.tables.push(validWire('BAV01'))
      if (kind === 'wrongRoom') invalid.snapshot.tables[5].room_id = '48'
      if (kind === 'extraIdentity') invalid.snapshot.tables.push({ tableId: 'BAV99' })
      assert.notEqual((await send(invalid)).statusCode, 200)
      assert.equal(writes, 1)
    }
  } finally { await ingress.stop() }
})

test('atomic public read revokes a previously ready screen when missing inventory arrives', async () => {
  const at = new Date(Date.now() - 10).toISOString()
  const bundle = table => {
    const prediction = { ...candidate(table), predictionId: `immutable-${table.tableId}`, issuedAt: at, confidence: 60 }
    const identity = { tableId: table.tableId, shoe: String(table.shoe), round: table.round + 1 }
    return { table: { ...table, sourceUpdatedAt: at }, prediction,
      publication: { state: 'ready', revision: 1, publishedAt: at, sourceCapturedAt: at,
        rawIdentity: identity, readyIdentity: { ...identity, predictionId: prediction.predictionId } } }
  }
  let bundles = parse(six()).map(bundle)
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', liveAtomicPublicationsEnabled: true,
    captureOutboxConsumerEnabled: false, livePredictionReadWaitMs: 25,
    supabaseClient: { configured: true, async readV105TablePublications() { return structuredClone(bundles) } } })
  try {
    const before = JSON.parse((await app.inject({ url: '/api/tables' })).body)
    assert.ok(before.at(-1).prediction)
    // The existing SQL RPC emits pending + null prediction for null/1970 raw
    // identity, even while an old durable publication row remains in storage.
    bundles[5] = { table: parse([missingWire()])[0], prediction: null,
      publication: { state: 'pending', sourceCapturedAt: epoch, readyIdentity: null } }
    await new Promise(resolve => setTimeout(resolve, 110)) // expire public read cache
    const after = JSON.parse((await app.inject({ url: '/api/tables' })).body)
    assert.equal(after.length, 6)
    assert.ok(after.slice(0, 5).every(t => t.prediction))
    assert.equal(after[5].screenUnavailable, true)
    assert.equal(after[5].publication.state, 'unavailable')
    assert.equal(after[5].publication.readyIdentity, null)
    assert.equal(after[5].round, undefined)
    assert.equal(after[5].prediction, undefined)
  } finally { await app.stop() }
})

test('pre-fix parser projection without flags crosses DB reader and claimed FIFO safely', async () => {
  // normalizeMtTable is the unchanged mapper used by e82e97d's raw parser.
  const legacy = normalizeMtTable(missingWire(), 5)
  assert.equal(legacy.catalogMissing, undefined)
  assert.equal(legacy.roundBasis, undefined)
  const rows = [...parse(six()).slice(0, 5), legacy]
  const stored = buildCloudTableSnapshotRow({ tables: rows })
  const reader = createSupabaseIngestionClient({ url: 'https://example.invalid', serviceKey: 'fixture-only',
    fetchImpl: async () => ({ ok: true, json: async () => [stored] }) })
  const { app, calls } = harness({ work: { status: {}, tables: rows, rounds: [final()] },
    overrides: { getLatestCloudTableSnapshot: reader.getLatestCloudTableSnapshot } })
  try {
    await app.drainCaptureOutbox()
    assert.equal(calls.complete.length, 1, app.state.snapshot().status.persistenceError)
    assert.equal(calls.fail.length, 0)
    assert.equal(calls.issue.length, 5)
    assert.equal(calls.publish.some(p => p.tableId === 'BAV06'), false)
    assert.equal(app.state.snapshot().tables.at(-1).availability, 'catalog_unavailable')
    assert.equal(app.state.snapshot().tables.at(-1).round, null)
  } finally { await app.stop() }
})

test('legacy unavailable recognition requires the entire exact projection at DB and claimed-work boundaries', async t => {
  const mutations = {
    room: table => { table.roomId = '48' }, type: table => { table.tableType = 'BAS' },
    name: table => { table.displayName = 'unknown' }, road: table => { table.bigRoadRaw = 'BP' },
    missingEmptyField: table => { delete table.nextPlayerRaw },
    count: table => { table.bankerCount = 1 }, fresh: table => { table.sourceUpdatedAt = new Date().toISOString() },
    prediction: table => { table.prediction = {} }, unknownField: table => { table.unknown = true },
    incompleteTyped: table => { table.availability = 'catalog_unavailable'; delete table.beadPlateRaw },
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const legacy = normalizeMtTable(missingWire(), 5); mutate(legacy)
    const tables = [...parse(six()).slice(0, 5), legacy]
    const snapshot = { snapshot_at: new Date().toISOString(), tables }
    const reader = createSupabaseIngestionClient({ url: 'https://example.invalid', serviceKey: 'fixture-only',
      fetchImpl: async () => ({ ok: true, json: async () => [snapshot] }) })
    const preclaim = harness({ overrides: { getLatestCloudTableSnapshot: reader.getLatestCloudTableSnapshot } })
    try { await assert.rejects(preclaim.app.drainCaptureOutbox()); assert.equal(preclaim.calls.claims.length, 0) }
    finally { await preclaim.app.stop() }
    const claimed = harness({ work: { status: {}, tables, rounds: [final()] } })
    try {
      await claimed.app.drainCaptureOutbox()
      assert.equal(claimed.calls.complete.length, 0)
      assert.equal(claimed.calls.fail.length, 1)
    } finally { await claimed.app.stop() }
  })
})
