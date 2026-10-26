// Synthetic offline packets only: NOT recorded provider games or native encoder evidence.
// Uses the existing MT decoder grammar (bead pair/outcome; big tie/point/metadata/outcome).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createMtApiClient } from '../src/mt-api-client.js'

const sources = [['BAV01', 48], ['BAV02', 49], ['BAV03', 50], ['BAV03A', 51], ['BAV05', 52], ['BAV06', 57]]
function syntheticCatalog() {
  return sources.map(([table_id, room_id]) => ({
    table_id, room_id, hall: 3, table_type: 'BAC', game_name: '20261026_1648_2',
    trend: {
      current_shoe: '1648', current_round: '2', total_round: '1',
      total_round_banker: '0', total_round_player: '1', total_round_tie: '0',
      total_round_banker_pair: '0', total_round_player_pair: '0',
      bead_plate2: '01', big2: '0801', big_eye2: '', small2: '', cockroach2: '',
      next_banker2: null, next_player2: null,
    },
  }))
}
class OfflineSocket extends EventEmitter {
  readyState = 0
  sent = []
  open() { this.readyState = 1; this.emit('open') }
  send(raw) { this.sent.push(JSON.parse(raw)) }
  receive(packet) { this.emit('message', Buffer.from(JSON.stringify(packet))) }
  close() { this.readyState = 3 }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

async function exerciseBundle(initial, body, inspect) {
  const sockets = new Map(), tables = [], finals = []
  const lease = { mode: 'api', ownerId: 'synthetic-owner', epoch: 1, fence: 'synthetic-fence' }
  const client = createMtApiClient({
    sourceOwner: { lease: () => lease, assertCurrent: () => true, eventSource: sequence => ({ ...lease, sequence }) },
    sessionManager: { getSessionToken: async () => 'synthetic-not-a-credential' },
    createSocket: (_url, options) => { const socket = new OfflineSocket(); sockets.set(options.kind, socket); return socket },
    onTables: async value => tables.push(structuredClone(value)), onFinal: async value => finals.push(value),
    connectTimeoutMs: 0, authenticateTimeoutMs: 0, setIntervalFn: () => null, clearIntervalFn: () => {},
  })
  try {
    await client.start(); for (const socket of sockets.values()) socket.open()
    const game = sockets.get('game')
    game.receive({ action: '/api/v1/authenticate', err: 0 })
    sockets.get('chat').receive({ action: '/api/v1/chat/authenticate', err: 0 })
    game.receive({ msg: { tables: initial } }); await flush()
    game.receive({ action: '/api/v1/gametype/*/game/*/room/*/mulitple_join', err: 0 }); await flush()
    game.receive({ action: '/api/v1/gametype/*/game/*/room/*/table/*/summary', body }); await flush()
    await inspect({ game, tables, finals })
  } finally { client.stop() }
}

function completeCatalog() {
  return syntheticCatalog().map(t => ({ ...t, trend: { ...t.trend,
    next_banker2: { bead_plate: '0102', big: '0801#0702', big_eye: '', small: '', cockroach: '' },
    next_player2: { bead_plate: '0101', big: '0801,0701', big_eye: '', small: '', cockroach: '' },
  } }))
}

test('gap publishes pending with verified old bundle identity without delaying Final', async () => {
  await exerciseBundle(completeCatalog(), { table_id: 'BAV03A', room_id: 51, shoe: 1648, round: 3, result: '1,2,3,4,0,0,0,0,4,6' },
    async ({game,tables,finals}) => {
      assert.equal(finals.length,1)
      const row=tables.at(-1).find(t=>t.table_id==='BAV03A')
      assert.equal(row.round,3)
      assert.deepEqual(row.trendBundle,{schemaVersion:1,tableId:'BAV03A',shoe:'1648',completedRound:1,status:'pending',reason:'coverage-mismatch'})
      assert.equal(Number(row.trend.total_round),1)
      game.receive({msg:{tables:completeCatalog()}});await flush()
      assert.equal(tables.at(-1).find(t=>t.table_id==='BAV03A').trendBundle.status,'pending')
      const complete=completeCatalog().map(t=>t.table_id==='BAV03A'?{...t,game_name:'20261026_1648_4',trend:{
        current_shoe:'1648',current_round:'4',total_round:'3',total_round_banker:'1',total_round_player:'2',total_round_tie:'0',
        total_round_banker_pair:'0',total_round_player_pair:'0',bead_plate2:'010201',big2:'0801#0602#0401',big_eye2:'2',small2:'',cockroach2:'',
        next_banker2:{bead_plate:'01020102',big:'0801#0602#0401#0702',big_eye:'2,2',small:'2',cockroach:''},
        next_player2:{bead_plate:'01020101',big:'0801#0602#0401,0701',big_eye:'2#1',small:'1',cockroach:''},
      }}:t)
      game.receive({msg:{tables:complete}});await flush()
      assert.deepEqual(tables.at(-1).find(t=>t.table_id==='BAV03A').trendBundle,
        {schemaVersion:1,tableId:'BAV03A',shoe:'1648',completedRound:3,status:'available',reason:'complete'})
    })
})

test('missing road baseline never publishes a fabricated complete-through watermark', async () => {
  const initial=completeCatalog(); initial.find(t=>t.table_id==='BAV03A').trend.big2=''
  await exerciseBundle(initial,{table_id:'BAV03A',room_id:51,shoe:1648,round:2,result:'1,2,3,4,0,0,0,0,4,6'}, async ({tables,finals})=>{
    assert.equal(finals.length,1)
    const row=tables.at(-1).find(t=>t.table_id==='BAV03A')
    assert.equal(row.round,2)
    assert.equal(row.trendBundle.status,'pending')
    assert.equal(row.trendBundle.completedRound,null)
  })
})

test('synthetic Final immediately publishes coherent same-round stats and roads before provider refresh', async () => {
  const sockets = new Map(), tables = [], finals = [], errors = []
  const lease = { mode: 'api', ownerId: 'synthetic-owner', epoch: 1, fence: 'synthetic-fence' }
  const client = createMtApiClient({
    sourceOwner: { lease: () => lease, assertCurrent: () => true, eventSource: sequence => ({ ...lease, sequence }) },
    sessionManager: { getSessionToken: async () => 'synthetic-not-a-credential' },
    createSocket: (_url, options) => { const socket = new OfflineSocket(); sockets.set(options.kind, socket); return socket },
    onTables: async value => tables.push(structuredClone(value)),
    onFinal: async value => finals.push(structuredClone(value)),
    onError: value => errors.push(value),
    connectTimeoutMs: 0, authenticateTimeoutMs: 0,
    setIntervalFn: () => null, clearIntervalFn: () => {},
    now: () => 1792976400000,
  })
  try {
    await client.start()
    for (const socket of sockets.values()) socket.open()
    const game = sockets.get('game'), chat = sockets.get('chat')
    game.receive({ action: '/api/v1/authenticate', err: 0 })
    chat.receive({ action: '/api/v1/chat/authenticate', err: 0 })
    game.receive({ msg: { tables: syntheticCatalog() } })
    await flush()
    game.receive({ action: '/api/v1/gametype/*/game/*/room/*/mulitple_join', err: 0 })
    await flush()
    assert.equal(client.snapshot().joined, true)
    const before = tables.at(-1)
    assert.equal(before.length, 6)
    game.receive({
      action: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
      body: { table_id: 'BAV03A', room_id: 51, shoe: 1648, round: 2,
        result: '1,2,3,4,0,0,0,0,4,6' },
    })
    await flush()
    assert.deepEqual(errors, [])
    assert.equal(finals.length, 1, 'Final delivery must not wait for provider tables')
    assert.equal(finals[0].winner, 'banker')
    const after = tables.at(-1)
    const current = after.find(table => table.table_id === 'BAV03A')
    assert.equal(current.round, 2, 'completed screen must not be delayed or rewound')
    assert.deepEqual(after.filter(table => table.table_id !== 'BAV03A'), before.filter(table => table.table_id !== 'BAV03A'))
    const trend = current.trend
    // One aggregate assertion preserves the complete observed stale bundle in the RED log.
    assert.deepEqual({
      completed: Number(trend.total_round),
      banker: Number(trend.total_round_banker), player: Number(trend.total_round_player), tie: Number(trend.total_round_tie),
      beadOutcomes: (trend.bead_plate2.match(/\d{2}/g) ?? []).map(code => code[1]),
      bigOutcomes: trend.big2.split(/[#,]/).filter(Boolean).map(code => code.at(-1)),
      bigPoints: trend.big2.split(/[#,]/).filter(Boolean).map(code => Number(code[1])),
    }, { completed: 2, banker: 1, player: 1, tie: 0, beadOutcomes: ['1', '2'], bigOutcomes: ['1', '2'], bigPoints: [8, 6] },
    'Final progress and the complete stats/road bundle must describe the same completed round')
    game.receive({ msg: { tables: syntheticCatalog() } })
    await flush()
    assert.deepEqual(tables.at(-1).find(table => table.table_id === 'BAV03A').trend, trend, 'late provider baseline cannot overwrite projection')
    game.receive({ action: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
      body: { table_id: 'BAV03A', room_id: 51, shoe: 1648, round: 2, result: '1,2,3,4,0,0,0,0,4,6' } })
    await flush()
    assert.deepEqual(tables.at(-1).find(table => table.table_id === 'BAV03A').trend, trend, 'duplicate does not add a second road cell')
    const enriched = syntheticCatalog().map(table => table.table_id === 'BAV03A'
      ? { ...table, game_name: '20261026_1648_3', trend: { ...structuredClone(trend), providerConfirmation: 'synthetic-confirmed' } } : table)
    game.receive({ msg: { tables: enriched } })
    await flush()
    assert.equal(tables.at(-1).find(table => table.table_id === 'BAV03A').trend.providerConfirmation, 'synthetic-confirmed')
  } finally { client.stop() }
})
