import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PRODUCTION_TABLE_IDS } from '../src/table-policy.js'
import { createMtApiClient } from '../src/mt-api-client.js'

test('API owner authenticates Game and Chat then performs one exact ten-table join', async () => {
  const harness = createHarness()
  const client = createMtApiClient(harness.options)
  await client.start()
  assert.equal(harness.sockets.length, 2)

  harness.openAll()
  assert.deepEqual(harness.sentActions('game'), ['/api/v1/authenticate'])
  assert.deepEqual(harness.sentActions('chat'), ['/api/v1/chat/authenticate'])

  harness.receive('game', { action: '/api/v1/authenticate', err: 0 })
  await harness.flush()
  assert.equal(harness.sentActions('game').includes('/api/v1/gametype/*/game/*/room/*/mulitple_join'), false)
  harness.receive('chat', { action: '/api/v1/chat/authenticate', err: 0 })
  await harness.flush(2)

  const join = harness.packet('game', '/api/v1/gametype/*/game/*/room/*/mulitple_join')
  assert.equal(join.action.data.table_id, PRODUCTION_TABLE_IDS.join(','))
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/mulitple_join')).length, 1)
  assert.equal(harness.sentActions('chat').includes('/api/v1/chat/room/*/table/*/join'), true)
})

test('live MT sockets send the browser Origin and User-Agent required by the gateway', async () => {
  const harness = createHarness()
  const client = createMtApiClient(harness.options)
  await client.start()
  assert.equal(harness.socketAt(0).options.headers.Origin, 'https://gsa.ofalive99.net')
  assert.match(harness.socketAt(0).options.headers['User-Agent'], /^Mozilla\/5\.0 .+Chrome\/149 /)
  assert.deepEqual(harness.socketAt(1).options.headers, harness.socketAt(0).options.headers)
  client.stop()
})

test('heartbeat and later Finals use the renewed lease instead of the generation startup snapshot', async () => {
  let nowMs = 0
  const delivered = []
  let activeLease = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', status: 'active', expiresAt: 15_000 }
  const sourceOwner = {
    lease: () => structuredClone(activeLease),
    assertCurrent(candidate) {
      if (candidate.expiresAt <= nowMs) throw new Error('stale_source_fence')
      return true
    },
    async nextEventSource() {
      return { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence: 1 }
    },
  }
  const harness = createHarness({ sourceOwner, onFinal: async (event) => delivered.push(event) })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  await harness.flush(2)

  activeLease = { ...activeLease, expiresAt: 30_000 }
  nowMs = 20_000
  assert.doesNotThrow(() => harness.runInterval(0))
  harness.acknowledgeJoins()
  harness.receive('game', summaryPacket(8))
  await harness.flush(2)
  assert.equal(client.snapshot().joined, true)
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0].source, { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence: 1 })

  activeLease = { ...activeLease, epoch: 5, fence: 'fence-5', expiresAt: 40_000 }
  assert.throws(() => harness.runInterval(0), /stale_source_fence/)
  client.stop()
})

test('a Final allocation race cannot let an old socket generation adopt a new epoch or fence', async () => {
  const delivered = []
  const errors = []
  let activeLease = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', status: 'active', expiresAt: 30_000 }
  const sourceOwner = {
    lease: () => structuredClone(activeLease),
    assertCurrent: () => true,
    async nextEventSource() {
      activeLease = { ...activeLease, epoch: 5, fence: 'fence-5', expiresAt: 40_000 }
      return { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence: 1 }
    },
  }
  const harness = createHarness({
    sourceOwner,
    onFinal: async (event) => delivered.push(event),
    onError: (error) => errors.push(String(error)),
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.acknowledgeJoins()
  harness.receive('game', summaryPacket(8))
  await harness.flush(4)
  assert.deepEqual(delivered, [])
  assert.deepEqual(errors, ['stale_source_fence'])
  client.stop()
})

test('Reviewer P1 Join/Tables: Chat has no ACK, so exact Tables release only after the genuine Game join ACK', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const tables1 = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 91, round: 8 }))
  const providerTables1 = [
    ...tables1,
    ...['BAG11', 'BAG12', 'BAG13', 'BAG13A', 'BAG15', 'DTG01', 'DTG02', 'NUG01', 'SBG01']
      .map((table_id) => ({ table_id, shoe: 91, round: 8 })),
  ].reverse()
  const tables2 = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 92, round: 1 }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()

  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: providerTables1 } })
  harness.receiveGeneration(1, 'game', { action: '/api/v1/gametype/*/game/*/room/*/mulitple_join', err: 0 })
  await harness.flush()
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0], tables1)

  harness.socket('game').emit('close')
  await harness.flush()
  harness.openGeneration(2)
  harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
  harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
  harness.receiveGeneration(2, 'game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: tables2 } })
  harness.acknowledgeJoins(2)
  await harness.flush()
  assert.equal(delivered.length, 2)
  assert.deepEqual(delivered[1], tables2)
  client.stop()
})

test('Reviewer P1 summary-only: only summary with exact ten fields becomes Final; show_poker and show_win stay provisional', async () => {
  const events = []
  const harness = createHarness({ onFinal: async (event) => events.push(event) })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.acknowledgeJoins()

  const body = { table_id: 'BAG01', room_id: 29, shoe: 88, round: 9, result: '1,2,3,4,0,0,0,0,4,6' }
  harness.receive('game', { action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/show_poker' }, body })
  harness.receive('game', { action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/show_win' }, body })
  harness.receive('game', { action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/summary' }, body })
  await harness.flush()

  assert.equal(events.length, 1)
  assert.equal(events[0].sourceAction, 'summary')
  assert.deepEqual(events[0].rawResult, [1, 2, 3, 4, 0, 0, 0, 0, 4, 6])
  assert.deepEqual(events[0].source, { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence: 1 })
})

test('Reviewer P0 message serialization: round 9 cannot enter source allocation before gated round 8 journal and delivery complete', async () => {
  let releaseRound8
  const round8Gate = new Promise((resolve) => { releaseRound8 = resolve })
  const journal = []
  const delivered = []
  let sourceCalls = 0
  const harness = createHarness({
    nextEventSource: async () => {
      sourceCalls += 1
      const sequence = sourceCalls
      if (sequence === 1) await round8Gate
      journal.push(sequence)
      return { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence }
    },
    onFinal: async (event) => { delivered.push(event.round) },
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.acknowledgeJoins()

  harness.receive('game', summaryPacket(8))
  harness.receive('game', summaryPacket(9))
  await harness.flush()

  assert.equal(sourceCalls, 1, 'round 9 must remain behind the generation message chain while round 8 is gated')
  assert.deepEqual(journal, [])
  assert.deepEqual(delivered, [])

  releaseRound8()
  await harness.flush(4)
  assert.deepEqual(journal, [1, 2])
  assert.deepEqual(delivered, [8, 9])
  assert.equal(client.snapshot().joined, true)
  client.stop()
})

test('Reviewer P0 message serialization: one rejected Final reports onError, preserves the chain, and high volume has no unhandled rejection', async () => {
  const delivered = []
  const errors = []
  const unhandled = []
  const onUnhandled = (error) => { unhandled.push(String(error?.message ?? error)) }
  process.on('unhandledRejection', onUnhandled)
  const harness = createHarness({
    onError: (error) => { errors.push(error) },
    onFinal: async (event) => {
      if (event.round === 8) throw new Error('round-8-delivery-failed')
      delivered.push(event.round)
    },
  })
  const client = createMtApiClient(harness.options)
  try {
    await client.start()
    harness.openAll()
    harness.authenticateAll()
    harness.acknowledgeJoins()
    for (let round = 8; round < 58; round += 1) harness.receive('game', summaryPacket(round))
    await harness.flush(8)

    assert.deepEqual(errors, ['round-8-delivery-failed'])
    assert.deepEqual(unhandled, [])
    assert.equal(harness.sockets.length, 4, 'a rejected handler must fail closed into one fresh generation')
    harness.openGeneration(2)
    harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
    harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
    harness.acknowledgeJoins(2)
    harness.receiveGeneration(2, 'game', summaryPacket(58))
    await harness.flush(4)
    assert.deepEqual(delivered, [58], 'the recovered generation chain must accept later messages')
    assert.equal(client.snapshot().joined, true)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    client.stop()
  }
})

test('summary and show_win stay blocked until both exact joins are acknowledged in every generation', async () => {
  const events = []
  const harness = createHarness({ onFinal: async (event) => events.push(event) })
  const client = createMtApiClient(harness.options)
  const body = { table_id: 'BAG01', room_id: 29, shoe: 88, round: 9, result: '1,2,3,4,0,0,0,0,4,6' }
  await client.start()
  harness.openAll()

  harness.receive('game', { action: '/api/v1/authenticate', err: 0 })
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/table/*/summary', body })
  harness.receive('chat', { action: '/api/v1/chat/authenticate', err: 0 })
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/table/*/show_win', body })
  await harness.flush()
  assert.equal(events.length, 0, 'sending join requests is not proof that either join completed')

  harness.acknowledgeJoins()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/table/*/summary', body })
  await harness.flush()
  assert.equal(events.length, 1)

  harness.socket('game').emit('close')
  await harness.flush()
  harness.openGeneration(2)
  harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
  harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
  harness.receiveGeneration(2, 'game', { action: '/api/v1/gametype/*/game/*/room/*/table/*/summary', body: { ...body, round: 10 } })
  await harness.flush()
  assert.equal(events.length, 1, 'a reconnect generation must earn both join acknowledgements again')

  harness.acknowledgeJoins(2)
  harness.receiveGeneration(2, 'game', { action: '/api/v1/gametype/*/game/*/room/*/table/*/summary', body: { ...body, round: 10 } })
  await harness.flush()
  assert.equal(events.length, 2)
  client.stop()
})

test('Reviewer P1 join ACK is bound to its socket: Game cannot acknowledge Chat and no Final is emitted', async () => {
  const events = []
  const harness = createHarness({ onFinal: async (event) => events.push(event) })
  const client = createMtApiClient(harness.options)
  const body = { table_id: 'BAG01', room_id: 29, shoe: 88, round: 9, result: '1,2,3,4,0,0,0,0,4,6' }
  await client.start()
  harness.openAll()
  harness.authenticateAll()

  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/mulitple_join', err: 0 })
  harness.receive('game', { action: '/api/v1/chat/room/*/table/*/join', err: 0 })
  harness.receiveGeneration(1, 'game', { action: '/api/v1/gametype/*/game/*/room/*/table/*/summary', body })
  await harness.flush()

  assert.equal(client.snapshot().joined, false)
  assert.equal(events.length, 0)
  client.stop()
})

test('Reviewer P1 join ACK accepts only the genuine Game plus Chat socket pair', async () => {
  const harness = createHarness()
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.acknowledgeJoins()
  await harness.flush(3)
  assert.equal(client.snapshot().joined, true)
  client.stop()
})

test('Reviewer P1 join request correlation rejects pre-auth, wrong-socket, and unsent-kind ACKs before accepting genuine per-kind requests', async () => {
  {
    const errors = []
    const harness = createHarness({ onError: (error) => { errors.push(error) } })
    const client = createMtApiClient(harness.options)
    await client.start()
    harness.openAll()
    harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/mulitple_join', err: 0 })
    await harness.flush(3)
    assert.equal(harness.sockets.length, 4, 'a same-socket pre-auth ACK must reconnect fail-closed')
    assert.deepEqual(errors, ['mt_join_ack_protocol_violation:game'])
    client.stop()
  }

  {
    const errors = []
    const harness = createHarness({ onError: (error) => { errors.push(error) } })
    const client = createMtApiClient(harness.options)
    await client.start()
    harness.openAll()
    harness.authenticateAll()
    harness.receive('game', { action: '/api/v1/chat/room/*/table/*/join', err: 0 })
    await harness.flush(3)
    assert.equal(harness.sockets.length, 4, 'an ACK on the wrong socket must reconnect fail-closed')
    assert.deepEqual(errors, ['mt_join_ack_protocol_violation:chat'])
    client.stop()
  }

  {
    const errors = []
    const harness = createHarness({ onError: (error) => { errors.push(error) } })
    const client = createMtApiClient(harness.options)
    await client.start()
    harness.openAll()
    harness.receive('game', { action: '/api/v1/authenticate', err: 0 })
    harness.socket('chat').readyState = 0
    harness.receive('chat', { action: '/api/v1/chat/authenticate', err: 0 })
    await harness.flush(2)
    assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/mulitple_join')).length, 1)
    assert.equal(harness.sentActions('chat').filter((action) => action.endsWith('/join')).length, 0)
    harness.receive('chat', { action: '/api/v1/chat/room/*/table/*/join', err: 0 })
    await harness.flush(3)
    assert.equal(harness.sockets.length, 4, 'an ACK without a successfully sent same-kind request must reconnect')
    assert.deepEqual(errors, ['mt_join_ack_protocol_violation:chat'])
    client.stop()
  }

  {
    const harness = createHarness()
    const client = createMtApiClient(harness.options)
    await client.start()
    harness.openAll()
    harness.authenticateAll()
    harness.acknowledgeJoins()
    await harness.flush(3)
    assert.equal(client.snapshot().joined, true)
    assert.equal(harness.sockets.length, 2)
    client.stop()
  }
})

test('health snapshot reports real dual-socket, auth, join, message, and reconnect state', async () => {
  let nowMs = 1_000
  const harness = createHarness({ now: () => nowMs })
  const client = createMtApiClient(harness.options)
  await client.start()
  assert.deepEqual(client.snapshot(), {
    generation: 1, connected: false, authenticated: false, joined: false,
    lastMessageAt: null, reconnecting: false, refreshing: false,
  })

  harness.openAll()
  assert.equal(client.snapshot().connected, true)
  nowMs = 2_000
  harness.authenticateAll()
  await harness.flush(2)
  assert.equal(client.snapshot().authenticated, true)
  assert.equal(client.snapshot().joined, false)
  assert.equal(client.snapshot().lastMessageAt, '1970-01-01T00:00:02.000Z')
  harness.acknowledgeJoins()
  await harness.flush(2)
  assert.equal(client.snapshot().joined, true)

  harness.socket('game').emit('close')
  assert.equal(client.snapshot().connected, false)
  assert.equal(client.snapshot().joined, false)
  client.stop()
})

test('disconnect reconnects both sockets and never joins until both new authentications complete', async () => {
  const harness = createHarness()
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  await harness.flush(2)
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/mulitple_join')).length, 1)

  harness.socket('game').emit('close')
  await harness.flush()
  assert.equal(harness.sockets.length, 4)
  harness.openGeneration(2)
  harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/mulitple_join')).length, 1)
  harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
  await harness.flush(2)
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/mulitple_join')).length, 2)
  client.stop()
})

test('Reviewer P1 reconnect failure retry survives the second token read failure and recovers on the third with fresh sockets', async () => {
  let tokenCalls = 0
  const errors = []
  const harness = createHarness({
    getSessionToken: async () => {
      tokenCalls += 1
      if (tokenCalls === 2) throw new Error('temporary-token-read-failure')
      return `opaque-session-${tokenCalls}`
    },
    onError: (error) => { errors.push(error) },
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  assert.equal(harness.sockets.length, 2)

  harness.openAll()
  harness.socket('game').emit('close')
  await harness.flush(8)

  assert.equal(tokenCalls, 3)
  assert.equal(harness.sockets.length, 4)
  assert.deepEqual(errors, ['temporary-token-read-failure'])
  harness.openGeneration(2)
  assert.deepEqual(harness.generationAuthTokens(2), ['opaque-session-3', 'opaque-session-3'])
  harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
  harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
  harness.acknowledgeJoins(2)
  await harness.flush(4)
  assert.equal(client.snapshot().generation, 2)
  assert.equal(client.snapshot().joined, true)
  client.stop()
})

test('Reviewer P1 reconnect failure retry is bounded, non-overlapping, degraded, and cancelled by stop', async () => {
  const clock = createManualTimers()
  let tokenCalls = 0
  const harness = createHarness({
    getSessionToken: async () => {
      tokenCalls += 1
      if (tokenCalls > 1) throw new Error('persistent-token-read-failure')
      return 'initial-session'
    },
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 40,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.socket('game').emit('close')
  assert.equal(clock.activeCount(), 1)

  for (const expectedDelay of [10, 20, 40]) {
    assert.equal(clock.nextDelay(), expectedDelay)
    await clock.runNext()
    await harness.flush(2)
    assert.equal(clock.activeCount(), 1, 'each failed attempt must leave exactly one retry timer')
  }
  assert.equal(tokenCalls, 4)
  assert.equal(harness.sockets.length, 2)
  assert.equal(client.snapshot().reconnecting, true)
  assert.equal(client.snapshot().joined, false)
  assert.equal(clock.nextDelay(), 40, 'backoff must stay capped')

  client.stop()
  assert.equal(clock.activeCount(), 0)
  assert.equal(client.snapshot().reconnecting, false)
  assert.equal(tokenCalls, 4)
})

test('Reviewer P1 reconnect failure retry closes a half-created socket before the next generation succeeds', async () => {
  let tokenCalls = 0
  const harness = createHarness({
    getSessionToken: async () => {
      tokenCalls += 1
      return `socket-retry-session-${tokenCalls}`
    },
    socketFailureCalls: [4],
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.socket('game').emit('close')
  await harness.flush(8)

  assert.equal(tokenCalls, 3)
  assert.equal(harness.sockets.length, 5, 'the failed attempt constructed only its first socket')
  assert.equal(harness.sockets[2].closed, true, 'the half-created socket must be closed before retry')
  assert.equal(harness.sockets.filter((socket) => !socket.closed).length, 2)
  assert.equal(client.snapshot().generation, 2)
  client.stop()
})

test('authentication expiry closes both API sockets before portal refresh can open a browser session', async () => {
  let harness
  harness = createHarness({
    refresh: async () => {
      assert.equal(harness.socketAt(0).closed, true)
      assert.equal(harness.socketAt(1).closed, true)
    },
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.receive('game', { action: '/api/v1/authenticate', err: 21 })
  await harness.flush()
  assert.equal(harness.sockets.length, 4)
  client.stop()
})

test('real close events stay suppressed until one auth refresh resolves, then exactly two fresh-token sockets start', async () => {
  let sessionToken = 'stale-session-token'
  let releaseRefresh
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve })
  const harness = createHarness({
    getSessionToken: async () => sessionToken,
    refresh: async () => {
      await refreshGate
      sessionToken = 'fresh-session-token'
    },
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()

  harness.receive('game', { action: '/api/v1/authenticate', err: 21 })
  await harness.flush()
  assert.equal(harness.sockets.length, 2, 'refresh gate must suppress reconnects from real close events')

  releaseRefresh()
  await harness.flush()
  await harness.flush()
  assert.equal(harness.sockets.length, 4)
  harness.openGeneration(2)
  assert.deepEqual(harness.generationAuthTokens(2), ['fresh-session-token', 'fresh-session-token'])
  client.stop()
})

test('socket open timeout closes a hung generation and reconnects both sockets', async () => {
  const timers = createManualTimers()
  const errors = []
  const harness = createHarness({
    connectTimeoutMs: 15_000,
    reconnectDelayMs: 0,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    onError: (error) => errors.push(String(error)),
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  assert.equal(harness.sockets.length, 2)
  assert.equal(timers.nextDelay(), 15_000)
  await timers.runNext()
  assert.equal(harness.sockets.every((socket) => socket.closed), true)
  assert.ok(errors.some((error) => error.includes('mt_socket_open_timeout:game')))
  await timers.runNext()
  assert.equal(harness.sockets.length, 4)
  client.stop()
})

test('failed auth refresh remains stopped with no reconnect generation', async () => {
  const harness = createHarness({ refresh: async () => { throw new Error('refresh-failed') } })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.receive('game', { action: '/api/v1/authenticate', err: 21 })
  await harness.flush()
  await harness.flush()
  assert.equal(harness.sockets.length, 2)
  assert.deepEqual(client.snapshot(), {
    generation: 2, connected: false, authenticated: false, joined: false,
    lastMessageAt: null, reconnecting: false, refreshing: false,
  })
})

function createHarness({
  onFinal = async () => {}, onTables = async () => {}, onError = () => {}, refresh = async () => {},
  getSessionToken = async () => 'opaque-session-value', nextEventSource, now = Date.now,
  reconnectDelayMs = 0, reconnectMaxDelayMs, connectTimeoutMs = 0, setTimeoutFn, clearTimeoutFn,
  socketFailureCalls = [], sourceOwner,
} = {}) {
  const sockets = []
  const timers = []
  let socketCalls = 0
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', status: 'active', expiresAt: 99_999 }
  const owner = {
    lease: () => lease,
    assertCurrent: () => true,
    eventSource: (sequence) => ({ mode: 'api', ownerId: 'api-primary', epoch: 4, fence: 'fence-4', sequence }),
    ...(nextEventSource ? { nextEventSource } : {}),
  }
  const options = {
    sourceOwner: sourceOwner ?? owner,
    sessionManager: { getSessionToken, refresh },
    createSocket: (url, socketOptions) => {
      socketCalls += 1
      if (socketFailureCalls.includes(socketCalls)) throw new Error(`temporary-socket-creation-failure:${socketCalls}`)
      const socket = new FakeSocket(url, socketOptions)
      sockets.push(socket)
      return socket
    },
    onFinal,
    onTables,
    onError,
    now,
    reconnectDelayMs,
    connectTimeoutMs,
    ...(reconnectMaxDelayMs == null ? {} : { reconnectMaxDelayMs }),
    setTimeoutFn: setTimeoutFn ?? ((fn) => { queueMicrotask(fn); return fn }),
    clearTimeoutFn: clearTimeoutFn ?? (() => {}),
    setIntervalFn: (fn) => { timers.push(fn); return fn },
    clearIntervalFn: () => {},
  }
  const generations = () => [sockets.slice(0, 2), sockets.slice(2, 4)]
  return {
    options, sockets,
    socketAt: (index) => sockets[index],
    socket: (kind) => sockets.find((item) => item.kind === kind && !item.closed),
    openAll: () => sockets.slice(0, 2).forEach((socket) => socket.open()),
    openGeneration: (generation) => generations()[generation - 1].forEach((socket) => socket.open()),
    receive: (kind, payload) => sockets.find((item) => item.kind === kind && !item.closed).receive(payload),
    receiveGeneration: (generation, kind, payload) => generations()[generation - 1].find((item) => item.kind === kind).receive(payload),
    authenticateAll() {
      this.receive('game', { action: '/api/v1/authenticate', err: 0 })
      this.receive('chat', { action: '/api/v1/chat/authenticate', err: 0 })
    },
    acknowledgeJoins(generation = 1) {
      this.receiveGeneration(generation, 'game', { action: '/api/v1/gametype/*/game/*/room/*/mulitple_join', err: 0 })
      this.receiveGeneration(generation, 'chat', { action: '/api/v1/chat/room/*/table/*/join', err: 0 })
    },
    packet(kind, action) {
      return sockets.filter((item) => item.kind === kind).flatMap((item) => item.sent).find((item) => actionName(item) === action)
    },
    sentActions(kind) {
      return sockets.filter((item) => item.kind === kind).flatMap((item) => item.sent).map(actionName)
    },
    generationAuthTokens(generation) {
      return generations()[generation - 1].map((socket) => socket.sent.find((packet) => actionName(packet).endsWith('/authenticate'))?.body?.token)
    },
    runInterval(index = 0) { return timers[index]() },
    async flush(turns = 1) {
      for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function summaryPacket(round) {
  return {
    action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/summary' },
    body: { table_id: 'BAG01', room_id: 29, shoe: 88, round, result: '1,2,3,4,0,0,0,0,4,6' },
  }
}

function createManualTimers() {
  const timers = []
  return {
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true
    },
    activeCount: () => timers.filter((timer) => !timer.cleared).length,
    nextDelay: () => timers.find((timer) => !timer.cleared)?.delay,
    async runNext() {
      const timer = timers.find((candidate) => !candidate.cleared)
      assert.ok(timer, 'expected an active timer')
      timer.cleared = true
      await timer.fn()
    },
  }
}

class FakeSocket extends EventEmitter {
  constructor(url, options = {}) {
    super()
    this.url = url
    this.options = options
    this.kind = url.includes('/chat/') ? 'chat' : 'game'
    this.readyState = 0
    this.sent = []
    this.closed = false
  }
  open() { this.readyState = 1; this.emit('open') }
  send(value) { this.sent.push(JSON.parse(value)) }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))) }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.emit('close')
  }
}

function actionName(packet) {
  return typeof packet?.action === 'object' ? packet.action.name : packet?.action
}
