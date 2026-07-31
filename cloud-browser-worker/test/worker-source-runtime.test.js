import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFinalJournal } from '../src/final-journal.js'
import { createGapDetector } from '../src/gap-detector.js'
import { createMemoryLeaseStore, createWorkerSourceOwner } from '../src/worker-source-owner.js'
import { createWorkerSourceRuntime } from '../src/worker-source-runtime.js'
import { PRODUCTION_TABLE_IDS } from '../src/table-policy.js'

test('runtime starts API as sole owner, journals Final, and advances cursor only after durable ACK', async (t) => {
  const fixture = await runtimeFixture(t)
  await fixture.runtime.start()
  assert.equal(fixture.apiStarts, 1)
  assert.equal(fixture.browserStarts, 0)

  await fixture.handlers.onTables([{ table_id: 'BAG01', shoe: 91, round: 1 }])
  await fixture.handlers.onFinal(await fixture.finalEvent(1))
  const snapshot = await fixture.runtime.getDeliverySnapshot()
  assert.equal(snapshot.source.mode, 'api')
  assert.deepEqual(snapshot.rounds.map((round) => round.round), [1])
  assert.equal(fixture.journal.cursor('BAG01'), null)

  await fixture.runtime.acknowledge({ acceptedRoundKeys: ['BAG01:91:1'] })
  assert.equal(fixture.journal.cursor('BAG01').round, 1)
  assert.deepEqual((await fixture.runtime.getDeliverySnapshot()).rounds, [])
})

test('runtime blocks Live ACK on a gap, replays exact missing Finals first, then resumes live event', async (t) => {
  const replayed = []
  const fixture = await runtimeFixture(t, {
    replayProvider: {
      async replay(gap) {
        replayed.push(gap)
        return { ok: true, provider: 'record', events: gap.rounds.map((round) => fixtureEvent(round)) }
      },
    },
  })
  await fixture.runtime.start()
  const durable = await fixture.journal.append(await fixture.finalEvent(7))
  await fixture.journal.ack(durable.identity, durable.hash)
  await fixture.handlers.onTables([{ table_id: 'BAG01', shoe: 91, round: 11 }])
  await fixture.handlers.onFinal(await fixture.finalEvent(11))

  const replaySnapshot = await fixture.runtime.getDeliverySnapshot()
  assert.deepEqual(replayed[0].rounds, [8, 9, 10])
  assert.deepEqual(replaySnapshot.rounds.map((round) => round.round), [8, 9, 10])
  await fixture.runtime.acknowledge({ acceptedRoundKeys: ['BAG01:91:8', 'BAG01:91:9', 'BAG01:91:10'] })

  const liveSnapshot = await fixture.runtime.getDeliverySnapshot()
  assert.deepEqual(liveSnapshot.rounds.map((round) => round.round), [11])
})

test('operator gap-delivery mode records missing rounds but keeps later Finals journaled and ACKable', async (t) => {
  const fixture = await runtimeFixture(t, { allowGapDelivery: true })
  await fixture.runtime.start()
  const durable = await fixture.journal.append(await fixture.finalEvent(7))
  await fixture.journal.ack(durable.identity, durable.hash)
  await fixture.handlers.onTables([{ table_id: 'BAG01', shoe: 91, round: 9 }])

  await fixture.handlers.onFinal(await fixture.finalEvent(9))
  assert.deepEqual((await fixture.runtime.getDeliverySnapshot()).rounds.map((round) => round.round), [9])
  await fixture.runtime.acknowledge({ acceptedRoundKeys: ['BAG01:91:9'] })

  await fixture.handlers.onFinal(await fixture.finalEvent(11))
  assert.deepEqual((await fixture.runtime.getDeliverySnapshot()).rounds.map((round) => round.round), [11])
  const state = fixture.runtime.snapshot()
  assert.deepEqual(state.gaps, [])
  assert.equal(state.liveGate, null)
  assert.deepEqual(state.bypassedGaps.map((gap) => gap.rounds), [[8], [10]])
})

test('Reviewer P0: durable cursor 7 rejects same-shoe Final 9 before journal append or delivery', async () => {
  const appended = []
  let stopped = false
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1', status: 'active', expiresAt: 10_000 }
  const runtime = createWorkerSourceRuntime({
    sourceOwner: {
      acquireOrRecover: async () => lease, lease: () => lease, assertCurrent: () => true,
      renew: async () => lease, stop: async () => {},
    },
    journal: {
      append: async (event) => { appended.push(event) }, pending: () => [],
      cursor: () => ({ shoe: 91, round: 7, identity: 'BAG01:91:7', hash: 'ack-7' }),
      ack: async () => {},
    },
    gapDetector: createGapDetector(),
    replayProvider: { replay: async () => ({ ok: false, liveGate: 'record_contract_unverified', events: [] }) },
    createApiClient: () => ({ start: async () => {}, stop: () => { stopped = true }, snapshot: () => ({}) }),
  })
  await runtime.start()

  await assert.rejects(runtime.onFinal({ ...fixtureEvent(9), shoe: 91 }), /live_ack_blocked:record_contract_unverified/)

  assert.equal(stopped, true, 'the live API generation must stop accepting ACK-bound work')
  assert.deepEqual(appended, [], 'Final 9 must not reach the append-only journal before round 8 is recovered')
  assert.equal(runtime.snapshot().liveGate, 'record_contract_unverified')
  assert.deepEqual(runtime.snapshot().gaps, [{ type: 'same_shoe', tableId: 'BAG01', shoe: 91, rounds: [8] }])
  await assert.rejects(runtime.getDeliverySnapshot(), /live_ack_blocked:record_contract_unverified/)
})

test('Reviewer P0 empty journal: BAG01 shoe 91 round 9 is gap blocked before append, push, ACK, or cursor advance', async () => {
  const appended = []
  let stopped = false
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1', status: 'active', expiresAt: 10_000 }
  const runtime = createWorkerSourceRuntime({
    sourceOwner: {
      acquireOrRecover: async () => lease, lease: () => lease, assertCurrent: () => true,
      renew: async () => lease, stop: async () => {},
    },
    journal: {
      append: async (event) => { appended.push(event) }, pending: () => [], cursor: () => null,
      status: () => null, ack: async () => { throw new Error('ACK must not run') },
    },
    gapDetector: createGapDetector(),
    replayProvider: { replay: async () => ({ ok: false, liveGate: 'journal_cursor_baseline_missing', events: [] }) },
    createApiClient: () => ({ start: async () => {}, stop: () => { stopped = true }, snapshot: () => ({}) }),
  })
  await runtime.start()

  await assert.rejects(runtime.onFinal({ ...fixtureEvent(9), shoe: 91 }), /live_ack_blocked:journal_cursor_baseline_missing/)
  assert.deepEqual(appended, [])
  assert.equal(stopped, true)
  assert.equal(runtime.snapshot().liveGate, 'journal_cursor_baseline_missing')
  assert.deepEqual(runtime.snapshot().gaps, [{ type: 'baseline_missing', tableId: 'BAG01', shoe: 91, rounds: [1, 2, 3, 4, 5, 6, 7, 8] }])
  await assert.rejects(runtime.getDeliverySnapshot(), /live_ack_blocked:journal_cursor_baseline_missing/)
})

test('operator-approved fresh baseline accepts first observed Final, then restores gap fail-closed after ACK', async (t) => {
  const fixture = await runtimeFixture(t, { allowFreshBaseline: true })
  await fixture.runtime.start()
  await fixture.handlers.onTables([{ table_id: 'BAG01' }])
  await fixture.handlers.onFinal(await fixture.finalEvent(9))
  assert.deepEqual((await fixture.runtime.getDeliverySnapshot()).rounds.map((round) => round.round), [9])
  await fixture.runtime.acknowledge({ acceptedRoundKeys: ['BAG01:91:9'] })
  await assert.rejects(fixture.handlers.onFinal(await fixture.finalEvent(11)), /live_ack_blocked:/)
})

test('fresh baseline warmup discards join replay before accepting the first new live Final', async (t) => {
  let clock = 1_000
  const fixture = await runtimeFixture(t, {
    allowFreshBaseline: true, freshBaselineWarmupMs: 5_000, clockMs: () => clock,
  })
  await fixture.runtime.start()
  clock = 10_000
  await fixture.handlers.onFinal(await fixture.finalEvent(9))
  assert.deepEqual((await fixture.runtime.getDeliverySnapshot()).rounds, [])
  clock = 15_001
  await fixture.handlers.onFinal(await fixture.finalEvent(10))
  assert.deepEqual((await fixture.runtime.getDeliverySnapshot()).rounds.map((round) => round.round), [10])
})

test('Reviewer P0 empty journal: round 1 is the only accepted new-shoe baseline', async () => {
  const appended = []
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1', status: 'active', expiresAt: 10_000 }
  const runtime = createWorkerSourceRuntime({
    sourceOwner: {
      acquireOrRecover: async () => lease, lease: () => lease, assertCurrent: () => true,
      renew: async () => lease, stop: async () => {},
    },
    journal: { append: async (event) => { appended.push(event) }, pending: () => [], cursor: () => null, status: () => null, ack: async () => {} },
    gapDetector: createGapDetector(), replayProvider: { replay: async () => ({ ok: false, events: [] }) },
    createApiClient: () => ({ start: async () => {}, stop: () => {}, snapshot: () => ({}) }),
  })
  await runtime.start()
  await runtime.onFinal({ ...fixtureEvent(1), shoe: 91 })
  assert.deepEqual(appended.map(({ shoe, round }) => [shoe, round]), [[91, 1]])
})

test('Reviewer P0 exact-ACK bootstrap 7 persists without forging Final/ACK and permits 8 but blocks 9', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-bootstrap-cursor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journalPath = path.join(dir, 'finals.jsonl')
  const journal = await createFinalJournal({ journalPath, assertSource: () => true })

  await journal.bootstrapFromSnapshotPusherCursor({
    version: 3, initialized: true,
    observedRoundKeys: ['BAG01:91:7', 'BAG01:91:8'],
    acknowledgedRoundKeys: ['BAG01:91:7'],
  })
  assert.deepEqual(journal.cursor('BAG01'), {
    shoe: 91, round: 7, identity: 'BAG01:91:7', origin: 'snapshot-pusher-exact-ack-cursor',
  })
  assert.equal(journal.status('BAG01:91:7'), null, 'bootstrap cannot forge a Final or ACK record')
  const records = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  assert.deepEqual(records.map(({ type }) => type), ['cursor_bootstrap'])
  assert.equal(records[0].origin, 'snapshot-pusher-exact-ack-cursor')

  const fixture = await runtimeFixture(t)
  const bootstrappedRuntime = createWorkerSourceRuntime({
    sourceOwner: fixture.owner, journal, gapDetector: createGapDetector(),
    replayProvider: { replay: async () => ({ ok: false, liveGate: 'record_contract_unverified', events: [] }) },
    createApiClient: () => ({ start: async () => {}, stop: () => {}, snapshot: () => ({}) }),
  })
  await bootstrappedRuntime.start()
  await bootstrappedRuntime.onFinal(await fixture.finalEvent(7))
  assert.deepEqual(journal.pending(), [], 'an exact-ACK bootstrap duplicate must not be appended or pushed again')
  await bootstrappedRuntime.onFinal(await fixture.finalEvent(8))
  await assert.rejects(bootstrappedRuntime.onFinal(await fixture.finalEvent(9)), /live_ack_blocked:bootstrap_cursor_ack_required/)
  assert.equal(bootstrappedRuntime.snapshot().liveGate, 'bootstrap_cursor_ack_required')
  assert.deepEqual(journal.pending().map(({ event }) => event.round), [8])

  const restored = await createFinalJournal({ journalPath, assertSource: () => true })
  assert.deepEqual(restored.cursor('BAG01'), journal.cursor('BAG01'), 'restart must restore the durable bootstrap cursor')
  assert.equal(restored.status('BAG01:91:7'), null)
})

test('Reviewer P0 bootstrap rejects malformed or merely observed/unproven cursor identities', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-bootstrap-reject-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  await assert.rejects(journal.bootstrapFromSnapshotPusherCursor({
    version: 3, initialized: true, observedRoundKeys: ['BAG01:91:7'], acknowledgedRoundKeys: [],
  }), /snapshot_pusher_exact_ack_cursor_unproven/)
  await assert.rejects(journal.bootstrapFromSnapshotPusherCursor({
    version: 3, initialized: true, observedRoundKeys: [], acknowledgedRoundKeys: ['BAG01:not-a-shoe:7'],
  }), /snapshot_pusher_exact_ack_cursor_invalid/)
  assert.equal(journal.cursor('BAG01'), null)
})

test('Reviewer P0: only cursor plus one and exact ACKed duplicate are accepted; unknown cross-shoe Final blocks', async () => {
  const appended = []
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1', status: 'active', expiresAt: 10_000 }
  let cursor = { shoe: 91, round: 7, identity: 'BAG01:91:7', hash: 'ack-7' }
  const runtime = createWorkerSourceRuntime({
    sourceOwner: {
      acquireOrRecover: async () => lease, lease: () => lease, assertCurrent: () => true,
      renew: async () => lease, stop: async () => {},
    },
    journal: {
      append: async (event) => { appended.push(event); return { status: 'appended' } }, pending: () => [],
      cursor: () => structuredClone(cursor), ack: async () => {},
    },
    gapDetector: createGapDetector(),
    replayProvider: { replay: async () => ({ ok: false, liveGate: 'record_contract_unverified', events: [] }) },
    createApiClient: () => ({ start: async () => {}, stop: () => {}, snapshot: () => ({}) }),
  })
  await runtime.start()

  await runtime.onFinal({ ...fixtureEvent(7), shoe: 91 })
  await runtime.onFinal({ ...fixtureEvent(8), shoe: 91 })
  cursor = { shoe: 91, round: 8, identity: 'BAG01:91:8', hash: 'ack-8' }
  await assert.rejects(runtime.onFinal({ ...fixtureEvent(1), shoe: 92 }), /live_ack_blocked:record_contract_unverified/)

  assert.deepEqual(appended.map(({ shoe, round }) => [shoe, round]), [[91, 7], [91, 8]])
})

test('Reviewer P0: an older same-shoe Final absent from durable ACK history is not an idempotent duplicate', async () => {
  const appended = []
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1', status: 'active', expiresAt: 10_000 }
  const runtime = createWorkerSourceRuntime({
    sourceOwner: {
      acquireOrRecover: async () => lease, lease: () => lease, assertCurrent: () => true,
      renew: async () => lease, stop: async () => {},
    },
    journal: {
      append: async (event) => { appended.push(event) }, pending: () => [], status: () => null,
      cursor: () => ({ shoe: 91, round: 7, identity: 'BAG01:91:7', hash: 'ack-7' }), ack: async () => {},
    },
    gapDetector: createGapDetector(),
    replayProvider: { replay: async () => ({ ok: false, liveGate: 'record_contract_unverified', events: [] }) },
    createApiClient: () => ({ start: async () => {}, stop: () => {}, snapshot: () => ({}) }),
  })
  await runtime.start()

  await assert.rejects(runtime.onFinal({ ...fixtureEvent(6), shoe: 91 }), /live_ack_blocked:record_contract_unverified/)
  assert.deepEqual(appended, [])
})

test('runtime renews the owner lease and stops renewal before releasing the source', async () => {
  let renewals = 0
  let renewalTick
  let cleared = false
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1', status: 'active', expiresAt: 10_000 }
  const sourceOwner = {
    acquireOrRecover: async () => lease,
    lease: () => lease,
    renew: async () => { renewals += 1; return lease },
    stop: async () => {},
  }
  const runtime = createWorkerSourceRuntime({
    sourceOwner,
    journal: { append: async () => {}, pending: () => [], cursor: () => null },
    gapDetector: { detect: () => [] }, replayProvider: { replay: async () => ({ ok: true, events: [] }) },
    createApiClient: () => ({ start: async () => {}, stop: () => {} }),
    setIntervalFn: (fn) => { renewalTick = fn; return fn },
    clearIntervalFn: () => { cleared = true },
  })
  await runtime.start()
  await renewalTick()
  assert.equal(renewals, 1)
  await runtime.stop()
  assert.equal(cleared, true)
})

test('runtime delivery health is derived from API state and source progress instead of fixed true values', async () => {
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'fence-1', status: 'active', expiresAt: 10_000 }
  let apiState = { connected: false, authenticated: false, joined: false, lastMessageAt: null, reconnecting: false, refreshing: false }
  let handlers
  const runtime = createWorkerSourceRuntime({
    sourceOwner: {
      acquireOrRecover: async () => lease, lease: () => lease, assertCurrent: () => true,
      renew: async () => lease, stop: async () => {},
    },
    journal: { append: async () => {}, pending: () => [], cursor: () => null },
    gapDetector: { detect: () => [] }, replayProvider: { replay: async () => ({ ok: true, events: [] }) },
    createApiClient: (value) => {
      handlers = value
      return { start: async () => {}, stop: () => {}, snapshot: () => structuredClone(apiState) }
    },
    now: () => '2026-07-31T01:00:00.000Z',
  })
  await runtime.start()
  let snapshot = await runtime.getDeliverySnapshot()
  assert.equal(snapshot.connected, false)
  assert.equal(snapshot.authenticated, false)
  assert.equal(snapshot.joined, false)
  assert.equal(snapshot.sourceProgressAt, null)

  apiState = { connected: true, authenticated: true, joined: true, lastMessageAt: '2026-07-31T01:00:00.000Z', reconnecting: false, refreshing: false }
  await handlers.onTables(PRODUCTION_TABLE_IDS.map((table_id) => ({ table_id, shoe: 91, round: 1 })))
  snapshot = await runtime.getDeliverySnapshot()
  assert.equal(snapshot.connected, true)
  assert.equal(snapshot.authenticated, true)
  assert.equal(snapshot.joined, true)
  assert.equal(snapshot.tableCount, 10)
  assert.equal(snapshot.sourceProgressAt, '2026-07-31T01:00:00.000Z')
  assert.equal(snapshot.lastMessageAt, '2026-07-31T01:00:00.000Z')

  await handlers.onTables(Array.from({ length: 10 }, () => ({ table_id: 'BAG01', shoe: 91, round: 1 })))
  snapshot = await runtime.getDeliverySnapshot()
  assert.equal(snapshot.tableCount, 1, 'duplicate rows cannot impersonate the exact ten production tables')
})

test('restart rebinds old-fence pending Finals after new lease acquisition and before API delivery', async () => {
  const order = []
  const oldSource = { mode: 'api', ownerId: 'api-primary', epoch: 1, fence: 'old-fence', sequence: 7 }
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 2, fence: 'new-fence', status: 'active', expiresAt: 10_000 }
  const pending = [{ identity: 'BAG01:91:7', hash: 'payload-hash', event: { ...fixtureEvent(7), source: oldSource } }]
  const sourceOwner = {
    acquireOrRecover: async () => { order.push('lease'); return lease },
    lease: () => lease,
    assertCurrent: () => true,
    nextEventSource: async () => ({ mode: 'api', ownerId: 'api-primary', epoch: 2, fence: 'new-fence', sequence: 11 }),
    renew: async () => lease,
    stop: async () => {},
  }
  const journal = {
    pending: () => structuredClone(pending), cursor: () => null, append: async () => {}, ack: async () => {},
    rebindPending: async (allocateSource) => {
      order.push('rebind')
      for (const entry of pending) {
        const capturedSource = entry.event.capturedSource ?? entry.event.source
        entry.event = { ...entry.event, capturedSource, source: await allocateSource(entry) }
      }
    },
  }
  const runtime = createWorkerSourceRuntime({
    sourceOwner, journal, gapDetector: { detect: () => [] }, replayProvider: { replay: async () => ({ ok: true, events: [] }) },
    createApiClient: () => ({ start: async () => { order.push('api') }, stop: () => {} }),
  })

  await runtime.start()
  const snapshot = await runtime.getDeliverySnapshot()

  assert.deepEqual(order.slice(0, 3), ['lease', 'rebind', 'api'])
  assert.equal(snapshot.rounds[0].source.epoch, 2)
  assert.deepEqual(snapshot.rounds[0].capturedSource, oldSource)
  assert.deepEqual({ ...snapshot.rounds[0].source, sequence: undefined }, { ...snapshot.source, sequence: undefined })
  assert.equal(snapshot.rounds[0].source.sequence, 11)
  assert.equal(pending[0].identity, 'BAG01:91:7')
  assert.equal(pending[0].hash, 'payload-hash')
})

test('cross-shoe coverage is not remembered until every replay Final is journaled', async () => {
  let replayCalls = 0
  let appendCalls = 0
  const gap = { type: 'cross_shoe', tableId: 'BAG01', from: { shoe: 91, round: 70 }, to: { shoe: 92, round: 3 } }
  const lease = { mode: 'api', ownerId: 'api-primary', epoch: 2, fence: 'new-fence', status: 'active', expiresAt: 10_000 }
  const sourceOwner = {
    acquireOrRecover: async () => lease, lease: () => lease, assertCurrent: () => true,
    nextEventSource: async () => ({ mode: 'api', ownerId: 'api-primary', epoch: 2, fence: 'new-fence', sequence: appendCalls + 1 }),
    renew: async () => lease, stop: async () => {},
  }
  const runtime = createWorkerSourceRuntime({
    sourceOwner,
    journal: {
      pending: () => [], cursor: () => ({ shoe: 91, round: 70 }), ack: async () => {}, rebindPending: async () => {},
      append: async () => { appendCalls += 1; if (appendCalls === 1) throw new Error('journal_write_failed') },
    },
    gapDetector: { detect: () => [gap] },
    replayProvider: {
      replay: async () => {
        replayCalls += 1
        return { ok: true, coverage: gap, events: [{ ...fixtureEvent(1), shoe: 92 }, { ...fixtureEvent(2), shoe: 92 }] }
      },
    },
    createApiClient: ({ onTables }) => ({ start: async () => onTables([{ tableId: 'BAG01', shoe: 92, round: 3 }]), stop: () => {} }),
  })
  await runtime.start()
  await assert.rejects(runtime.getDeliverySnapshot(), /journal_write_failed/)
  await assert.rejects(runtime.getDeliverySnapshot(), /live_ack_blocked|journal_write_failed/)
  assert.equal(replayCalls, 2)
})

async function runtimeFixture(t, {
  replayProvider = { replay: async () => ({ ok: false, events: [], liveGate: 'record_contract_unverified' }) },
  allowFreshBaseline = false,
  allowGapDelivery = false,
  freshBaselineWarmupMs = 0,
  clockMs = Date.now,
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-source-runtime-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const owner = createWorkerSourceOwner({
    store: createMemoryLeaseStore(), ownerId: 'api-primary', mode: 'api', now: () => 1_000, leaseMs: 10_000,
    createFence: () => 'runtime-fence',
  })
  const journal = await createFinalJournal({ journalPath: path.join(dir, 'finals.jsonl'), assertSource: () => true })
  const handlers = {}
  let apiStarts = 0
  let browserStarts = 0
  const runtime = createWorkerSourceRuntime({
    sourceOwner: owner, journal, gapDetector: createGapDetector(), replayProvider,
    allowFreshBaseline, allowGapDelivery, freshBaselineWarmupMs, clockMs,
    createApiClient: (value) => {
      Object.assign(handlers, value)
      return { start: async () => { apiStarts += 1 }, stop: () => {} }
    },
    startBrowser: async () => { browserStarts += 1 },
  })
  return {
    runtime, journal, handlers, owner,
    get apiStarts() { return apiStarts },
    get browserStarts() { return browserStarts },
    finalEvent: async (round) => ({ ...fixtureEvent(round), source: await owner.nextEventSource() }),
  }
}

function fixtureEvent(round) {
  return {
    tableId: 'BAG01', shoe: 91, round, winner: 'banker', sourceAction: 'summary', final: true,
    rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], playerPoint: 4, bankerPoint: 6,
  }
}
