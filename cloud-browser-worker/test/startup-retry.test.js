import test from 'node:test'
import assert from 'node:assert/strict'
import { createRetryingStartup } from '../src/startup-retry.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('startup retries transient failures with bounded backoff then calls ready exactly once', async () => {
  let attempts = 0
  let readyCalls = 0
  const delays = []
  const timers = []
  const controller = createRetryingStartup({
    start: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('temporary source startup failure')
    },
    onReady: async () => { readyCalls += 1 },
    onError: async () => {},
    baseDelayMs: 10,
    maxDelayMs: 15,
    setTimer: (callback, delay) => {
      delays.push(delay)
      timers.push(callback)
      return callback
    },
    clearTimer: () => {},
  })

  assert.equal(await controller.begin(), false)
  assert.deepEqual(delays, [10])
  timers.shift()()
  await flush()
  assert.deepEqual(delays, [10, 15])
  timers.shift()()
  await flush()

  assert.equal(attempts, 3)
  assert.equal(readyCalls, 1)
  assert.equal(controller.snapshot().ready, true)
  assert.equal(await controller.begin(), false)
  assert.equal(attempts, 3)
  assert.equal(readyCalls, 1)
})

test('startup stop cancels scheduled retry and suppresses later work', async () => {
  let attempts = 0
  let scheduled = null
  let cleared = null
  const controller = createRetryingStartup({
    start: async () => { attempts += 1; throw new Error('temporary') },
    setTimer: (callback) => { scheduled = callback; return callback },
    clearTimer: (timer) => { cleared = timer },
  })

  assert.equal(await controller.begin(), false)
  assert.equal(typeof scheduled, 'function')
  await controller.stop()
  assert.equal(cleared, scheduled)
  scheduled()
  await flush()
  assert.equal(attempts, 1)
  assert.equal(controller.snapshot().stopped, true)
  assert.equal(controller.snapshot().retryScheduled, false)
})

test('stop waits for an in-flight startup and suppresses ready before shutdown continues', async () => {
  let release
  let readyCalls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const controller = createRetryingStartup({
    start: async () => { await gate; return { started: true } },
    onReady: async () => { readyCalls += 1 },
  })

  const begin = controller.begin()
  let stopSettled = false
  const stop = controller.stop().then(() => { stopSettled = true })
  await flush()
  assert.equal(stopSettled, false)
  release()
  await stop
  assert.equal(await begin, false)
  assert.equal(readyCalls, 0)
  assert.equal(controller.snapshot().inFlight, false)
})

test('concurrent begin calls share one startup attempt', async () => {
  let release
  let attempts = 0
  const gate = new Promise((resolve) => { release = resolve })
  const controller = createRetryingStartup({
    start: async () => { attempts += 1; await gate },
  })
  const first = controller.begin()
  const second = controller.begin()
  assert.equal(first, second)
  release()
  assert.equal(await first, true)
  assert.equal(attempts, 1)
})
