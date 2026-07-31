import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryLeaseStore, createWorkerSourceOwner } from '../src/worker-source-owner.js'
import { createBrowserSourceRuntime } from '../src/browser-source-runtime.js'

test('browser cold takeover renews beyond fifteen seconds and can still allocate the next event source', async () => {
  let nowMs = 0
  let renewalTick
  const store = createMemoryLeaseStore()
  const api = createWorkerSourceOwner({ store, ownerId: 'api-primary', mode: 'api', now: () => nowMs, leaseMs: 15_000, createFence: () => 'api-fence' })
  await api.acquire()
  await api.stop()
  const previous = await store.read()
  const browser = createWorkerSourceOwner({ store, ownerId: 'browser-cold', mode: 'browser', now: () => nowMs, leaseMs: 15_000, createFence: () => 'browser-fence' })
  const runtime = createBrowserSourceRuntime({
    sourceOwner: browser, previousLease: previous, renewalMs: 5_000,
    setIntervalFn: (fn) => { renewalTick = fn; return fn }, clearIntervalFn: () => {}, stopSocket: async () => {},
  })
  await runtime.start()
  for (const elapsed of [5_000, 10_000, 15_000, 20_000]) {
    nowMs = elapsed
    await renewalTick()
  }
  const source = await runtime.nextEventSource()
  assert.deepEqual(source, { mode: 'browser', ownerId: 'browser-cold', epoch: 2, fence: 'browser-fence', sequence: 1 })
  assert.ok((await store.read()).expiresAt > 20_000)
  await runtime.stop()
})

test('browser cold stop clears renewal and socket before stopping the lease', async () => {
  const order = []
  const lease = { mode: 'browser', ownerId: 'browser-cold', epoch: 2, fence: 'browser-fence', status: 'active', expiresAt: 99_999 }
  const runtime = createBrowserSourceRuntime({
    sourceOwner: {
      takeover: async () => { order.push('takeover'); return lease }, lease: () => lease,
      renew: async () => lease, nextEventSource: async () => ({ ...lease, sequence: 1 }),
      stop: async () => { order.push('lease-stop') },
    },
    previousLease: { status: 'stopped' },
    setIntervalFn: () => 'timer', clearIntervalFn: () => { order.push('renew-stop') },
    stopSocket: async () => { order.push('socket-stop') },
  })
  await runtime.start()
  await runtime.stop()
  assert.deepEqual(order, ['takeover', 'renew-stop', 'socket-stop', 'lease-stop'])
})
