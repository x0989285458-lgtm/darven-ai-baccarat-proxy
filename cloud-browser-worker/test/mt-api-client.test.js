// Migrated from 796bd573fa39b71ba2d0061e555de92ad45276fd; historical release tests are unchanged.
import catalog from './fixtures/api-live-catalog.json' with { type: 'json' }
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PRODUCTION_TABLE_IDS } from '../src/table-policy.js'
import { createMtApiClient } from '../src/mt-api-client.js'

test('API owner authenticates Game and Chat then performs one exact six-raw-table join', async () => {
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
    ...['BAV11', 'BAV12', 'BAV13', 'BAV13A', 'BAV15', 'DTG01', 'DTG02', 'NUG01', 'SBG01']
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
  assert.deepEqual(delivered[0].map(({table_id,shoe,round})=>({table_id,shoe,round})), tables1)

  harness.socket('game').emit('close')
  await harness.flush()
  harness.openGeneration(2)
  harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
  harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
  harness.receiveGeneration(2, 'game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: tables2 } })
  harness.acknowledgeJoins(2)
  await harness.flush()
  assert.equal(delivered.length, 2)
  assert.deepEqual(delivered[1].map(({table_id,shoe,round})=>({table_id,shoe,round})), tables2)
  client.stop()
})

test('first summary initializes shoe and round when the initial six-table list omits screen identity', async () => {
  const delivered = []
  const finals = []
  const harness = createHarness({
    onTables: async (tables) => delivered.push(tables),
    onFinal: async (event) => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  harness.receive('game', summaryPacket(9))
  await harness.flush(4)
  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.equal(current.shoe, 88)
  assert.equal(current.round, 9)
  assert.deepEqual(finals[0].shoeLifecycle, {
    tableId: 'BAV01', activeShoe: 88, retiredShoes: [],
    currentScreen: { shoe: 88, round: 9 }, origin: 'final', source: finals[0].source,
  })
  client.stop()
})

test('startup current-shoe screen rejects a delayed unknown previous-shoe summary', async () => {
  const delivered = []
  const finals = []
  const harness = createHarness({
    onTables: async (tables) => delivered.push(tables),
    onFinal: async (event) => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  const startupTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 89, round: 1, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: startupTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  harness.receive('game', summaryPacketFor('BAV01', 88, 70))
  await harness.flush(4)

  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 89, round: 1 })
  assert.deepEqual(finals, [])
  client.stop()
})

test('startup current-shoe screen rejects a lower-round unknown old-shoe summary without provider rollover evidence', async () => {
  const delivered = []
  const finals = []
  const harness = createHarness({
    onTables: async (tables) => delivered.push(tables),
    onFinal: async (event) => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  const startupTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 89, round: 5, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: startupTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  harness.receive('game', summaryPacketFor('BAV01', 88, 1))
  await harness.flush(4)

  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 89, round: 5 })
  assert.deepEqual(finals, [])
  client.stop()
})

test('startup persisted lifecycle rejects a delayed retired cross-shoe table refresh', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient({
    ...harness.options,
    initialShoeLifecycles: [{
      tableId: 'BAV01', activeShoe: 89, retiredShoes: [88],
      currentScreen: { shoe: 89, round: 5 }, origin: 'provider',
      source: { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'prior-fence', sequence: 90 },
    }],
  })
  const startupTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 89, round: 5, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: startupTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  const delayedTables = startupTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 88, round: 1 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: delayedTables } })
  await harness.flush(2)

  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 89, round: 5 })
  client.stop()
})

test('wrapped shoe 1 Final stays blocked until provider shoe transition is persisted', async () => {
  const delivered = []
  const finals = []
  const harness = createHarness({
    onTables: async (tables) => delivered.push(tables),
    onFinal: async (event) => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  const startupTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 999, round: 70, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: startupTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  harness.receive('game', summaryPacketFor('BAV01', 1, 1))
  await harness.flush(4)
  assert.deepEqual(finals, [])

  const wrappedTables = startupTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 1, round: 0 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: wrappedTables } })
  await harness.flush(4)
  harness.receive('game', summaryPacketFor('BAV01', 1, 1))
  await harness.flush(4)

  assert.deepEqual({ shoe: finals.at(-1)?.shoe, round: finals.at(-1)?.round }, { shoe: 1, round: 1 })
  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 1, round: 1 })
  client.stop()
})

test('retired-shoe history stays bounded while an aged-out delayed summary still lacks transition evidence', async () => {
  const finals = []
  const harness = createHarness({ onFinal: async (event) => finals.push(event) })
  const client = createMtApiClient(harness.options)
  let tables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 1, round: 70, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  for (let shoe = 2; shoe <= 20; shoe += 1) {
    tables = tables.map((table) => table.table_id === 'BAV01' ? { ...table, shoe, round: 0 } : table)
    harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables } })
    await harness.flush(2)
    harness.receive('game', summaryPacketFor('BAV01', shoe, 1))
    await harness.flush(3)
  }
  harness.receive('game', summaryPacketFor('BAV01', 1, 70))
  await harness.flush(4)

  assert.equal(finals.at(-1).shoe, 20)
  assert.equal(finals.some((event, index) => index > 0 && event.shoe === 1), false)
  client.stop()
})

test('table refresh without screen identity preserves the latest Final shoe and round', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)
  harness.receive('game', summaryPacket(9))
  await harness.flush(4)

  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  await harness.flush(2)
  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.equal(current.shoe, 88)
  assert.equal(current.round, 9)
  client.stop()
})

test('provider new-shoe table screen wins before that shoe first summary arrives', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 8, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)
  harness.receive('game', summaryPacket(9))
  await harness.flush(4)

  const rolledTables = initialTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 89, round: 0 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: rolledTables } })
  await harness.flush(2)
  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.equal(current.shoe, 89)
  assert.equal(current.round, 0)
  client.stop()
})

test('authoritative provider refresh accepts a skipped-shoe reconnect transition', async () => {
  const delivered = []
  const finals = []
  const harness = createHarness({
    onTables: async (tables) => delivered.push(tables),
    onFinal: async (event) => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  const startupTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 92, round: 3, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: startupTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  const reconnectedTables = startupTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 95, round: 8 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: reconnectedTables } })
  await harness.flush(2)
  harness.receive('game', summaryPacketFor('BAV01', 92, 4))
  await harness.flush(4)
  harness.receive('game', summaryPacketFor('BAV01', 95, 9))
  await harness.flush(4)

  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 95, round: 9 })
  assert.deepEqual(finals.map(({ shoe, round }) => ({ shoe, round })), [{ shoe: 95, round: 9 }])
  client.stop()
})

test('provider reconnect transitions from durable lifecycle before any latest table screen exists', async () => {
  const order = []
  const harness = createHarness()
  const client = createMtApiClient({
    ...harness.options,
    initialShoeLifecycles: [{
      tableId: 'BAV01', activeShoe: 92, retiredShoes: [91],
      currentScreen: { shoe: 92, round: 70 }, origin: 'provider',
      source: { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'prior-fence', sequence: 90 },
    }],
    onShoeLifecycleTransition: async (lifecycle) => {
      if (lifecycle.tableId === 'BAV01') order.push(`lifecycle:${lifecycle.activeShoe}`)
    },
    onTables: async (tables) => {
      order.push(`tables:${tables.find((table) => table.table_id === 'BAV01')?.shoe}`)
    },
  })
  const tables = PRODUCTION_TABLE_IDS.map((table_id) => ({
    table_id, shoe: table_id === 'BAV01' ? 95 : 200, round: table_id === 'BAV01' ? 8 : 1, trend: [],
  }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables } })
  harness.acknowledgeJoins()
  await harness.flush(4)

  assert.deepEqual(order.filter((value) => value.endsWith(':95')), ['lifecycle:95', 'tables:95'])
  client.stop()
})

test('provider reconnect cannot revive a durable retired shoe before latest tables hydrate', async () => {
  const transitions = []
  const delivered = []
  const harness = createHarness()
  const client = createMtApiClient({
    ...harness.options,
    initialShoeLifecycles: [{
      tableId: 'BAV06', activeShoe: 999, retiredShoes: [1],
      currentScreen: { shoe: 999, round: 70 }, origin: 'provider',
      source: { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'prior-fence', sequence: 90 },
    }],
    onShoeLifecycleTransition: async (lifecycle) => transitions.push(lifecycle),
    onTables: async (tables) => delivered.push(tables),
  })
  const tables = PRODUCTION_TABLE_IDS.map((table_id) => ({
    table_id, shoe: table_id === 'BAV06' ? 1 : 200, round: table_id === 'BAV06' ? 70 : 1, trend: [],
  }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables } })
  harness.acknowledgeJoins()
  await harness.flush(4)

  assert.equal(transitions.some((value) => value.tableId === 'BAV06' && value.activeShoe === 1), false)
  const current = delivered.at(-1).find((table) => table.table_id === 'BAV06')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 999, round: 70 })
  client.stop()
})

test('provider shoe transition is durably acknowledged before publishing the advanced table screen', async () => {
  const order = []
  const lifecycles = []
  const harness = createHarness()
  const client = createMtApiClient({
    ...harness.options,
    onShoeLifecycleTransition: async (lifecycle) => {
      lifecycles.push(structuredClone(lifecycle))
      order.push(`lifecycle:${lifecycle.activeShoe}`)
    },
    onTables: async (tables) => {
      order.push(`tables:${tables.find((table) => table.table_id === 'BAV01')?.shoe}`)
    },
  })
  const startupTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 92, round: 70, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: startupTables } })
  harness.acknowledgeJoins()
  await harness.flush(4)
  order.length = 0

  const reconnectedTables = startupTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 95, round: 3 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: reconnectedTables } })
  await harness.flush(4)

  assert.deepEqual(order.slice(0, 2), ['lifecycle:95', 'tables:95'])
  const transition = lifecycles.find((lifecycle) => lifecycle.tableId === 'BAV01' && lifecycle.activeShoe === 95)
  assert.equal(transition.round, 3)
  assert.equal(transition.origin, 'provider')
  assert.equal(transition.source.mode, 'api')
  assert.equal(Number.isSafeInteger(transition.source.sequence), true)
  client.stop()
})

test('durable retired-shoe bootstrap rejects a delayed historical wrap Final after restart', async () => {
  const finals = []
  const harness = createHarness({ onFinal: async (event) => finals.push(event) })
  const client = createMtApiClient({
    ...harness.options,
    initialShoeLifecycles: [{
      tableId: 'BAV06', activeShoe: 999, retiredShoes: [1],
      currentScreen: { shoe: 999, round: 70 }, origin: 'provider',
      source: { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'prior-fence', sequence: 90 },
    }],
  })
  const tables = PRODUCTION_TABLE_IDS.map((table_id) => ({
    table_id, shoe: table_id === 'BAV06' ? 999 : 200, round: table_id === 'BAV06' ? 70 : 1, trend: [],
  }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables } })
  harness.acknowledgeJoins()
  await harness.flush(3)
  harness.receive('game', summaryPacketFor('BAV06', 1, 1))
  await harness.flush(4)

  assert.deepEqual(finals, [])
  client.stop()
})

test('cross-shoe Final cannot create a lifecycle without a persisted provider transition', async () => {
  const finals = []
  const harness = createHarness({ onFinal: async (event) => finals.push(event) })
  const client = createMtApiClient({
    ...harness.options,
    initialShoeLifecycles: [{
      tableId: 'BAV01', activeShoe: 92, retiredShoes: [],
      currentScreen: { shoe: 92, round: 70 }, origin: 'provider',
      source: { mode: 'api', ownerId: 'api-primary', epoch: 3, fence: 'prior-fence', sequence: 90 },
    }],
  })
  const tables = PRODUCTION_TABLE_IDS.map((table_id) => ({
    table_id, shoe: table_id === 'BAV01' ? 92 : 200, round: table_id === 'BAV01' ? 70 : 1, trend: [],
  }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables } })
  harness.acknowledgeJoins()
  await harness.flush(3)
  harness.receive('game', summaryPacketFor('BAV01', 93, 1))
  await harness.flush(4)

  assert.deepEqual(finals, [])
  client.stop()
})

test('delayed previous-shoe table refresh cannot regress the current Final shoe', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 9, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)
  const advancedTables = initialTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 89, round: 7 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: advancedTables } })
  await harness.flush(3)
  harness.receive('game', summaryPacketFor('BAV01', 89, 8))
  await harness.flush(4)

  const staleTables = initialTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 88, round: 0 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: staleTables } })
  await harness.flush(2)
  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 89, round: 8 })
  client.stop()
})

test('delayed previous-shoe summary cannot regress the current Final shoe', async () => {
  const delivered = []
  const finals = []
  const harness = createHarness({
    onTables: async (tables) => delivered.push(tables),
    onFinal: async (event) => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 9, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)
  const advancedTables = initialTables.map((table) => table.table_id === 'BAV01'
    ? { ...table, shoe: 89, round: 0 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: advancedTables } })
  await harness.flush(3)
  harness.receive('game', summaryPacketFor('BAV01', 89, 1))
  await harness.flush(4)
  harness.receive('game', summaryPacketFor('BAV01', 88, 10))
  await harness.flush(4)
  harness.receive('game', summaryPacketFor('BAV01', 87, 1))
  await harness.flush(4)

  const current = delivered.at(-1).find((table) => table.table_id === 'BAV01')
  assert.deepEqual({ shoe: current.shoe, round: current.round }, { shoe: 89, round: 1 })
  assert.deepEqual(finals.map(({ shoe, round }) => ({ shoe, round })), [{ shoe: 89, round: 1 }])
  client.stop()
})

test('all six missing table screens hydrate from latest trustworthy Final chronology across shoe wrap', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const providerTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, trend: [] }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: providerTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  harness.receive('game', summaryPacketFor('BAV06', 999, 70))
  await harness.flush(4)
  const wrappedProviderTables = providerTables.map((table) => table.table_id === 'BAV06'
    ? { ...table, shoe: 2, round: 0 }
    : table)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: wrappedProviderTables } })
  await harness.flush(3)
  PRODUCTION_TABLE_IDS.forEach((tableId, index) => {
    const shoe = tableId === 'BAV06' ? 2 : 200 + index
    harness.receive('game', summaryPacketFor(tableId, shoe, index + 1))
  })
  await harness.flush(PRODUCTION_TABLE_IDS.length * 3)
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: providerTables } })
  await harness.flush(2)

  const screens = new Map(delivered.at(-1).map((table) => [table.table_id, { shoe: table.shoe, round: table.round }]))
  assert.equal(screens.size, 6)
  for (const [index, tableId] of PRODUCTION_TABLE_IDS.entries()) {
    assert.deepEqual(screens.get(tableId), {
      shoe: tableId === 'BAV06' ? 2 : 200 + index,
      round: index + 1,
    })
  }
  client.stop()
})

test('summary advances the live table snapshot and refreshes provider tables without allowing stale regression', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 8 }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  await harness.flush(2)

  harness.receive('game', summaryPacket(9))
  await harness.flush(4)
  assert.equal(delivered.at(-1).find((table) => table.table_id === 'BAV01').round, 9)
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/tables')).length, 2)

  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  await harness.flush(2)
  assert.equal(delivered.at(-1).find((table) => table.table_id === 'BAV01').round, 9)
  client.stop()
})

test('summary before validated catalog is rejected, cannot join or duplicate refresh, and is not replayed after admission', async () => {
  const delivered = []
  const finals = []
  const harness = createHarness({ autoCatalog: false, onTables: async (tables) => delivered.push(tables), onFinal: async (event) => finals.push(event) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 8 }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', summaryPacket(9))
  await harness.flush(3)
  assert.equal(client.snapshot().joined, false)
  assert.deepEqual(delivered, [])
  assert.deepEqual(finals, [])
  assert.equal(harness.sentActions('game').some((action) => action.endsWith('/mulitple_join')), false)
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/tables')).length, 1)

  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  await harness.flush(2)
  assert.equal(client.snapshot().joined, false)
  assert.deepEqual(finals, [])
  harness.acknowledgeJoins()
  await harness.flush(2)
  assert.equal(client.snapshot().joined, true)
  assert.equal(delivered.at(-1).find((table) => table.table_id === 'BAV01').round, 8)
  assert.deepEqual(finals, [])
  harness.receive('game', summaryPacket(9))
  await harness.flush(3)
  assert.equal(finals.length, 1)
  assert.equal(delivered.at(-1).find((table) => table.table_id === 'BAV01').round, 9)
  client.stop()
})

test('a reconnect generation cannot regress a table already advanced by summary', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 8 }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  harness.receive('game', summaryPacket(9))
  await harness.flush(3)

  harness.socket('game').emit('close')
  await harness.flush(2)
  harness.openGeneration(2)
  harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
  harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
  harness.receiveGeneration(2, 'game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins(2)
  await harness.flush(3)
  assert.equal(delivered.at(-1).find((table) => table.table_id === 'BAV01').round, 9)
  client.stop()
})

test('a lost tables refresh response is retried after the bounded timeout', async () => {
  let nowMs = 1_000
  const delivered = []
  const harness = createHarness({ now: () => nowMs, tablesRefreshTimeoutMs: 10_000, onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 8 }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  harness.receive('game', summaryPacket(9))
  await harness.flush(3)
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/tables')).length, 2)

  nowMs += 10_001
  harness.receive('game', summaryPacket(10))
  await harness.flush(3)
  assert.equal(harness.sentActions('game').filter((action) => action.endsWith('/tables')).length, 3)
  assert.equal(delivered.at(-1).find((table) => table.table_id === 'BAV01').round, 10)
  client.stop()
})

test('an out-of-order or duplicate summary cannot regress the monotonic table screen', async () => {
  const delivered = []
  const harness = createHarness({ onTables: async (tables) => delivered.push(tables) })
  const client = createMtApiClient(harness.options)
  const initialTables = PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 88, round: 10 }))
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: initialTables } })
  harness.acknowledgeJoins()
  harness.receive('game', summaryPacket(12))
  harness.receive('game', summaryPacket(11))
  harness.receive('game', summaryPacket(12))
  await harness.flush(6)
  assert.equal(delivered.at(-1).find((table) => table.table_id === 'BAV01').round, 12)
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

  const body = { table_id: 'BAV01', room_id: 48, shoe: 88, round: 9, result: '1,2,3,4,0,0,0,0,4,6' }
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
  const body = { table_id: 'BAV01', room_id: 48, shoe: 88, round: 9, result: '1,2,3,4,0,0,0,0,4,6' }
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
  const body = { table_id: 'BAV01', room_id: 48, shoe: 88, round: 9, result: '1,2,3,4,0,0,0,0,4,6' }
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

test('socket authentication timeout closes both sockets, refreshes once, and starts one fresh generation', async () => {
  const timers = createManualTimers()
  const errors = []
  let refreshes = 0
  const harness = createHarness({
    connectTimeoutMs: 15_000,
    authenticateTimeoutMs: 15_000,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    refresh: async () => { refreshes += 1 },
    onError: (error) => errors.push(String(error)),
  })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  assert.equal(timers.activeCount(), 2)

  await timers.runNext()
  await harness.flush(2)

  assert.equal(refreshes, 1)
  assert.equal(harness.socketAt(0).closed, true)
  assert.equal(harness.socketAt(1).closed, true)
  assert.equal(harness.sockets.length, 4)
  assert.ok(errors.some((error) => error.includes('mt_authenticate_timeout:game')))
  client.stop()
})

test('failed auth refresh retries with bounded single-generation backoff, recovers, and stop cancels detached retry', async () => {
  {
    const clock = createManualTimers()
    let refreshCalls = 0
    const harness = createHarness({
      refresh: async () => {
        refreshCalls += 1
        if (refreshCalls === 1) throw new Error('temporary-refresh-failure')
      },
      reconnectDelayMs: 10,
      reconnectMaxDelayMs: 40,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
    })
    const client = createMtApiClient(harness.options)
    await client.start()
    harness.openAll()
    harness.receive('game', { action: '/api/v1/authenticate', err: 21 })
    await harness.flush(2)

    assert.equal(refreshCalls, 1)
    assert.equal(clock.activeCount(), 1, 'one failed refresh must leave exactly one detached retry')
    assert.equal(clock.nextDelay(), 10)
    assert.equal(harness.sockets.length, 2, 'no replacement generation starts before refresh succeeds')
    assert.equal(harness.sockets.every((socket) => socket.closed), true)
    assert.equal(client.snapshot().reconnecting, true)

    await clock.runNext()
    await harness.flush(2)
    assert.equal(refreshCalls, 2)
    assert.equal(harness.sockets.length, 4, 'recovery must create exactly one fresh socket generation')
    assert.equal(harness.sockets.filter((socket) => !socket.closed).length, 2)
    assert.equal(clock.activeCount(), 0, 'successful recovery must not leak a retry timer')

    harness.openGeneration(2)
    harness.receiveGeneration(2, 'game', { action: '/api/v1/authenticate', err: 0 })
    harness.receiveGeneration(2, 'chat', { action: '/api/v1/chat/authenticate', err: 0 })
    harness.acknowledgeJoins(2)
    await harness.flush(4)
    assert.deepEqual(
      (({ connected, authenticated, joined }) => ({ connected, authenticated, joined }))(client.snapshot()),
      { connected: true, authenticated: true, joined: true },
    )
    client.stop()
    assert.equal(clock.activeCount(), 0)
  }

  {
    const clock = createManualTimers()
    let refreshCalls = 0
    const harness = createHarness({
      refresh: async () => {
        refreshCalls += 1
        throw new Error('persistent-refresh-failure')
      },
      reconnectDelayMs: 10,
      reconnectMaxDelayMs: 40,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
    })
    const client = createMtApiClient(harness.options)
    await client.start()
    harness.openAll()
    harness.receive('game', { action: '/api/v1/authenticate', err: 21 })
    await harness.flush(2)
    assert.equal(refreshCalls, 1)
    assert.equal(clock.activeCount(), 1)

    for (const expectedDelay of [10, 20, 40]) {
      assert.equal(clock.nextDelay(), expectedDelay)
      await clock.runNext()
      await harness.flush(2)
      assert.equal(clock.activeCount(), 1, 'each failed refresh must leave exactly one retry timer')
    }
    assert.equal(refreshCalls, 4)
    assert.equal(clock.nextDelay(), 40, 'refresh retry backoff must stay capped')

    client.stop()
    assert.equal(clock.activeCount(), 0, 'stop must cancel the detached refresh retry')
    await harness.flush(2)
    assert.equal(refreshCalls, 4)
    assert.equal(harness.sockets.length, 2)
  }
})

test('stop during a pending session token read cannot create a late socket generation', async () => {
  let releaseToken
  const tokenGate = new Promise((resolve) => { releaseToken = resolve })
  const harness = createHarness({ getSessionToken: async () => tokenGate })
  const client = createMtApiClient(harness.options)

  const startPromise = client.start()
  await harness.flush(2)
  client.stop()
  releaseToken('opaque-late-session')
  await startPromise
  await harness.flush(2)

  assert.equal(harness.sockets.length, 0)
  assert.equal(client.snapshot().connected, false)
  assert.equal(client.snapshot().reconnecting, false)
})

test('stop then restart while the first token read is pending keeps only the newest lifecycle sockets', async () => {
  let releaseToken
  const tokenGate = new Promise((resolve) => { releaseToken = resolve })
  const harness = createHarness({ getSessionToken: async () => tokenGate })
  const client = createMtApiClient(harness.options)

  const firstStart = client.start()
  await harness.flush(2)
  client.stop()
  const secondStart = client.start()
  await harness.flush(2)
  releaseToken('opaque-restart-session')
  await Promise.all([firstStart, secondStart])
  await harness.flush(2)

  assert.equal(harness.sockets.length, 2)
  assert.equal(harness.sockets.filter((socket) => !socket.closed).length, 2)
  assert.equal(client.snapshot().generation, 1)
  client.stop()
})

// Screen projection from observed-catalog.json (2026-10-23); cards below remain
// synthetic unit-test summaries, never recorded live results.
function nestedCatalog() {
  const screens = [[1532, 2, 1], [1534, 35, 34], [1529, 21, 20], [1538, 15, 14], [1528, 32, 31], [2375, 17, 16]]
  return PRODUCTION_TABLE_IDS.map((table_id, index) => {
    const [shoe, current, total] = screens[index]
    return {
      ...catalog.find(table => table.table_id === table_id),
      game_name: `20261023_${shoe}_${current}`,
      trend: { current_shoe: String(shoe), current_round: String(current), total_round: String(total) },
    }
  })
}

async function startCatalogHarness(tables, overrides = {}) {
  const delivered = [], finals = [], errors = []
  const harness = createHarness({ autoCatalog: false,
    onTables: async value => delivered.push(value), onFinal: async value => finals.push(value),
    onError: value => errors.push(value), ...overrides })
  const client = createMtApiClient(harness.options)
  await client.start()
  harness.openAll()
  harness.authenticateAll()
  harness.receive('game', { msg: { tables } })
  await harness.flush(3)
  if (!errors.length) harness.acknowledgeJoins()
  await harness.flush(3)
  return { harness, client, delivered, finals, errors }
}

test('nested catalog normalizes completed screens for exactly six raw sources without fabricating Finals', async () => {
  const tables = nestedCatalog()
  const { client, delivered, finals, errors } = await startCatalogHarness(tables)
  try {
    assert.deepEqual(errors, [])
    assert.deepEqual(delivered.at(-1).map(t => [t.table_id, t.shoe, t.round]),
      tables.map(t => [t.table_id, Number(t.trend.current_shoe), Number(t.trend.total_round)]))
    assert.deepEqual(finals, [])
  } finally { client.stop() }
})

test('nested rollover retires old shoe, rejects stale catalog and admits only validated new-shoe summaries', async () => {
  const tables = nestedCatalog()
  const old = structuredClone(tables)
  old[2] = { ...old[2], game_name: '20261023_1528_58',
    trend: { current_shoe: '1528', current_round: '58', total_round: '57' } }
  const { harness, client, delivered, finals } = await startCatalogHarness(old)
  try {
    harness.receive('game', summaryPacketFor('BAV03', 1528, 57))
    harness.receive('game', { msg: { tables } })
    await harness.flush(4)
    assert.equal(delivered.at(-1)[2].shoe, 1529)
    assert.equal(delivered.at(-1)[2].round, 20)
    harness.receive('game', { msg: { tables: old } })
    harness.receive('game', summaryPacketFor('BAV03', 1528, 58))
    const provisional = summaryPacketFor('BAV03', 1529, 21)
    provisional.action.name = provisional.action.name.replace('/summary', '/show_poker')
    harness.receive('game', provisional)
    const invalid = summaryPacketFor('BAV03', 1529, 21)
    invalid.body.result = '0,0,0,0,0,0,-1,-1,0,0'
    harness.receive('game', invalid)
    await harness.flush(4)
    assert.equal(finals.length, 1)
    assert.equal(delivered.at(-1)[2].game_name, tables[2].game_name)
    harness.receive('game', summaryPacketFor('BAV03', 1529, 21))
    await harness.flush(4)
    assert.deepEqual(finals.map(f => [f.shoe, f.round]), [[1528, 57], [1529, 21]])
    assert.deepEqual(finals.at(-1).shoeLifecycle.retiredShoes, [1528])
  } finally { client.stop() }
})

test('nested same-shoe metadata advances behind a Final screen but stale catalog cannot regress it', async () => {
  const tables = nestedCatalog()
  const { harness, client, delivered } = await startCatalogHarness(tables)
  try {
    harness.receive('game', summaryPacketFor('BAV03', 1529, 21))
    const updated = structuredClone(tables)
    updated[2].orderState = 2
    harness.receive('game', { msg: { tables: updated } })
    await harness.flush(4)
    assert.equal(delivered.at(-1)[2].round, 21)
    assert.equal(delivered.at(-1)[2].orderState, 2)
    updated[2].game_name = '20261023_1529_22'
    updated[2].trend = { current_shoe: '1529', current_round: '22', total_round: '21' }
    harness.receive('game', { msg: { tables: updated } })
    harness.receive('game', { msg: { tables } })
    await harness.flush(4)
    assert.equal(delivered.at(-1)[2].game_name, '20261023_1529_22')
    assert.equal(delivered.at(-1)[2].round, 21)
    const settledStale = structuredClone(tables)
    settledStale[2].trend.total_round = '21'
    harness.receive('game', { msg: { tables: settledStale } })
    await harness.flush(3)
    assert.equal(delivered.at(-1)[2].game_name, '20261023_1529_22')
  } finally { client.stop() }
})

test('nested first shoe has zero completed rounds and does not infer a Final from pending round one', async () => {
  const tables = nestedCatalog().map(t => ({ ...t, game_name: '20261023_1_1',
    trend: { current_shoe: '1', current_round: '1', total_round: '0' } }))
  const { harness, client, delivered, finals } = await startCatalogHarness(tables)
  try {
    assert.ok(delivered.at(-1).every(t => t.shoe === 1 && t.round === 0))
    assert.deepEqual(finals, [])
    harness.receive('game', summaryPacketFor('BAV03', 1, 1))
    await harness.flush(3)
    assert.equal(finals.length, 1)
  } finally { client.stop() }
})

test('unknown-shoe rejection refreshes all rolled tables single-flight, retries on timeout, and never replays rejected Finals', async () => {
  let nowMs = 1000
  const tables = nestedCatalog()
  const old = tables.map(t => ({ ...t, game_name: '20261023_100_58',
    trend: { current_shoe: '100', current_round: '58', total_round: '57' } }))
  const { harness, client, finals } = await startCatalogHarness(old, { now: () => nowMs })
  const count = () => harness.sentActions('game').filter(a => a.endsWith('/tables')).length
  try {
    for (const t of tables) harness.receive('game', summaryPacketFor(t.table_id, Number(t.trend.current_shoe), Number(t.trend.current_round)))
    await harness.flush(5)
    assert.equal(count(), 2)
    assert.deepEqual(finals, [])
    harness.receive('game', { msg: { tables: old } })
    harness.receive('game', summaryPacketFor('BAV03', 1529, 21))
    await harness.flush(3)
    assert.equal(count(), 2, 'fast stale responses must not permit a rejected-summary refresh flood')
    nowMs += 10001
    harness.receive('game', summaryPacketFor('BAV03', 1529, 21))
    await harness.flush(3)
    assert.equal(count(), 3)
    harness.receive('game', { msg: { tables } })
    await harness.flush(3)
    assert.deepEqual(finals, [])
    // Known retired shoes must not cause refresh traffic.
    harness.receive('game', summaryPacketFor('BAV03', 100, 58))
    await harness.flush(3)
    assert.equal(count(), 3)
    for (const t of tables) harness.receive('game', summaryPacketFor(t.table_id, Number(t.trend.current_shoe), Number(t.trend.current_round)))
    await harness.flush(5)
    assert.equal(finals.length, 6)
    assert.equal(count(), 4)
  } finally { client.stop() }
})

test('malformed or contradictory nested screens are quarantined without revoking catalog membership', async t => {
  const cases = [
    ...['current_shoe', 'current_round', 'total_round'].flatMap(field =>
      [undefined, null, '', ' ', 'abc', '-1', -1, '1.5', '1e2', false, [], 9007199254740992]
        .map(value => ({ name: `${field}=${JSON.stringify(value)}`, change: row => { row.trend[field] = value } }))),
    { name: 'pending before completed', change: row => { row.trend.total_round = '22' } },
    { name: 'ambiguous gap', change: row => { row.trend.total_round = '18' } },
    { name: 'game shoe conflict', change: row => { row.game_name = '20261023_999_21' } },
    { name: 'game round conflict', change: row => { row.game_name = '20261023_1529_22' } },
    { name: 'malformed game identity', change: row => { row.game_name = 'broken' } },
    { name: 'explicit shoe conflict', change: row => { row.shoe = 100; row.round = 20 } },
    { name: 'explicit pending is not completed', change: row => { row.shoe = 1529; row.round = 21 } },
    { name: 'empty nested screen', change: row => { row.trend = {} } },
    { name: 'malformed trend type', change: row => { row.trend = 'invalid' } },
  ]
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const tables = nestedCatalog()
    scenario.change(tables[2])
    const { client, delivered, finals, errors } = await startCatalogHarness(tables)
    try {
      assert.deepEqual(errors, [])
      assert.equal(delivered.at(-1).length, 6)
      const isolated = delivered.at(-1)[2]
      assert.equal(isolated.catalogScreenInvalid, true)
      assert.equal(isolated.shoe, undefined)
      assert.equal(isolated.round, undefined)
      assert.equal(isolated.trend, undefined)
      assert.deepEqual(finals, [])
      assert.equal(client.snapshot().joined, true)
    } finally { client.stop() }
  })
})

test('screenless refresh cannot clear startup quarantine or authorize a summary', async () => {
  const valid = nestedCatalog()
  const invalid = structuredClone(valid)
  invalid[2].trend.total_round = '54'
  const { harness, client, delivered, finals } = await startCatalogHarness(invalid)
  try {
    const missing = structuredClone(valid)
    delete missing[2].trend
    delete missing[2].game_name
    harness.receive('game', { msg: { tables: missing } })
    harness.receive('game', summaryPacketFor('BAV03', 1529, 21))
    await harness.flush(4)
    assert.equal(finals.length, 0, 'screenless refresh cannot invent trusted shoe chronology')
    assert.equal(delivered.at(-1)[2].catalogScreenInvalid, true)
    harness.receive('game', { msg: { tables: valid } })
    harness.receive('game', summaryPacketFor('BAV03', 1529, 21))
    await harness.flush(4)
    assert.equal(finals.length, 1)
    assert.equal(delivered.at(-1)[2].round, 21)
    assert.equal(client.snapshot().joined, true)
  } finally { client.stop() }
})

test('provider logout revokes immediately despite err=0, refreshes once, and fences late ACKs and summaries', async () => {
  let releaseRefresh
  const gate = new Promise(resolve => { releaseRefresh = resolve })
  const reasons = []
  const finals = []
  const harness = createHarness({
    refresh: async context => { reasons.push(context); await gate },
    onFinal: async event => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  try {
    await client.start()
    harness.openAll()
    harness.authenticateAll()
    harness.acknowledgeJoins()
    await harness.flush(2)
    assert.equal(client.snapshot().joined, true)
    harness.receiveGeneration(1, 'game', { name: '/api/v1/member/logout', err: 0, msg: { code: 3 } })
    assert.equal(client.snapshot().connected, false)
    assert.equal(client.snapshot().authenticated, false)
    assert.equal(client.snapshot().joined, false)
    assert.equal(client.snapshot().reconnecting, true)
    assert.equal(client.snapshot().refreshing, true)
    for (const kind of ['game', 'chat']) {
      harness.receiveGeneration(1, kind, { name: '/api/v1/member/logout', err: 0 })
      harness.receiveGeneration(1, kind, { action: kind === 'game' ? '/api/v1/authenticate' : '/api/v1/chat/authenticate', err: 0 })
    }
    harness.acknowledgeJoins()
    harness.receiveGeneration(1, 'game', summaryPacket(9))
    await harness.flush(2)
    assert.deepEqual(reasons, [{ reason: 'provider_logout' }])
    assert.equal(harness.sockets.length, 2)
    assert.equal(harness.sockets.every(socket => socket.closed), true)
    assert.deepEqual(finals, [])
    releaseRefresh()
    await harness.flush(2)
    assert.equal(harness.sockets.length, 4)
    assert.equal(client.snapshot().joined, false)
    harness.openGeneration(2)
    harness.receiveGeneration(2, 'game', { name: '/api/v1/authenticate', err: 0 })
    harness.receiveGeneration(2, 'chat', { name: '/api/v1/chat/authenticate', err: 0 })
    harness.receiveGeneration(2, 'game', { name: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: PRODUCTION_TABLE_IDS.map(table_id => ({ table_id, shoe: 88, round: 8 })) } })
    harness.receiveGeneration(2, 'game', { name: '/api/v1/gametype/*/game/*/room/*/mulitple_join', err: 0 })
    await harness.flush(2)
    assert.equal(client.snapshot().joined, true)
    harness.receiveGeneration(1, 'game', { name: '/api/v1/member/logout', err: 0 })
    harness.receiveGeneration(1, 'game', summaryPacket(9))
    harness.receiveGeneration(2, 'game', summaryPacketFor('BAV01', 89, 1))
    await harness.flush(2)
    assert.deepEqual(finals, [], 'unknown shoe and revoked generation remain rejected')
    harness.receiveGeneration(2, 'game', summaryPacket(9))
    await harness.flush(2)
    assert.equal(finals.length, 1)
    assert.equal(reasons.length, 1)
  } finally { releaseRefresh(); client.stop() }
})

test('provider logout fences an in-flight source allocation before any Final can be delivered', async () => {
  let releaseSource
  let entered = false
  const sourceGate = new Promise(resolve => { releaseSource = resolve })
  const finals = []
  const harness = createHarness({
    nextEventSource: async lease => { entered = true; await sourceGate; return { ...lease, sequence: 1 } },
    onFinal: async event => finals.push(event),
  })
  const client = createMtApiClient(harness.options)
  try {
    await client.start()
    harness.openAll()
    harness.authenticateAll()
    harness.acknowledgeJoins()
    await harness.flush(2)
    harness.receive('game', summaryPacket(9))
    await harness.flush()
    assert.equal(entered, true)
    harness.receive('chat', { name: '/api/v1/member/logout', err: 0 })
    assert.equal(client.snapshot().joined, false)
    await harness.flush(2)
    releaseSource()
    await harness.flush(2)
    assert.deepEqual(finals, [])
    assert.equal(harness.sockets.length, 4)
  } finally { releaseSource(); client.stop() }
})

test('provider logout stop during refresh prevents late reconnect and unrelated code 3 is not revocation', async () => {
  let releaseRefresh
  const gate = new Promise(resolve => { releaseRefresh = resolve })
  let calls = 0
  const harness = createHarness({ refresh: async () => { calls += 1; await gate } })
  const client = createMtApiClient(harness.options)
  try {
    await client.start()
    harness.openAll()
    harness.authenticateAll()
    harness.acknowledgeJoins()
    await harness.flush(2)
    harness.receive('game', { name: '/api/v1/ping', err: 0, msg: { code: 3 } })
    await harness.flush()
    assert.equal(client.snapshot().joined, true)
    assert.equal(calls, 0)
    harness.receive('game', { action: '/api/v1/member/logout', err: 42 })
    await harness.flush()
    assert.equal(calls, 1)
    client.stop()
    releaseRefresh()
    await harness.flush(2)
    assert.equal(harness.sockets.length, 2)
    assert.equal(client.snapshot().connected, false)
    assert.equal(client.snapshot().reconnecting, false)
    assert.equal(client.snapshot().refreshing, false)
  } finally { releaseRefresh(); client.stop() }
})

test('provider logout after restart revokes even while an older refresh is pending and stays single flight', async () => {
  let releaseRefresh
  const gate = new Promise(resolve => { releaseRefresh = resolve })
  let calls = 0
  let active = 0
  let peak = 0
  const harness = createHarness({ refresh: async () => {
    calls += 1
    active += 1
    peak = Math.max(peak, active)
    await gate
    active -= 1
  } })
  const client = createMtApiClient(harness.options)
  try {
    await client.start()
    harness.openAll()
    harness.receive('game', { name: '/api/v1/member/logout', err: 0 })
    await harness.flush()
    client.stop()
    await client.start()
    harness.openGeneration(2)
    harness.receiveGeneration(2, 'chat', { name: '/api/v1/member/logout', err: 0 })
    assert.equal(client.snapshot().connected, false)
    assert.equal(harness.sockets.every(socket => socket.closed), true)
    await harness.flush()
    assert.equal(calls, 1)
    releaseRefresh()
    await harness.flush(2)
    assert.equal(calls, 2)
    assert.equal(peak, 1)
    assert.equal(harness.sockets.length, 6)
    assert.equal(harness.sockets.filter(socket => !socket.closed).length, 2)
  } finally { releaseRefresh(); client.stop() }
})

test('provider logout without refresh capability reports idle refresh and one bounded retry', async () => {
  const clock = createManualTimers()
  const errors = []
  const harness = createHarness({
    onError: error => errors.push(error), reconnectDelayMs: 10,
    setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
  })
  delete harness.options.sessionManager.refresh
  const client = createMtApiClient(harness.options)
  try {
    await client.start()
    harness.openAll()
    harness.receive('game', { name: '/api/v1/member/logout', err: 0 })
    await harness.flush()
    assert.deepEqual(errors, ['mt_session_refresh_unavailable'])
    assert.equal(client.snapshot().refreshing, false)
    assert.equal(client.snapshot().reconnecting, true)
    assert.equal(client.snapshot().connected, false)
    assert.equal(clock.activeCount(), 1)
    assert.equal(clock.nextDelay(), 10)
    assert.equal(harness.sockets.length, 2)
  } finally { client.stop() }
  assert.equal(clock.activeCount(), 0)
})

test('provider logout refresh failure stays degraded with capped backoff and stop cancels retry', async () => {
  const clock = createManualTimers()
  let calls = 0
  const harness = createHarness({
    refresh: async () => { calls += 1; throw new Error('refresh unavailable') },
    reconnectDelayMs: 10, reconnectMaxDelayMs: 40,
    setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
  })
  const client = createMtApiClient(harness.options)
  try {
    await client.start()
    harness.openAll()
    harness.receive('chat', { action: { name: '/api/v1/member/logout' }, err: 0, msg: { code: 99 } })
    await harness.flush()
    for (const delay of [10, 20, 40, 40]) {
      assert.equal(clock.activeCount(), 1)
      assert.equal(clock.nextDelay(), delay)
      assert.equal(client.snapshot().connected, false)
      assert.equal(client.snapshot().authenticated, false)
      assert.equal(client.snapshot().joined, false)
      assert.equal(client.snapshot().reconnecting, true)
      assert.equal(client.snapshot().refreshing, false)
      await clock.runNext()
    }
    assert.equal(calls, 5)
    assert.equal(harness.sockets.length, 2)
    client.stop()
    assert.equal(clock.activeCount(), 0)
  } finally { client.stop() }
})

function createHarness({
  onFinal = async () => {}, onTables = async () => {}, onError = () => {}, refresh = async () => {},
  getSessionToken = async () => 'opaque-session-value', nextEventSource, now = Date.now,
  reconnectDelayMs = 0, reconnectMaxDelayMs, connectTimeoutMs = 0, authenticateTimeoutMs = connectTimeoutMs,
  tablesRefreshTimeoutMs, setTimeoutFn, clearTimeoutFn,
  socketFailureCalls = [], sourceOwner, autoCatalog = true,
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
      const receiveOriginal = socket.receive.bind(socket)
      socket.receive = (payload) => {
        if (payload.msg?.tables) {
          payload = structuredClone(payload)
          payload.msg.tables = payload.msg.tables.map((table) => ({
            ...catalog.find((entry) => entry.table_id === table.table_id), ...table,
          }))
          payload.msg.tables.push(...catalog.filter((table) => table.table_id.endsWith('_LIVE')))
        }
        receiveOriginal(payload)
        if (autoCatalog && socket.kind === 'chat' && payload.action === '/api/v1/chat/authenticate' && payload.err === 0) {
          const game = sockets.findLast((candidate) => candidate.kind === 'game' && !candidate.closed)
          game?.receive({ msg: { tables: catalog.filter((table) => !table.table_id.endsWith('_LIVE')) } })
        }
      }
      sockets.push(socket)
      return socket
    },
    onFinal,
    onTables,
    onError,
    now,
    reconnectDelayMs,
    connectTimeoutMs,
    authenticateTimeoutMs,
    ...(tablesRefreshTimeoutMs == null ? {} : { tablesRefreshTimeoutMs }),
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
    body: { table_id: 'BAV01', room_id: 48, shoe: 88, round, result: '1,2,3,4,0,0,0,0,4,6' },
  }
}

function summaryPacketFor(tableId, shoe, round) {
  return {
    action: { name: '/api/v1/gametype/*/game/*/room/*/table/*/summary' },
    body: { table_id: tableId, room_id: Number(catalog.find(x=>x.table_id===tableId)?.room_id), shoe, round, result: '1,2,3,4,0,0,0,0,4,6' },
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
