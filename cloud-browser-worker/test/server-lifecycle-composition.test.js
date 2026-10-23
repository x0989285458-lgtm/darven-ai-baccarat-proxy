import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createMtApiClient } from '../src/mt-api-client.js'
import { createFinalJournal } from '../src/final-journal.js'
import { createGapDetector } from '../src/gap-detector.js'
import { createMemoryLeaseStore, createWorkerSourceOwner } from '../src/worker-source-owner.js'
import { createWorkerSourceRuntime } from '../src/worker-source-runtime.js'
import catalog from './fixtures/api-live-catalog.json' with { type: 'json' }

async function productionFactory({ owner, sessionManager, WebSocket, clientFactory = createMtApiClient, errors = [] }) {
  const text = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  const section = text.slice(text.indexOf('async function ensureSourceRuntime()'), text.indexOf('async function readOptionalJson'))
  const start = section.indexOf('createApiClient: ') + 'createApiClient: '.length
  const end = section.indexOf('\n    })', start)
  assert.ok(start > 0 && end > start)
  const expression = section.slice(start, end).trim().replace(/,$/, '')
  return new Function('createMtApiClient', 'owner', 'sessionManager', 'WebSocket', 'redactUrlSecrets',
    `let lastError = null; return (${expression});`)(clientFactory, owner, sessionManager, WebSocket, x => { errors.push(x); return x })
}

test('actual production API factory preserves durable lifecycle bootstrap and transition callbacks', async () => {
  let received
  const factory = await productionFactory({ owner: {}, sessionManager: {}, WebSocket: class {}, clientFactory: x => { received = x; return x } })
  const options = { onFinal: async () => {}, onTables: async () => {}, initialShoeLifecycles: [{ tableId: 'BAV01', activeShoe: 91 }], onShoeLifecycleTransition: async () => {} }
  factory(options)
  for (const key of Object.keys(options)) assert.equal(received[key], options[key], key)
})

test('production factory plus real runtime and restored journal admit new-shoe Final without dropping retired protection', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-wiring-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const owner = createWorkerSourceOwner({ store: createMemoryLeaseStore(), ownerId: 'wiring-test', mode: 'api' })
  await owner.acquire()
  const journalPath = path.join(dir, 'journal.jsonl')
  const original = await createFinalJournal({ journalPath })
  const source = await owner.nextEventSource()
  const event = { tableId: 'BAV01', shoe: 91, round: 8, winner: 'banker', sourceAction: 'summary', final: true, rawResult: [1,2,3,4,0,0,0,0,4,6], playerPoint:4, bankerPoint:6, source,
    shoeLifecycle: { tableId:'BAV01',activeShoe:91,retiredShoes:[90],currentScreen:{shoe:91,round:8},origin:'final',source } }
  const saved = await original.append(event); await original.ack(saved.identity, saved.hash)
  await owner.stop()
  const journal = await createFinalJournal({ journalPath })
  const sockets = [], errors = []
  class Socket extends EventEmitter {
    constructor(url) { super(); this.kind=url.includes('/chat/')?'chat':'game';this.sent=[];sockets.push(this) }
    send(body) { this.sent.push(JSON.parse(body)) }
    close() {}
  }
  const factory = await productionFactory({ owner, sessionManager:{getSessionToken:async()=> 'offline-token'}, WebSocket:Socket, errors })
  const runtime = createWorkerSourceRuntime({ sourceOwner:owner,journal,gapDetector:createGapDetector(),allowGapDelivery:true,
    replayProvider:{replay:async()=>({ok:false,events:[],liveGate:'offline'})},createApiClient:factory })
  t.after(()=>runtime.stop())
  await runtime.start()
  const send=(kind,p)=>sockets.find(x=>x.kind===kind).emit('message',JSON.stringify(p))
  const flush=async()=>{for(let i=0;i<25;i++)await new Promise(r=>setTimeout(r,2))}
  for(const socket of sockets){socket.readyState=1;socket.emit('open')}
  send('game',{action:'/api/v1/authenticate',err:0});send('chat',{action:'/api/v1/chat/authenticate',err:0});await flush()
  const tables=structuredClone(catalog)
  for(const table of tables)if(table.table_id==='BAV01'){delete table.shoe;delete table.round;table.trend={current_shoe:93,current_round:4,total_round:3};table.game_name='20261023_93_4'}
  send('game',{msg:{tables}});await flush()
  send('game',{action:'/api/v1/gametype/*/game/*/room/*/mulitple_join',err:0});send('chat',{action:'/api/v1/chat/room/*/table/*/join',err:0});await flush()
  assert.equal(journal.shoeLifecycle('BAV01').activeShoe,93,'provider lifecycle persisted before Final')
  assert.ok(journal.shoeLifecycle('BAV01').retiredShoes.includes(91))
  send('game',{action:'/api/v1/gametype/3/game/1/room/48/table/BAV01/summary',body:{table_id:'BAV01',room_id:48,shoe:93,round:4,result:[1,2,3,4,0,0,0,0,4,6]}});await flush()
  assert.deepEqual(errors,[], 'real composition callback errors')
  assert.deepEqual(journal.pending().map(x=>x.identity),['BAV01:93:4'])
  send('game',{action:'/api/v1/gametype/3/game/1/room/48/table/BAV01/summary',body:{table_id:'BAV01',room_id:48,shoe:91,round:9,result:[1,2,3,4,0,0,0,0,4,6]}});await flush()
  assert.deepEqual(journal.pending().map(x=>x.identity),['BAV01:93:4'])
  assert.deepEqual(errors,[])
  await runtime.acknowledge({acceptedRoundKeys:['BAV01:93:4']})
  assert.equal(journal.cursor('BAV01').shoe,93)
})
