import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const table = {
  tableId: 'BAG01', shoe: 88, round: 20,
  bankerCount: 10, playerCount: 9, tieCount: 1,
  bankerPairCount: 2, playerPairCount: 1,
  beadPlateRaw: '0102', bigRoadRaw: '0102', bigEyeRaw: '12', smallRoadRaw: '21', cockroachRaw: '11',
  nextBankerRaw: '1', nextPlayerRaw: '2',
  sourceUpdatedAt: new Date().toISOString(),
}

const sseBuffers = new WeakMap()

async function readSseEvent(reader, timeoutMs = 4500) {
  const decoder = new TextDecoder()
  let text = sseBuffers.get(reader) ?? ''
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timed out waiting for SSE event')), timeoutMs)
  })
  while (!text.includes('\n\n')) {
    const result = await Promise.race([reader.read(), timeout])
    if (result.done) return { event: 'closed', data: null }
    text += decoder.decode(result.value, { stream: true }).split(String.fromCharCode(13, 10)).join('\n')
  }
  clearTimeout(timeoutId)
  const boundary = text.indexOf('\n\n')
  const block = text.slice(0, boundary)
  sseBuffers.set(reader, text.slice(boundary + 2))
  const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
  return { event, data: data ? JSON.parse(data) : null }
}

async function readSseEventUntil(reader, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const event = await readSseEvent(reader, Math.max(1, deadline - Date.now()))
    if (predicate(event)) return event
    if (event.event !== 'heartbeat') throw new Error(`unexpected SSE event while waiting for tables: ${event.event}`)
  }
  throw new Error('timed out waiting for matching SSE event')
}

function issued(candidate) {
  return {
    ...candidate,
    predictionId: `prediction-${candidate.targetTableId}-${candidate.targetRound}`,
    issuedAt: new Date().toISOString(),
  }
}

test('late external durable issuance is pushed by bounded SSE refresh without frontend polling', async () => {
  const exact = issued(buildLivePrediction({ ...table, round: 19 }))
  let durable = false
  let reads = 0
  const supabaseClient = {
    configured: true,
    readIssuedPrediction: async () => {
      reads += 1
      return durable ? exact : null
    },
    issuePrediction: async () => { assert.fail('consumer-disabled proxy must stay read-only') },
  }
  const app = createApp({
    autoConnect: false,
    port: 0,
    captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 50,
    streamHeartbeatMs: 5000,
    supabaseClient,
  })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    const initial = await readSseEvent(reader)
    assert.equal(initial.event, 'tables')
    assert.equal(initial.data.tables[0].prediction, null)
    durable = true
    const refreshed = await readSseEventUntil(reader, (event) => event.event === 'tables' && event.data.tables[0].prediction?.predictionId === exact.predictionId, 3500)
    assert.equal(refreshed.data.tables[0].prediction.targetRound, table.round)
    assert.ok(reads >= 2)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('ten missing identities share one bounded refresh broadcast per retry window', async () => {
  let reads = 0
  const tableIds = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
  const tables = tableIds.map((tableId) => ({ ...table, tableId }))
  const supabaseClient = {
    configured: true,
    readIssuedPrediction: async () => {
      reads += 1
      return null
    },
    issuePrediction: async () => { assert.fail('consumer-disabled proxy must stay read-only') },
  }
  const app = createApp({
    autoConnect: false,
    port: 0,
    captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 50,
    streamHeartbeatMs: 5000,
    supabaseClient,
  })
  app.state.setTables(tables)
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    let tablesEvents = 0
    const deadline = Date.now() + 6500
    while (Date.now() < deadline) {
      try {
        const event = await readSseEvent(reader, Math.max(1, deadline - Date.now()))
        if (event.event === 'tables') tablesEvents += 1
      } catch {
        break
      }
    }
    assert.ok(tablesEvents >= 2, `expected at least one refresh event, received ${tablesEvents}; reads=${reads}`)
    assert.ok(tablesEvents <= 4, `expected at most one full tables event per retry window, received ${tablesEvents}`)
    assert.ok(reads <= 60, `expected bounded coalesced exact reads, received ${reads}`)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('prediction readiness does not broadcast before durable issuance completes', async () => {
  let releaseRound22
  let round22Candidate
  const round22Issuance = new Promise((resolve) => { releaseRound22 = resolve })
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    reconcilePredictionLifecycle: async () => {},
    issuePrediction: async (candidate) => {
      if (candidate.targetRound !== 22) return issued(candidate)
      round22Candidate = candidate
      return round22Issuance
    },
  }
  const app = createApp({ autoConnect: false, port: 0, requireVerifiedStrategy: true, supabaseClient })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    await readSseEvent(reader)
    await new Promise((resolve) => setTimeout(resolve, 50))
    app.state.setTables([{ ...table, round: 21, bigRoadRaw: '0102#0202', sourceUpdatedAt: new Date(Date.now() + 1).toISOString() }])
    const timerEvent = readSseEvent(reader, 4500)
    const early = await Promise.race([
      timerEvent.then(() => 'event'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 200)),
    ])
    assert.equal(early, 'waiting')

    const timerPayload = await timerEvent
    assert.equal(timerPayload.event, 'tables')
    assert.equal(timerPayload.data.tables[0].round, 21)

    const readinessEvent = readSseEvent(reader, 1500)
    releaseRound22(issued(round22Candidate))
    const advanced = await readinessEvent
    assert.equal(advanced.event, 'tables')
    assert.equal(advanced.data.tables[0].round, 21)
    assert.equal(advanced.data.tables[0].prediction.targetRound, 21)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('failed durable prediction issuance does not trigger an immediate tables broadcast', async () => {
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    reconcilePredictionLifecycle: async () => {},
    issuePrediction: async (candidate) => candidate.targetRound === 22 ? null : issued(candidate),
  }
  const app = createApp({ autoConnect: false, port: 0, requireVerifiedStrategy: true, supabaseClient })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    await readSseEvent(reader)
    await new Promise((resolve) => setTimeout(resolve, 50))
    app.state.setTables([{ ...table, round: 21, bigRoadRaw: '0102#0202', sourceUpdatedAt: new Date(Date.now() + 1).toISOString() }])
    const pendingEvent = readSseEvent(reader, 1500).then(() => 'event').catch(() => 'closed')
    const result = await Promise.race([
      pendingEvent,
      new Promise((resolve) => setTimeout(() => resolve('quiet'), 350)),
    ])
    assert.equal(result, 'quiet')
    controller.abort()
    await pendingEvent
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('database reconciliation failure suppresses immediate broadcast even when durable issuance succeeds', async () => {
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    reconcilePredictionLifecycle: async () => { throw new Error('database final reconciliation failed') },
    issuePrediction: async (candidate) => issued(candidate),
  }
  const app = createApp({ autoConnect: false, port: 0, requireVerifiedStrategy: true, supabaseClient })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    await readSseEvent(reader)
    await new Promise((resolve) => setTimeout(resolve, 50))
    app.state.setTables([{ ...table, round: 21, bigRoadRaw: '0102#0202', sourceUpdatedAt: new Date(Date.now() + 1).toISOString() }])
    const pendingEvent = readSseEvent(reader, 1500).then(() => 'event').catch(() => 'closed')
    const result = await Promise.race([
      pendingEvent,
      new Promise((resolve) => setTimeout(() => resolve('quiet'), 350)),
    ])
    assert.equal(result, 'quiet')
    controller.abort()
    await pendingEvent
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('simultaneous table prediction readiness keeps immediate broadcasts single-flight', async () => {
  let activeAuthorizations = 0
  let maxActiveAuthorizations = 0
  let measureAuthorizations = false
  const licenseAdminClient = {
    validateMemberLogin: async ({ memberAccount } = {}) => ({ ok: true, memberAccount: memberAccount ?? 'Member001', license: { id: 'license-1', status: 'active' } }),
    validateMemberSession: async () => {
      if (!measureAuthorizations) return { ok: true }
      activeAuthorizations += 1
      maxActiveAuthorizations = Math.max(maxActiveAuthorizations, activeAuthorizations)
      await new Promise((resolve) => setTimeout(resolve, 100))
      activeAuthorizations -= 1
      return { ok: true }
    },
  }
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    reconcilePredictionLifecycle: async () => {},
    issuePrediction: async (candidate) => issued(candidate),
  }
  const app = createApp({ autoConnect: false, port: 0, requireVerifiedStrategy: true, memberAuthRequired: true, licenseAdminClient, supabaseClient })
  const tableB = { ...table, tableId: 'BAG02' }
  app.state.setTables([table, tableB])
  await app.start()
  const login = JSON.parse((await app.inject({ method: 'POST', url: '/api/online-license/member-login', body: JSON.stringify({ memberAccount: 'Member001', verificationPassword: 'VERIFY001' }) })).body)
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, {
    headers: { authorization: `Bearer ${login.memberSessionToken}` },
    signal: controller.signal,
  })).body.getReader()

  try {
    await readSseEvent(reader)
    await new Promise((resolve) => setTimeout(resolve, 50))
    measureAuthorizations = true
    app.state.setTables([
      { ...table, round: 21, sourceUpdatedAt: new Date(Date.now() + 1).toISOString() },
      { ...tableB, round: 21, sourceUpdatedAt: new Date(Date.now() + 1).toISOString() },
    ])
    await readSseEvent(reader, 1500)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(maxActiveAuthorizations, 1)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('duplicate same-screen updates wait for the heartbeat instead of triggering immediate SSE', async () => {
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    reconcilePredictionLifecycle: async () => {},
    issuePrediction: async (candidate) => issued(candidate),
  }
  const app = createApp({ autoConnect: false, port: 0, requireVerifiedStrategy: true, supabaseClient })
  app.state.setTables([table])
  await app.start()
  await app.waitForServiceWorkIdle()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    await readSseEvent(reader)
    await new Promise((resolve) => setTimeout(resolve, 50))
    app.state.setTables([{ ...table }])
    const pendingEvent = readSseEvent(reader, 1500).then(() => 'event').catch(() => 'closed')
    const result = await Promise.race([
      pendingEvent,
      new Promise((resolve) => setTimeout(() => resolve('quiet'), 350)),
    ])
    assert.equal(result, 'quiet')
    controller.abort()
    await pendingEvent
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('fast durable prediction read-back stays inside the current full broadcast', async () => {
  const issuedAt = new Date().toISOString()
  const exact = {
    ...buildLivePrediction({ ...table, round: 19 }),
    predictionId: 'fast-read-back-20',
    issuedAt,
  }
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    issuePrediction: async () => null,
    readIssuedPrediction: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return exact
    },
  }
  const app = createApp({ autoConnect: false, port: 0, streamHeartbeatMs: 40, requireVerifiedStrategy: true, supabaseClient })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    const initial = await readSseEvent(reader)
    assert.equal(initial.event, 'tables')
    assert.equal(initial.data.tables[0].prediction.predictionId, 'fast-read-back-20')
    const next = await readSseEvent(reader, 500)
    assert.equal(next.event, 'heartbeat')
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('bounded durable prediction read-back stays inside the initial full tables broadcast', async () => {
  const issuedAt = new Date().toISOString()
  const exact = {
    ...buildLivePrediction({ ...table, round: 19 }),
    predictionId: 'slow-read-back-20',
    issuedAt,
  }
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    issuePrediction: async () => null,
    readIssuedPrediction: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return exact
    },
  }
  const app = createApp({ autoConnect: false, port: 0, streamHeartbeatMs: 40, requireVerifiedStrategy: true, supabaseClient })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    const initial = await readSseEvent(reader)
    assert.equal(initial.event, 'tables')
    assert.equal(initial.data.tables[0].prediction.predictionId, 'slow-read-back-20')
    const next = await readSseEvent(reader, 500)
    assert.equal(next.event, 'heartbeat')
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('heartbeat does not rebuild the complete durable tables payload when no table changed', async () => {
  let durableReads = 0
  const supabaseClient = {
    configured: true,
    getLatestCloudTableSnapshot: async () => {
      durableReads += 1
      return { tables: [], snapshot_at: new Date().toISOString() }
    },
  }
  const app = createApp({ autoConnect: false, port: 0, streamHeartbeatMs: 40, supabaseClient })
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    const initial = await readSseEvent(reader)
    assert.equal(initial.event, 'tables')
    const heartbeat = await readSseEvent(reader, 500)
    assert.equal(heartbeat.event, 'heartbeat')
    assert.equal(durableReads, 1)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('repeated unchanged empty tables use heartbeat without another durable rebuild', async () => {
  let durableReads = 0
  const supabaseClient = {
    configured: true,
    getLatestCloudTableSnapshot: async () => {
      durableReads += 1
      return { tables: [], snapshot_at: new Date().toISOString() }
    },
  }
  const app = createApp({ autoConnect: false, port: 0, streamHeartbeatMs: 40, supabaseClient })
  app.state.setTables([table])
  await app.start()
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })).body.getReader()

  try {
    assert.equal((await readSseEvent(reader)).event, 'tables')
    app.state.setTables([])
    assert.equal((await readSseEvent(reader, 500)).event, 'tables')
    assert.equal(durableReads, 1)
    app.state.setTables([])
    assert.equal((await readSseEvent(reader, 500)).event, 'heartbeat')
    assert.equal(durableReads, 1)
  } finally {
    controller.abort()
    await app.stop()
  }
})

test('heartbeat and initial stream broadcasts share the global single-flight coordinator', async () => {
  let activeReads = 0
  let maxActiveReads = 0
  let released = false
  const waiting = []
  const emptySnapshot = { tables: [], snapshot_at: new Date().toISOString() }
  const supabaseClient = {
    configured: true,
    getLatestCloudTableSnapshot: async () => {
      if (released) return emptySnapshot
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      return new Promise((resolve) => waiting.push(() => {
        activeReads -= 1
        resolve(emptySnapshot)
      }))
    },
  }
  const app = createApp({ autoConnect: false, port: 0, supabaseClient })
  await app.start()
  const controller = new AbortController()
  const responsePromise = fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal }).catch(() => null)

  try {
    while (waiting.length < 1) await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 3200))
    assert.equal(maxActiveReads, 1)
  } finally {
    released = true
    for (const release of waiting.splice(0)) release()
    await responsePromise
    controller.abort()
    await app.stop()
  }
})

test('shutdown bounds an in-flight immediate broadcast authorization check', async () => {
  let holdAuthorization = false
  let authorizationStarted = false
  let releaseAuthorization
  const authorizationGate = new Promise((resolve) => { releaseAuthorization = resolve })
  const licenseAdminClient = {
    validateMemberLogin: async ({ memberAccount } = {}) => ({ ok: true, memberAccount: memberAccount ?? 'Member001', license: { id: 'license-1', status: 'active' } }),
    validateMemberSession: async () => {
      if (!holdAuthorization) return { ok: true }
      authorizationStarted = true
      return authorizationGate
    },
  }
  const supabaseClient = {
    configured: true,
    getRuntimeStatus: () => ({ ready: true, degraded: false, reason: null, activeStrategyVersion: 'v105' }),
    getV105FormalHistory: async () => [],
    reconcilePredictionLifecycle: async () => {},
    issuePrediction: async (candidate) => issued(candidate),
  }
  const app = createApp({
    autoConnect: false,
    port: 0,
    requireVerifiedStrategy: true,
    memberAuthRequired: true,
    serviceShutdownDeadlineMs: 50,
    licenseAdminClient,
    supabaseClient,
  })
  app.state.setTables([table])
  await app.start()
  await app.waitForServiceWorkIdle()
  const login = JSON.parse((await app.inject({ method: 'POST', url: '/api/online-license/member-login', body: JSON.stringify({ memberAccount: 'Member001', verificationPassword: 'VERIFY001' }) })).body)
  const controller = new AbortController()
  const reader = (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, {
    headers: { authorization: `Bearer ${login.memberSessionToken}` },
    signal: controller.signal,
  })).body.getReader()
  await readSseEvent(reader)
  holdAuthorization = true
  app.state.setTables([{ ...table, round: 21, sourceUpdatedAt: new Date(Date.now() + 1).toISOString() }])
  while (!authorizationStarted) await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort()

  const stopping = app.stop()
  const outcome = await Promise.race([
    stopping.then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 250)),
  ])
  try {
    assert.equal(outcome, 'stopped')
  } finally {
    releaseAuthorization({ ok: true })
    await stopping
  }
})

test('slow periodic table broadcast does not queue an immediate duplicate refresh', async () => {
  let snapshotReads = 0
  let releaseFirstRead
  const firstReadGate = new Promise((resolve) => { releaseFirstRead = resolve })
  const supabaseClient = {
    configured: true,
    async getLatestCloudTableSnapshot() {
      snapshotReads += 1
      if (snapshotReads === 1) await firstReadGate
      return null
    },
  }
  const app = createApp({
    autoConnect: false,
    port: 0,
    requireVerifiedStrategy: false,
    memberAuthRequired: false,
    streamHeartbeatMs: 50,
    supabaseClient,
  })
  await app.start()
  const controller = new AbortController()
  const stream = fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, {
    signal: controller.signal,
  }).catch(() => null)

  try {
    while (snapshotReads < 1) await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 120))
    releaseFirstRead()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(snapshotReads, 1, 'timer ticks during a slow broadcast must be dropped instead of replayed immediately')
  } finally {
    controller.abort()
    releaseFirstRead()
    await stream
    await app.stop()
  }
})
