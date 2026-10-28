import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve() }
const table = (tableId) => ({ tableId, shoe: 1709, round: 42, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString() })
const issued = (row) => ({ ...buildLivePrediction(row), predictionId: `durable-${row.tableId}-43`, issuedAt: new Date().toISOString() })

test('real SSE and REST share publication recheck after an earlier shared read deadline', async t => {
  const b = table('BAV03'), a = table('BAV01')
  let releaseB, releaseA, startedA
  const heldB = new Promise(resolve => { releaseB = resolve })
  const heldA = new Promise(resolve => { releaseA = resolve })
  const readingA = new Promise(resolve => { startedA = resolve })
  const app = createApp({ autoConnect: false, port: 0, captureRoundBasis: 'completed',
    captureOutboxConsumerEnabled: false, livePredictionReadWaitMs: 1000, streamHeartbeatMs: 10000,
    supabaseClient: { configured: true, issuePrediction: async () => assert.fail('no write'),
      readIssuedPrediction: ({ tableId }) => { if (tableId === 'BAV01') { startedA(); return heldA }; return heldB },
    },
  })
  const controller = new AbortController()
  t.after(async () => { controller.abort(); releaseB(null); releaseA(null); await app.stop() })
  app.state.setTables([b])
  const early = app.inject({ url: '/api/tables' })
  await new Promise(resolve => setTimeout(resolve, 500))
  app.state.setTables([b, a])
  await app.start()
  const response = fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })
  await readingA
  assert.equal(JSON.parse((await early).body)[0].prediction, null)
  releaseB(issued(b))
  await new Promise(resolve => setImmediate(resolve))
  releaseA(issued(a))
  const reader = (await response).body.getReader()
  let text = ''
  while (!text.includes('\n\n')) { const { value, done } = await reader.read(); assert.equal(done, false); text += new TextDecoder().decode(value) }
  const payload = JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5))
  assert.equal(payload.tables.length, 2)
  assert.equal(payload.tables.find(row => row.tableId === 'BAV03').prediction?.targetRound, 43)
  assert.equal(payload.tables.find(row => row.tableId === 'BAV01').prediction?.targetRound, 43)
  const rest = JSON.parse((await app.inject({ url: '/api/tables' })).body)
  assert.deepEqual(rest.map(row => row.prediction?.predictionId), payload.tables.map(row => row.prediction?.predictionId))
})

test('publication recheck must not restore a prediction to a non-actionable screen', async t => {
  let clock = Date.now()
  const pending = new Map()
  const b = table('BAV03')
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    now: () => clock, predictionTtlMs: 1000, pendingPredictionStore: pending,
    supabaseClient: { configured: true, issuePrediction: async () => assert.fail('no write'),
      readIssuedPrediction: async () => assert.fail('non-actionable screen must not read') },
  })
  t.after(() => app.stop())
  app.state.setTables([b])
  clock += 2000
  pending.set('BAV03:1709:43', { ...issued(b), createdAtMs: clock })
  assert.equal(JSON.parse((await app.inject({ url: '/api/tables' })).body)[0].prediction, null)
})

test('public payload must not serialize an early null after the exact late read has completed during another table wait', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1793166533000 })
  const b = table('BAV03'), a = table('BAV01')
  let releaseB, releaseA
  const heldB = new Promise(resolve => { releaseB = resolve })
  const heldA = new Promise(resolve => { releaseA = resolve })
  const reads = []
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000, supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('public reads must never write'),
      readIssuedPrediction: ({ tableId }) => { reads.push(tableId); return tableId === 'BAV03' ? heldB : heldA },
    },
  })
  t.after(async () => { releaseB(null); releaseA(null); await app.stop() })
  app.state.setTables([b])
  const early = app.inject({ url: '/api/tables' })
  await flush()
  t.mock.timers.tick(500)
  app.state.setTables([b, a])
  const publication = app.inject({ url: '/api/tables' })
  await flush()
  t.mock.timers.tick(500)
  await flush()
  assert.equal(JSON.parse((await early).body)[0].prediction, null, 'genuine deadline remains fail closed')
  t.mock.timers.tick(100)
  releaseB(issued(b))
  await flush()
  t.mock.timers.tick(100)
  releaseA(issued(a))
  await flush()
  const rows = JSON.parse((await publication).body)
  assert.equal(rows.find(row => row.tableId === 'BAV03').prediction?.targetRound, 43,
    'the durable exact read completed before publication: an earlier per-table null is stale')
  assert.equal(rows.find(row => row.tableId === 'BAV01').prediction?.targetRound, 43)
  assert.deepEqual(reads.sort(), ['BAV01', 'BAV03'], 'publication recheck must not add reads')
})
