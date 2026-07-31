import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileLeaseStore, createMemoryLeaseStore, createWorkerSourceOwner } from '../src/worker-source-owner.js'

test('API is the sole initial owner and a live lease rejects a second join owner', async () => {
  let now = 1_000
  const store = createMemoryLeaseStore()
  const api = createWorkerSourceOwner({ store, ownerId: 'api-primary', mode: 'api', now: () => now, leaseMs: 500 })
  const browser = createWorkerSourceOwner({ store, ownerId: 'browser-cold', mode: 'browser', now: () => now, leaseMs: 500 })

  const lease = await api.acquire()
  assert.deepEqual(api.eventSource(7), {
    mode: 'api', ownerId: 'api-primary', epoch: 1, fence: lease.fence, sequence: 7,
  })
  await assert.rejects(browser.acquire(), /source_owner_lease_held/)
})

test('browser cold takeover requires API stop and atomically advances epoch and fence', async () => {
  let now = 2_000
  const store = createMemoryLeaseStore()
  const api = createWorkerSourceOwner({ store, ownerId: 'api-primary', mode: 'api', now: () => now, leaseMs: 500 })
  const browser = createWorkerSourceOwner({ store, ownerId: 'browser-cold', mode: 'browser', now: () => now, leaseMs: 500 })

  const first = await api.acquire()
  await assert.rejects(browser.takeover({ previous: first }), /source_owner_not_stopped/)
  const stopped = await api.stop()
  const second = await browser.takeover({ previous: stopped })

  assert.equal(second.epoch, 2)
  assert.notEqual(second.fence, first.fence)
  assert.equal(second.mode, 'browser')
  assert.equal((await store.read()).ownerId, 'browser-cold')
  assert.throws(() => api.assertCurrent(first), /stale_source_fence/)
})

test('expired lease still requires an explicit stopped transition before browser takeover', async () => {
  let now = 3_000
  const store = createMemoryLeaseStore()
  const api = createWorkerSourceOwner({ store, ownerId: 'api-primary', mode: 'api', now: () => now, leaseMs: 100 })
  const browser = createWorkerSourceOwner({ store, ownerId: 'browser-cold', mode: 'browser', now: () => now, leaseMs: 100 })

  const first = await api.acquire()
  now += 101
  await assert.rejects(browser.takeover({ previous: first }), /source_owner_not_stopped/)
})

test('file lease store serializes competing acquisition and survives a fresh reader', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-source-owner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const leasePath = path.join(dir, 'source-owner.json')
  const first = createWorkerSourceOwner({ store: createFileLeaseStore(leasePath), ownerId: 'api-a', mode: 'api' })
  const second = createWorkerSourceOwner({ store: createFileLeaseStore(leasePath), ownerId: 'api-b', mode: 'api' })

  const results = await Promise.allSettled([first.acquire(), second.acquire()])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1)

  const persisted = await createFileLeaseStore(leasePath).read()
  assert.equal(persisted.status, 'active')
  assert.equal(persisted.epoch, 1)
})

test('file lease store recovers an orphan lock only when PID start identity proves reuse', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-owner-orphan-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const leasePath = path.join(dir, 'source-owner.json')
  await writeFile(`${leasePath}.lock`, JSON.stringify({
    version: 1, lockId: 'orphan-lock', pid: 42, processStartIdentity: 'container-start-old', createdAt: 100,
  }))
  const store = createFileLeaseStore(leasePath, {
    lockRetryMs: 1, lockTimeoutMs: 20,
    processIdentity: async () => ({ pid: 7, processStartIdentity: 'current-start' }),
    inspectProcessIdentity: async (pid) => pid === 42 ? 'container-start-new' : null,
  })

  const saved = await store.transact(() => ({ epoch: 1 }))
  assert.deepEqual(saved, { epoch: 1 })
  assert.deepEqual(await store.read(), { epoch: 1 })
})

test('file lease store never steals a live, corrupt, or unprovable new lock', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-owner-live-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, contents, inspectProcessIdentity] of [
    ['live', JSON.stringify({ version: 1, lockId: 'live-lock', pid: 42, processStartIdentity: 'live-start', createdAt: 100 }), async () => 'live-start'],
    ['corrupt', '{', async () => null],
    ['new', '', async () => undefined],
  ]) {
    const leasePath = path.join(dir, `${name}.json`)
    await writeFile(`${leasePath}.lock`, contents)
    const store = createFileLeaseStore(leasePath, {
      lockRetryMs: 1, lockTimeoutMs: 5,
      processIdentity: async () => ({ pid: 7, processStartIdentity: 'current-start' }),
      inspectProcessIdentity,
    })
    await assert.rejects(store.transact(() => ({ epoch: 1 })), /source_owner_lock_timeout/)
    assert.equal(await readFile(`${leasePath}.lock`, 'utf8'), contents)
  }
})

test('file lease store removes its new lock when process identity creation fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-owner-identity-failure-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const leasePath = path.join(dir, 'source-owner.json')
  const store = createFileLeaseStore(leasePath, {
    processIdentity: async () => { throw new Error('identity_unavailable') },
  })
  await assert.rejects(store.transact(() => ({ epoch: 1 })), /identity_unavailable/)
  await assert.rejects(access(`${leasePath}.lock`), /ENOENT/)
})

test('event sequence is atomically allocated in the lease store and survives owner recreation', async () => {
  const store = createMemoryLeaseStore()
  const first = createWorkerSourceOwner({ store, ownerId: 'api-primary', mode: 'api' })
  await first.acquire()
  assert.equal((await first.nextEventSource()).sequence, 1)
  assert.equal((await first.nextEventSource()).sequence, 2)

  const restored = createWorkerSourceOwner({ store, ownerId: 'api-primary', mode: 'api' })
  restored.restore(await store.read())
  assert.equal((await restored.nextEventSource()).sequence, 3)
})

test('API restart recovers only an expired lease by advancing epoch and fencing the dead owner', async () => {
  let now = 5_000
  let fenceNumber = 0
  const store = createMemoryLeaseStore()
  const options = { store, ownerId: 'api-primary', mode: 'api', now: () => now, leaseMs: 100, createFence: () => `fence-${++fenceNumber}` }
  const dead = createWorkerSourceOwner(options)
  const first = await dead.acquire()
  const early = createWorkerSourceOwner(options)
  await assert.rejects(early.acquireOrRecover(), /source_owner_lease_held/)

  now += 101
  const restarted = createWorkerSourceOwner(options)
  const recovered = await restarted.acquireOrRecover()
  assert.equal(recovered.epoch, 2)
  assert.notEqual(recovered.fence, first.fence)
  await assert.rejects(dead.nextEventSource(first), /stale_source_fence/)
})
