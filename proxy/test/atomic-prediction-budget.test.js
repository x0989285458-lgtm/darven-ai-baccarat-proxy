import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { buildLivePrediction } from '../src/supabase-writer.js'

for (const mode of ['missing', 'hung-last-read']) test(`${mode} still fails closed within the original deadline and five reads`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1793166533000 })
  const start = Date.now()
  let reads = 0, release
  const held = new Promise(resolve => { release = resolve })
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000, supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('no write'),
      readIssuedPrediction: async () => { reads++; return mode === 'hung-last-read' && reads === 5 ? held : null },
    },
  })
  t.after(async () => { release(null); await app.stop() })
  app.state.setTables([{ tableId: 'BAV03', shoe: 1709, round: 42, roundBasis: 'completed' }])
  let completedAt
  const response = app.inject({ url: '/api/tables' }).then(result => { completedAt = Date.now() - start; return result })
  const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve() }
  await flush()
  for (let n = 0; n < 100; n++) { t.mock.timers.tick(10); await flush() }
  assert.equal(JSON.parse((await response).body)[0].prediction, null)
  assert.equal(reads, 5)
  assert.ok(completedAt <= 1000)
  release(null)
  await flush()
})

test('real SSE publishes exact readiness inside the same 1000ms window without an initial null', { timeout: 5000 }, async t => {
  const table = { tableId: 'BAV03', shoe: 1709, round: 42, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString() }
  const exact = { ...buildLivePrediction(table), predictionId: 'durable-SSE-43', issuedAt: new Date().toISOString() }
  let start, reads = 0
  const app = createApp({ autoConnect: false, port: 0, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000, supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('no write'),
      readIssuedPrediction: async () => { start ??= Date.now(); reads++; return Date.now() - start >= 800 ? exact : null },
    },
  })
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await app.stop() })
  app.state.setTables([table])
  await app.start()
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/tables/stream`, { signal: controller.signal })
  const reader = response.body.getReader()
  let text = ''
  while (!text.includes('\n\n')) { const { value, done } = await reader.read(); assert.equal(done, false); text += new TextDecoder().decode(value) }
  const payload = JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5))
  assert.equal(payload.tables[0].prediction?.targetRound, 43)
  assert.ok(reads <= 5)
})

test('confirmed missing must not exhaust all reads before exact readiness inside the 1000ms budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1793166533000 })
  const start = Date.now()
  const table = { tableId: 'BAV03', shoe: 1709, round: 42, roundBasis: 'completed', sourceUpdatedAt: new Date().toISOString() }
  const exact = { ...buildLivePrediction(table), predictionId: 'durable-BAV03-43', issuedAt: new Date().toISOString() }
  const reads = []
  const app = createApp({ autoConnect: false, captureRoundBasis: 'completed', captureOutboxConsumerEnabled: false,
    livePredictionReadWaitMs: 1000, supabaseClient: { configured: true,
      issuePrediction: async () => assert.fail('no write'),
      readIssuedPrediction: async () => { reads.push(Date.now() - start); return Date.now() - start >= 800 ? exact : null },
    },
  })
  t.after(() => app.stop())
  app.state.setTables([table])
  const response = app.inject({ url: '/api/tables' })
  const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve() }
  await flush()
  for (let n = 0; n < 100; n++) { t.mock.timers.tick(10); await flush() }
  const row = JSON.parse((await response).body)[0]
  assert.ok(reads.length <= 5, 'retain hard read limit')
  assert.equal(row.round, 43)
  assert.equal(row.prediction?.targetRound, 43, `exact ready at 800ms inside 1000ms; actual reads ${reads.join(',')}`)
})
