import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerHealth, updateSourceProgressTracker } from '../src/worker-health.js'

const base = {
  service: 'darven-cloud-browser-worker',
  version: '105',
  configured: true,
  loginUrl: 'https://mt.example/login',
  sourceError: null,
}

test('worker health fails closed after repeated push failures with a durable backlog', () => {
  const health = buildWorkerHealth({
    ...base,
    push: {
      stateInvalid: false, queueEntryCount: 4, queuedRoundKeyCount: 11,
      consecutiveFailures: 3, lastError: 'HTTP 409 sequence_payload_conflict',
      headSessionId: 'vm-1', headSequence: 123,
    },
  })
  assert.equal(health.ok, false)
  assert.equal(health.reason, 'push_delivery_failed')
  assert.equal(health.push.queueEntryCount, 4)
  assert.equal(health.push.queuedRoundKeyCount, 11)
  assert.equal(health.push.headSequence, 123)
})

test('worker health reports legacy mutable queue as an explicit cutover block', () => {
  const health = buildWorkerHealth({
    ...base,
    push: { stateInvalid: true, legacyMutableQueueDetected: true, queueEntryCount: 2 },
  })
  assert.equal(health.ok, false)
  assert.equal(health.reason, 'legacy_mutable_queue_requires_cutover')
  assert.equal(health.push.legacyMutableQueueDetected, true)
})

test('worker health fails closed when durable delivery state is invalid', () => {
  const health = buildWorkerHealth({
    ...base,
    push: { stateInvalid: true, queueEntryCount: 0, queuedRoundKeyCount: 0, consecutiveFailures: 0 },
  })
  assert.equal(health.ok, false)
  assert.equal(health.reason, 'push_durable_state_invalid')
})

test('worker health exposes normalized source capture progress without table payloads', () => {
  const health = buildWorkerHealth({
    ...base,
    source: {
      sessionId: 'vm-1', connected: true, authenticated: true,
      tables: Array.from({ length: 10 }, (_, index) => ({ tableId: `BAG${index + 1}` })),
      snapshotAt: '2026-07-29T11:30:00.000Z',
    },
    push: { stateInvalid: false, queueEntryCount: 0, queuedRoundKeyCount: 0, consecutiveFailures: 0 },
  })
  assert.deepEqual(health.source, {
    sessionId: 'vm-1', connected: true, authenticated: true,
    tableCount: 10, snapshotAt: '2026-07-29T11:30:00.000Z',
  })
  assert.equal('tables' in health.source, false)
})

test('source progress tracker ignores heartbeat-only snapshots and advances on real table progress', () => {
  const first = updateSourceProgressTracker(null, {
    snapshotAt: '2026-07-29T11:30:00.000Z',
    tables: [{ tableId: 'BAG01', shoe: 8, round: 1, bigRoadRaw: 'B' }],
    rounds: [],
  })
  const heartbeat = updateSourceProgressTracker(first, {
    snapshotAt: '2026-07-29T11:31:00.000Z',
    tables: [{ tableId: 'BAG01', shoe: 8, round: 1, bigRoadRaw: 'B' }],
    rounds: [],
  })
  const progressed = updateSourceProgressTracker(heartbeat, {
    snapshotAt: '2026-07-29T11:31:05.000Z',
    tables: [{ tableId: 'BAG01', shoe: 8, round: 2, bigRoadRaw: 'BP' }],
    rounds: [{ tableId: 'BAG01', shoe: 8, round: 1, sourceAction: '/summary' }],
  })
  assert.equal(first.sourceProgressAt, '2026-07-29T11:30:00.000Z')
  assert.equal(heartbeat.sourceProgressAt, first.sourceProgressAt)
  assert.equal(progressed.sourceProgressAt, '2026-07-29T11:31:05.000Z')
})

test('worker health fails closed when ten-table source progress is frozen', () => {
  const health = buildWorkerHealth({
    ...base,
    nowMs: Date.parse('2026-07-29T11:34:01.000Z'),
    sourceProgressMaxAgeMs: 3 * 60 * 1000,
    source: {
      sessionId: 'vm-1', connected: true, authenticated: true, tableCount: 10,
      snapshotAt: '2026-07-29T11:34:00.000Z',
      sourceProgressAt: '2026-07-29T11:30:00.000Z',
    },
    push: { stateInvalid: false, queueEntryCount: 0, consecutiveFailures: 0 },
  })
  assert.equal(health.ok, false)
  assert.equal(health.reason, 'source_progress_stale')
  assert.equal(health.source.snapshotAt, '2026-07-29T11:34:00.000Z')
  assert.equal(health.source.sourceProgressAt, '2026-07-29T11:30:00.000Z')
})

test('worker health fails closed before a configured source is ready', () => {
  assert.equal(buildWorkerHealth({ ...base, source: null, push: {} }).reason, 'source_unavailable')
  assert.equal(buildWorkerHealth({ ...base, sourceError: 'MT page snapshot timed out', source: null, push: {} }).reason, 'source_unavailable')
  assert.equal(buildWorkerHealth({ ...base, configured: false, source: null, push: {} }).reason, 'worker_not_configured')
})

test('worker health fails closed on source errors and first failed queued push', () => {
  const now = '2026-07-29T11:34:00.000Z'
  const source = { connected: true, authenticated: true, tableCount: 10, snapshotAt: now, sourceProgressAt: now }
  const sourceFailure = buildWorkerHealth({
    ...base, nowMs: Date.parse(now), source,
    sourceError: 'portal failed Authorization: Bearer must-not-leak', push: {},
  })
  assert.equal(sourceFailure.ok, false)
  assert.equal(sourceFailure.reason, 'source_error')
  assert.doesNotMatch(sourceFailure.lastError, /must-not-leak/)

  const pushFailure = buildWorkerHealth({
    ...base, nowMs: Date.parse(now), source,
    push: { queueEntryCount: 1, consecutiveFailures: 1, lastError: 'offline' },
  })
  assert.equal(pushFailure.ok, false)
  assert.equal(pushFailure.reason, 'push_delivery_failed')
})

test('worker health remains healthy with no repeated delivery failure', () => {
  const now = '2026-07-29T11:34:00.000Z'
  const health = buildWorkerHealth({
    ...base,
    nowMs: Date.parse(now),
    source: { connected: true, authenticated: true, tableCount: 10, snapshotAt: now, sourceProgressAt: now },
    push: { stateInvalid: false, queueEntryCount: 1, queuedRoundKeyCount: 2, consecutiveFailures: 0, lastError: null },
  })
  assert.equal(health.ok, true)
  assert.equal(health.reason, null)
})
