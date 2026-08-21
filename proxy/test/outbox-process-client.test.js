import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createOutboxProcessClient, DEFAULT_OUTBOX_PROCESS_STARTUP_TIMEOUT_MS } from '../src/outbox-process-client.js'

test('production parent delegates startup drain and worker self-drains', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('../src/outbox-process-worker.js', import.meta.url), 'utf8')
  assert.match(server, /if \(!outboxProcessClient && isolatedShadowProcess\)/)
  assert.match(server, /if \(!outboxProcessClient && v104Formal/)
  assert.match(server, /\? \{ notify: false, inferRounds: false \}/)
  assert.match(server, /if \(!outboxProcessClient\) \{[\s\S]*v103Shadow[\s\S]*v105ShadowV10/)
  assert.match(server, /if \(outboxProcessClient\) \{[\s\S]*outboxProcessClient\.wake\(\)[\s\S]*\} else \{[\s\S]*drainCaptureOutbox\(\)/)
  assert.match(worker, /process\.send\?\.\(\{ type: 'ready' \}\)[\s\S]*void drain\(\)/)
  assert.match(worker, /await app\.start\(\)[\s\S]*process\.send\?\.\(\{ type: 'ready' \}\)/)
})

test('real delayed child can finish bounded initialization before readiness timeout', async () => {
  assert.ok(DEFAULT_OUTBOX_PROCESS_STARTUP_TIMEOUT_MS > 245000)
  const client = createOutboxProcessClient({
    workerPath: fileURLToPath(new URL('./fixtures/delayed-outbox-ready-worker.js', import.meta.url)),
    startupTimeoutMs: 1000,
    stopTimeoutMs: 1000,
  })
  const startedAt = Date.now()
  const status = await client.start()
  assert.equal(status.ready, true)
  assert.ok(Date.now() - startedAt >= 100)
  assert.deepEqual(await client.stop(), { stopped: true })
})

function fakeChild() {
  const child = new EventEmitter()
  child.connected = true
  child.exitCode = null
  child.signalCode = null
  child.sent = []
  child.send = (message) => { child.sent.push(message) }
  child.kill = () => { child.connected = false; child.exitCode = 0; child.emit('exit', 0, null) }
  return child
}

test('isolated outbox client starts, coalesces wakes in child, and stops with readback', async () => {
  const child = fakeChild()
  let forkCalls = 0
  const client = createOutboxProcessClient({
    forkImpl() { forkCalls += 1; queueMicrotask(() => child.emit('message', { type: 'ready' })); return child },
    startupTimeoutMs: 100,
    stopTimeoutMs: 100,
  })

  const ready = await client.start()
  assert.equal(ready.ready, true)
  assert.equal(forkCalls, 1)
  assert.equal(client.wake(), true)
  assert.equal(client.wake(), true)
  assert.deepEqual(child.sent, [{ type: 'wake' }, { type: 'wake' }])
  const stopping = client.stop()
  assert.deepEqual(child.sent.at(-1), { type: 'stop' })
  child.emit('exit', 0, null)
  assert.deepEqual(await stopping, { stopped: true })
  assert.equal(client.status().running, false)
})

test('isolated child exit restarts and drains without another producer wake', async () => {
  const children = [fakeChild(), fakeChild()]
  let index = 0
  const client = createOutboxProcessClient({
    forkImpl() {
      const child = children[index++]
      queueMicrotask(() => child.emit('message', { type: 'ready' }))
      return child
    },
    startupTimeoutMs: 100,
    restartBaseDelayMs: 1,
    restartMaxDelayMs: 1,
  })
  await client.start()
  children[0].connected = false
  children[0].exitCode = 70
  children[0].emit('exit', 70, null)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(index, 2)
  assert.deepEqual(children[1].sent, [{ type: 'wake' }])
  const stopping = client.stop()
  children[1].emit('exit', 0, null)
  await stopping
})


test('repeated ready-then-crash failures retain exponential restart backoff until stable', async () => {
  const keeper = setInterval(() => {}, 1000)
  const startedAt = []
  const children = []
  let resolveFourth
  const fourth = new Promise((resolve) => { resolveFourth = resolve })
  const client = createOutboxProcessClient({
    restartBaseDelayMs: 20,
    restartMaxDelayMs: 80,
    restartStableMs: 1000,
    startupTimeoutMs: 100,
    stopTimeoutMs: 100,
    forkImpl() {
      const child = fakeChild()
      children.push(child)
      startedAt.push(Date.now())
      queueMicrotask(() => {
        child.emit('message', { type: 'ready' })
        if (children.length < 4) {
          setTimeout(() => {
            child.connected = false
            child.exitCode = 70
            child.emit('exit', 70, null)
          }, 1)
        } else resolveFourth()
      })
      return child
    },
  })
  await client.start()
  await fourth
  const gaps = startedAt.slice(1).map((value, index) => value - startedAt[index])
  assert.equal(gaps.length, 3)
  assert.ok(gaps[1] - gaps[0] >= 10, `second backoff did not increase: ${gaps}`)
  assert.ok(gaps[2] - gaps[1] >= 20, `third backoff did not increase: ${gaps}`)
  const stopping = client.stop()
  children.at(-1).emit('exit', 0, null)
  await stopping
  clearInterval(keeper)
})
