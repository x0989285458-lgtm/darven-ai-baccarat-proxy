import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createOutboxProcessClient } from '../src/outbox-process-client.js'

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

test('wake fail-closes into one restart path after the isolated child exits', async () => {
  const children = [fakeChild(), fakeChild()]
  let index = 0
  const client = createOutboxProcessClient({
    forkImpl() {
      const child = children[index++]
      queueMicrotask(() => child.emit('message', { type: 'ready' }))
      return child
    },
    startupTimeoutMs: 100,
  })
  await client.start()
  children[0].connected = false
  children[0].exitCode = 70
  children[0].emit('exit', 70, null)
  assert.equal(client.wake(), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(index, 2)
  assert.deepEqual(children[1].sent, [{ type: 'wake' }])
})
