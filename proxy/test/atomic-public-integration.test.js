import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from '../src/server.js'

const ids = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']
const keys = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']
const pid = '11111111-1111-4111-8111-111111111111'
const headers = { 'x-forwarded-proto': 'https' }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('condition timeout'); await delay(5) }
}
function bundles(round = 7, state = 'ready') {
  const at = new Date(Date.now() - 10).toISOString()
  return ids.map(tableId => ({
    table: { tableId, shoe: '88', round, roundBasis: 'completed', sourceUpdatedAt: at, displayName: tableId, bigRoadRaw: 'BPBPBPB', beadRoad: [{ winner: 'banker' }], counts: { banker: 4, player: 3 }, customRoad: { untouched: [1, 2, 3] } },
    prediction: state === 'ready' ? { buildVersion: 'v105', strategyVersion: 'v105', predictionId: pid, issuedAt: at, targetTableId: tableId, targetShoe: '88', targetRound: round + 1, predictedResult: 'banker', confidence: 65, predictionTiming: 'pre_result_context', sidePredictions: Object.fromEntries(keys.map(k => [k, 10])), sideActions: Object.fromEntries(keys.map(k => [k, false])) } : null,
    publication: { state, observation: { epoch: 'a'.repeat(64), snapshot: '30:30:' }, observedAtMicros: '1790000000000001', revision: state === 'ready' ? round : null, publishedAt: state === 'ready' ? at : null, sourceCapturedAt: at, rawIdentity: { tableId, shoe: '88', round: round + 1 }, readyIdentity: state === 'ready' ? { tableId, shoe: '88', round: round + 1, predictionId: pid } : null },
  }))
}
function harness(options = {}) {
  const calls = { reads: 0, raw: 0, exact: 0, writes: 0 }
  const data = { rows: bundles(), load: null }
  const forbidden = () => { calls.writes++; throw new Error('public must not write') }
  const app = createApp({ autoConnect: false, port: 0, production: true, requireVerifiedStrategy: false, memberAuthRequired: false, captureOutboxConsumerEnabled: false, captureRoundBasis: 'completed', liveAtomicPublicationsEnabled: true, livePredictionReadWaitMs: 80, streamHeartbeatMs: 30, controlToken: 'integration-only-control',
    supabaseClient: { configured: true, async readV105TablePublications() { calls.reads++; return data.load ? data.load() : structuredClone(data.rows) }, async getLatestCloudTableSnapshot() { calls.raw++; return null }, async readIssuedPrediction() { calls.exact++; return null }, issuePrediction: forbidden, publishV105TablePublication: forbidden, reconcilePredictionLifecycle: forbidden },
    v104FormalRuntime: { buildPrediction: forbidden, snapshot() { return { status: 'ready' } } }, ...options })
  return { app, calls, data }
}
const get = (app, url = '/api/tables') => app.inject({ url, headers })
const hint = (app, extra = {}) => app.inject({ method: 'POST', url: '/internal/publication-ready', headers: { ...headers, 'x-control-token': 'integration-only-control' }, body: '{}', ...extra })

async function stream(app) {
  await app.start()
  const events = []
  let buffer = ''
  const req = http.get({ hostname: '127.0.0.1', port: app.server.address().port, path: '/api/tables/stream', headers }, res => {
    res.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const type = /^event: (.+)$/m.exec(frame)?.[1]
        const payload = /^data: (.+)$/m.exec(frame)?.[1]
        if (type && payload) events.push({ type, payload: JSON.parse(payload) })
      }
    })
  })
  req.on('error', () => {})
  return { events, close() { req.destroy() } }
}

test('pending HTTP read wakes on authenticated hint, while a timeout retains inventory without any unready screen', async () => {
  const { app, data, calls } = harness()
  try {
    data.rows = bundles(8, 'pending')
    const pending = get(app)
    await until(() => calls.reads === 1)
    data.rows = bundles(8)
    assert.equal((await hint(app)).statusCode, 202)
    assert.equal(JSON.parse((await pending).body)[0].prediction.targetRound, 9)
    assert.equal(calls.reads, 2)
    data.rows = bundles(9, 'pending')
    await hint(app)
    const result = JSON.parse((await get(app)).body)
    assert.equal(result.length, 6)
    assert.ok(result.every(table => table.round === undefined && table.prediction === undefined && table.screenUnavailable === true && table.publication.state === 'unavailable'))
    assert.equal(calls.raw + calls.exact + calls.writes, 0)
  } finally { await app.stop() }
})

test('HTTP pending-to-ready with lost commit hint returns exact ready before publishing the new round', async () => {
  const { app, data, calls } = harness()
  try {
    data.rows = bundles(8, 'pending')
    const response = get(app)
    await until(() => calls.reads === 1)
    data.rows = bundles(8)
    const tables = JSON.parse((await response).body)
    assert.ok(tables.every(table => table.round === 9 && table.prediction?.targetRound === 9))
    assert.equal(calls.reads, 2)
    assert.equal(calls.raw + calls.exact + calls.writes, 0)
  } finally { await app.stop() }
})

test('real SSE pending-to-ready with lost hint never emits the intermediate new-round null', async () => {
  const { app, data, calls } = harness()
  data.rows = bundles(8, 'pending')
  const socket = await stream(app)
  try {
    await until(() => calls.reads >= 1)
    data.rows = bundles(8)
    await until(() => socket.events.some(event => event.type === 'tables'))
    const frames = socket.events.filter(event => event.type === 'tables')
    assert.ok(frames.every(event => event.payload.tables.length === 6 && event.payload.tables.every(table => table.round === 9 && table.prediction?.targetRound === 9)))
    assert.equal(calls.raw + calls.exact + calls.writes, 0)
  } finally { socket.close(); await app.stop() }
})

test('pending table exposes only a revocation marker while five ready tables continue on HTTP and SSE', async () => {
  const { app, data, calls } = harness()
  data.rows[0] = bundles(8, 'pending')[0]
  const check = tables => {
    assert.deepEqual(tables.map(row => row.tableId), ids)
    const missing = tables[0]
    assert.equal(missing.screenUnavailable, true)
    assert.equal(missing.publication.state, 'unavailable')
    assert.equal(missing.publication.readyIdentity, null)
    assert.deepEqual(Object.keys(missing).sort(), ['tableId', 'displayName', 'buildVersion', 'sourceUpdatedAt', 'screenUnavailable', 'publication'].sort())
    for (const row of tables.slice(1)) {
      assert.equal(row.round, 8)
      assert.equal(row.prediction.targetRound, 8)
      assert.equal(row.publication.state, 'ready')
    }
  }
  let socket
  try {
    for (const url of ['/api/tables', '/api/snapshot']) {
      const response = await get(app, url)
      assert.equal(response.statusCode, 200)
      const body = JSON.parse(response.body)
      check(Array.isArray(body) ? body : body.tables)
    }
    socket = await stream(app)
    await until(() => socket.events.some(e => e.type === 'tables'))
    check(socket.events.find(e => e.type === 'tables').payload.tables)
    data.rows = bundles(8)
    await hint(app)
    await until(() => socket.events.some(e => e.type === 'tables' && e.payload.tables[0].prediction?.targetRound === 9))
    assert.equal(calls.raw + calls.exact + calls.writes, 0)
  } finally { socket?.close(); await app.stop() }
})

test('hint requires configured control token even outside production, HTTPS and empty wake-only body', async () => {
  const { app, calls } = harness()
  try {
    assert.equal((await hint(app, { headers: {} })).statusCode, 426)
    assert.equal((await hint(app, { headers })).statusCode, 401)
    assert.equal((await hint(app, { headers: { ...headers, 'x-control-token': 'wrong' } })).statusCode, 401)
    assert.equal((await hint(app, { body: JSON.stringify({ prediction: { predictionId: pid } }) })).statusCode, 400)
    assert.equal((await hint(app, { body: 'bad json' })).statusCode, 400)
    assert.equal((await hint(app, { method: 'GET' })).statusCode, 405)
    assert.equal((await hint(app)).statusCode, 202)
    assert.equal(calls.reads + calls.writes, 0)
  } finally { await app.stop() }
  const missing = harness({ production: false, controlToken: '' })
  try { assert.equal((await hint(missing.app)).statusCode, 503) } finally { await missing.app.stop() }
  const member = harness({ memberAuthRequired: true })
  try { assert.equal((await get(member.app)).statusCode, 401); assert.equal(member.calls.reads, 0) } finally { await member.app.stop() }
})

test('real SSE reads atomic initial, hint-ready and lost-hint heartbeat recovery without per-table reads', async () => {
  const { app, data, calls } = harness()
  const socket = await stream(app)
  try {
    await until(() => socket.events.some(e => e.type === 'tables'))
    assert.equal(socket.events.find(e => e.type === 'tables').payload.tables.length, 6)
    data.rows = bundles(8, 'pending')
    await hint(app)
    await until(() => calls.reads >= 2)
    data.rows = bundles(8)
    await hint(app)
    await until(() => socket.events.some(e => e.type === 'tables' && e.payload.tables[0].prediction?.targetRound === 9))
    assert.ok(socket.events.some(e => e.type === 'round-ready'))
    assert.ok(!socket.events.some(e => e.type === 'tables' && e.payload.tables[0].round === 9 && !e.payload.tables[0].prediction))
    data.rows = bundles(9) // Deliberately lose the postcommit hint.
    await until(() => socket.events.some(e => e.type === 'tables' && e.payload.tables[0].prediction?.targetRound === 10))
    assert.equal(calls.raw + calls.exact + calls.writes, 0)
  } finally { socket.close(); await app.stop() }
})

test('stop cancels pending public read and late database completion cannot restart IO or hints', async () => {
  const { app, data, calls } = harness()
  let release
  data.load = () => new Promise(resolve => { release = resolve })
  const pending = get(app)
  await until(() => release)
  await app.stop()
  assert.equal((await pending).statusCode, 503)
  release(bundles())
  assert.equal((await hint(app)).statusCode, 503)
  assert.equal((await get(app)).statusCode, 503)
  await delay(120)
  assert.equal(calls.reads, 1)
  assert.equal(calls.raw + calls.exact + calls.writes, 0)
})

test('atomic projection rejects invalid metadata, expired or wrong identity and incomplete immutable side actions', async t => {
  const mutations = {
    missingMetadata: row => { delete row.publication },
    invalidRevision: row => { row.publication.revision = 0 },
    wrongRaw: row => { row.publication.rawIdentity.round++ },
    wrongReady: row => { row.publication.readyIdentity.predictionId = 'other' },
    wrongPrediction: row => { row.prediction.targetRound++ },
    wrongStrategy: row => { row.prediction.strategyVersion = 'v104' },
    missingId: row => { delete row.prediction.predictionId },
    missingMain: row => { delete row.prediction.predictedResult },
    invalidMain: row => { row.prediction.predictedResult = 'tie' },
    missingTiming: row => { delete row.prediction.predictionTiming },
    postResult: row => { row.prediction.predictionTiming = 'post_result' },
    invalidIssuedAt: row => { row.prediction.issuedAt = 'invalid' },
    expiredIssuedAt: row => { row.prediction.issuedAt = new Date(Date.now() - 121000).toISOString(); row.prediction.createdAtMs = Date.now() },
    futureIssuedAt: row => { row.prediction.issuedAt = new Date(Date.now() + 60000).toISOString() },
    expiredSource: row => { row.publication.sourceCapturedAt = row.table.sourceUpdatedAt = new Date(Date.now() - 121000).toISOString() },
    futureSource: row => { row.publication.sourceCapturedAt = new Date(Date.now() + 60000).toISOString() },
    mismatchedSource: row => { row.publication.sourceCapturedAt = new Date(Date.now() - 2000).toISOString() },
    missingPublishedAt: row => { delete row.publication.publishedAt },
    missingSide: row => { delete row.prediction.sideActions.tie },
    pendingWithOldPrediction: row => { row.publication.state = 'pending' },
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const { app, data, calls } = harness()
    mutate(data.rows[0])
    try {
      const result = await get(app)
      assert.equal(result.statusCode, 200)
      const tables = JSON.parse(result.body)
      assert.equal(tables.length, 6)
      assert.equal(tables[0].round, undefined)
      assert.equal(tables[0].prediction, undefined)
      assert.equal(tables[0].screenUnavailable, true)
      if (name !== 'missingMetadata') assert.equal(tables[0].publication.observedAtMicros, '1790000000000001')
      assert.notEqual(tables[0].publication.state, 'ready')
      assert.equal(tables[1].prediction.targetRound, 8)
      assert.equal(calls.writes + calls.raw + calls.exact, 0)
    } finally { await app.stop() }
  })
})

test('unknown or hung atomic reads return bounded 503 without raw fallback', async t => {
  for (const kind of ['reject', 'hung', 'malformed', 'duplicate', 'empty', 'partial']) await t.test(kind, async () => {
    const { app, data, calls } = harness()
    data.load = () => {
      if (kind === 'reject') throw new Error('database unknown')
      if (kind === 'hung') return new Promise(() => {})
      if (kind === 'duplicate') return [data.rows[0], data.rows[0]]
      if (kind === 'empty') return []
      if (kind === 'partial') return [data.rows[0]]
      return null
    }
    try {
      for (const url of ['/api/tables', '/api/snapshot', '/api/status']) {
        const result = await get(app, url)
        assert.equal(result.statusCode, 503)
      }
      assert.equal(calls.raw + calls.exact + calls.writes, 0)
      if (kind === 'hung') assert.equal(calls.reads, 1)
    } finally { await app.stop() }
  })
})

test('atomic HTTP reads all six full screens and exact immutable predictions from one snapshot, zero writes', async () => {
  const { app, calls, data } = harness()
  try {
    app.state.setTables([{ ...data.rows[0].table, round: 99 }])
    const response = await get(app)
    assert.equal(response.statusCode, 200)
    const tables = JSON.parse(response.body)
    assert.equal(tables.length, 6)
    for (const [i, table] of tables.entries()) {
      assert.equal(table.round, 8)
      assert.equal(table.roundBasis, 'visible')
      assert.deepEqual(table.customRoad, data.rows[i].table.customRoad)
      assert.deepEqual(table.counts, data.rows[i].table.counts)
      assert.deepEqual(table.beadRoad, data.rows[i].table.beadRoad)
      assert.deepEqual(table.prediction, data.rows[i].prediction)
      assert.deepEqual(table.publication, data.rows[i].publication)
      assert.equal(table.buildVersion, 'v105')
    }
    assert.deepEqual(calls, { reads: 1, raw: 0, exact: 0, writes: 0 })
    assert.equal(JSON.parse((await get(app, '/api/snapshot')).body).tables.length, 6)
    const status = await get(app, '/api/status')
    assert.equal(status.statusCode, 200)
    assert.equal(JSON.parse(status.body).tableCount, 6)
    assert.equal(calls.raw, 0)
    assert.equal(calls.exact, 0)
    assert.equal(calls.writes, 0)
  } finally { await app.stop() }
})
