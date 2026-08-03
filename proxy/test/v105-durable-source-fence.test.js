import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
import { createApp } from '../src/server.js'
import { verifyRollbackReadiness } from '../../scripts/verify-v105-mt-api-release.mjs'

const migrationUrl = new URL('../../supabase/migrations/20260731010000_v105_capture_source_fence.sql', import.meta.url)
const manifestUrl = new URL('../../release/v105-mt-api-source-fence-release-manifest.json', import.meta.url)

const source = (epoch, overrides = {}) => ({
  mode: 'api', ownerId: 'api-primary', epoch, fence: `fence-${epoch}`, ...overrides,
})

const rpcResponse = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
})

function captureRequest(candidate, sequence = 1) {
  const now = 1_000_000
  return {
    method: 'POST',
    url: '/api/cloud-ingest/snapshot',
    headers: { 'x-worker-key': 'worker-key' },
    body: JSON.stringify({
      protocolVersion: 'v105', timestamp: now, captureTimestamp: now,
      sessionId: `session-${sequence}`, sequence, source: candidate,
      roundKeys: ['BAG01:100:4'],
      snapshot: {
        buildVersion: '105', sessionId: `session-${sequence}`,
        connected: true, authenticated: true, source: candidate,
        tables: [{ tableId: 'BAG01', shoe: 100, round: 5 }],
        rounds: [{
          tableId: 'BAG01', shoe: 100, round: 4, winner: 'banker', sourceAction: 'summary',
          rawResult: [1, 2, 3, 4, 0, 0, 0, 0, 4, 6], source: { ...candidate, sequence },
        }],
      },
    }),
  }
}

function createDurableFenceFake() {
  let current = null
  let persistCalls = 0
  return {
    get current() { return current && structuredClone(current) },
    get persistCalls() { return persistCalls },
    writer: {
      configured: true,
      writeCloudCaptureStatus: async () => {},
      writeCloudTableSnapshot: async () => {},
      writeCloudRoundEvent: async () => {},
      persistCaptureEnvelope: async ({ source: candidate, roundKeys }) => {
        persistCalls += 1
        if (current && candidate.epoch < current.epoch) throw new Error('stale_source_epoch')
        if (current && candidate.epoch === current.epoch
            && (candidate.mode !== current.mode || candidate.ownerId !== current.ownerId || candidate.fence !== current.fence)) {
          throw new Error('source_epoch_fence_conflict')
        }
        if (!current || candidate.epoch > current.epoch) current = structuredClone(candidate)
        return { persisted: true, duplicate: true, acceptedRoundKeys: roundKeys }
      },
    },
  }
}

test('additive migration defines one durable source fence and an atomic service-role-only wrapper', () => {
  assert.equal(existsSync(migrationUrl), true, 'durable source-fence migration is missing')
  const sql = readFileSync(migrationUrl, 'utf8')
  assert.match(sql, /create table if not exists public\.v105_capture_source_fence/i)
  assert.match(sql, /create or replace function public\.persist_v105_fenced_capture_envelope\(p_capture jsonb\)/i)
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public, extensions/i)
  assert.equal((sql.match(/jsonb_typeof\(capture_source->'(?:mode|ownerId|epoch|fence)'\)\s+is distinct from/gi) ?? []).length, 4)
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*for update/i)
  assert.match(sql, /stale_source_epoch/i)
  assert.match(sql, /source_epoch_fence_conflict/i)
  assert.match(sql, /update public\.v105_capture_source_fence[\s\S]*public\.persist_v105_capture_envelope\(p_capture\)/i)
  assert.equal((sql.match(/public\.persist_v105_capture_envelope\(p_capture\)/gi) ?? []).length, 1)
  assert.doesNotMatch(sql, /insert\s+into\s+public\.(?:cloud_table_rounds|cloud_capture_status|v105_capture_settlement_outbox)/i)
  assert.match(sql, /revoke all on function public\.persist_v105_fenced_capture_envelope\(jsonb\) from public,\s*anon,\s*authenticated,\s*service_role/i)
  assert.match(sql, /grant execute on function public\.persist_v105_fenced_capture_envelope\(jsonb\) to service_role/i)
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from)\b/i)
})

test('fenced writer uses only the durable fenced RPC and forwards source inside the capture', async () => {
  const requests = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url, options) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body) })
      return rpcResponse({ persisted: true, duplicate: false, accepted_round_keys: [] })
    },
  })
  const candidate = source(7)

  await client.persistCaptureEnvelope({ sessionId: 's7', sequence: 7, source: candidate })

  assert.deepEqual(requests.map(({ path }) => path), ['/rest/v1/rpc/persist_v105_fenced_capture_envelope'])
  assert.deepEqual(requests[0].body.p_capture.source, candidate)
})

test('fenced writer never falls back to the unfenced RPC after a fence rejection', async () => {
  const paths = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false, retryAttempts: 1,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname)
      return rpcResponse({ message: 'stale_source_epoch' }, { ok: false, status: 409 })
    },
  })

  await assert.rejects(
    client.persistCaptureEnvelope({ sessionId: 'stale', sequence: 1, source: source(4) }),
    /stale_source_epoch/,
  )
  assert.deepEqual(paths, ['/rest/v1/rpc/persist_v105_fenced_capture_envelope'])
})

test('fenced writer uses the new RPC through the preferred Direct DB path', async () => {
  const queries = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    strategyPool: {
      async query(query) {
        queries.push(query)
        return { rows: [{ persist_v105_fenced_capture_envelope: { persisted: true, accepted_round_keys: [] } }] }
      },
    },
    fetchImpl: async () => assert.fail('fenced Direct DB persistence must not use REST'),
  })
  const candidate = source(9)

  await client.persistCaptureEnvelope({ sessionId: 'direct-9', sequence: 9, source: candidate })

  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /public\.persist_v105_fenced_capture_envelope\(\$1::jsonb\)/)
  assert.deepEqual(queries[0].values[0].source, candidate)
})

test('unfenced compatibility writer keeps using the legacy RPC during DB-first transition', async () => {
  const paths = []
  const client = createSupabaseIngestionClient({
    url: 'https://example.supabase.co', serviceKey: 'test-only', requireVerifiedStrategy: false,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname)
      return rpcResponse({ persisted: true, duplicate: false, accepted_round_keys: [] })
    },
  })

  await client.persistCaptureEnvelope({ sessionId: 'legacy', sequence: 1 })
  assert.deepEqual(paths, ['/rest/v1/rpc/persist_v105_capture_envelope'])
})

test('durable fenced ingest accepts an aged queue head because DB fence and sequence provide replay safety', async () => {
  const durable = createDurableFenceFake()
  const app = createApp({
    autoConnect: false,
    ingestKey: 'worker-key',
    now: () => 1_000_000 + 10 * 60 * 1000,
    requireFencedIngest: true,
    supabaseClient: durable.writer,
  })

  const response = await app.inject(captureRequest(source(54), 54))

  assert.equal(response.statusCode, 200)
  assert.equal(durable.current.epoch, 54)
  assert.equal(durable.persistCalls, 1)
})

test('durable DB fence rejects stale and split-brain sources across fresh app instances without local ACK/state writes', async () => {
  const durable = createDurableFenceFake()
  const createFreshApp = () => createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    requireFencedIngest: true, supabaseClient: durable.writer,
  })

  const first = await createFreshApp().inject(captureRequest(source(5), 5))
  assert.equal(first.statusCode, 200)

  const restarted = createFreshApp()
  const before = restarted.state.snapshot()
  const stale = await restarted.inject(captureRequest(source(4), 4))
  assert.equal(stale.statusCode, 409)
  assert.equal(JSON.parse(stale.body).error, 'stale_source_epoch')
  assert.deepEqual(restarted.state.snapshot(), before)

  const newer = await createFreshApp().inject(captureRequest(source(6), 6))
  assert.equal(newer.statusCode, 200)
  assert.equal(durable.current.epoch, 6)

  const splitBrain = await createFreshApp().inject(captureRequest(source(6, { ownerId: 'other-owner' }), 7))
  assert.equal(splitBrain.statusCode, 409)
  assert.equal(JSON.parse(splitBrain.body).error, 'source_epoch_fence_conflict')
  assert.equal(durable.persistCalls, 4, 'fresh processes must consult the durable fence')
})

test('durable commits remain exact ACKs when cross-session responses complete epoch 2 before epoch 1', async () => {
  let releaseEpochOneResponse
  const epochOneResponseGate = new Promise((resolve) => { releaseEpochOneResponse = resolve })
  let epochOneCommitted
  const epochOneCommittedGate = new Promise((resolve) => { epochOneCommitted = resolve })
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    requireFencedIngest: true,
    supabaseClient: {
      configured: true,
      writeCloudCaptureStatus: async () => {},
      writeCloudTableSnapshot: async () => {},
      writeCloudRoundEvent: async () => {},
      persistCaptureEnvelope: async (capture) => {
        if (capture.source.epoch === 1) {
          epochOneCommitted()
          await epochOneResponseGate
        }
        return { persisted: true, duplicate: false, acceptedRoundKeys: capture.roundKeys }
      },
    },
  })

  const epochOne = app.inject(captureRequest(source(1), 101))
  await epochOneCommittedGate
  const epochTwo = await app.inject(captureRequest(source(2), 202))
  releaseEpochOneResponse()
  const delayedEpochOne = await epochOne

  assert.equal(epochTwo.statusCode, 200)
  assert.equal(delayedEpochOne.statusCode, 200)
  assert.deepEqual(JSON.parse(epochTwo.body), {
    ok: true, accepted: true, duplicate: false, sessionId: 'session-202', sequence: 202,
    acceptedRoundKeys: ['BAG01:100:4'], source: source(2),
  })
  assert.deepEqual(JSON.parse(delayedEpochOne.body), {
    ok: true, accepted: true, duplicate: false, sessionId: 'session-101', sequence: 101,
    acceptedRoundKeys: ['BAG01:100:4'], source: source(1),
  })
})

test('source mismatch is rejected before durable persistence', async () => {
  let persistCalls = 0
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000, requireFencedIngest: true,
    supabaseClient: {
      configured: true,
      persistCaptureEnvelope: async () => { persistCalls += 1; return { acceptedRoundKeys: [] } },
    },
  })
  for (const mutate of [
    (body) => { body.snapshot.source = source(2) },
    (body) => { body.snapshot.rounds[0].source = { ...source(1), sequence: 1, ownerId: 'other-owner' } },
  ]) {
    const request = captureRequest(source(1), 1)
    const body = JSON.parse(request.body)
    mutate(body)
    request.body = JSON.stringify(body)
    const response = await app.inject(request)
    assert.equal(response.statusCode, 409)
    assert.equal(JSON.parse(response.body).accepted, undefined)
  }
  assert.equal(persistCalls, 0)
})

test('partial or extra durable accepted keys never produce an ACK', async () => {
  for (const acceptedRoundKeys of [[], ['BAG01:100:4', 'BAG02:100:4']]) {
    const app = createApp({
      autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000, requireFencedIngest: true,
      supabaseClient: {
        configured: true,
        writeCloudTableSnapshot: async () => {},
        writeCloudRoundEvent: async () => {},
        persistCaptureEnvelope: async () => ({ persisted: true, acceptedRoundKeys }),
      },
    })
    const response = await app.inject(captureRequest(source(1), 1))
    assert.equal(response.statusCode, 503)
    assert.equal(JSON.parse(response.body).accepted, false)
  }
})

test('durable persistence failure never produces an ACK', async () => {
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000, requireFencedIngest: true,
    supabaseClient: {
      configured: true,
      writeCloudTableSnapshot: async () => {},
      writeCloudRoundEvent: async () => {},
      persistCaptureEnvelope: async () => { throw new Error('persist_failed') },
    },
  })
  const response = await app.inject(captureRequest(source(1), 1))
  assert.equal(response.statusCode, 503)
  assert.equal(JSON.parse(response.body).accepted, false)
})

test('post-commit local cache failure cannot change an exact durable ACK', async () => {
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000, requireFencedIngest: true,
    sourceFenceStore: {
      validateEvents: () => true,
      observeCommitted: async () => { throw new Error('local_cache_failed') },
    },
    supabaseClient: {
      configured: true,
      writeCloudTableSnapshot: async () => {},
      writeCloudRoundEvent: async () => {},
      persistCaptureEnvelope: async (capture) => ({ persisted: true, duplicate: false, acceptedRoundKeys: capture.roundKeys }),
    },
  })
  const response = await app.inject(captureRequest(source(3), 3))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), {
    ok: true, accepted: true, duplicate: false, sessionId: 'session-3', sequence: 3,
    acceptedRoundKeys: ['BAG01:100:4'], source: source(3),
  })
})

test('REQUIRE_FENCED_INGEST=true rejects an unfenced HTTP envelope before persistence', async () => {
  const previous = process.env.REQUIRE_FENCED_INGEST
  process.env.REQUIRE_FENCED_INGEST = 'true'
  let writes = 0
  try {
    const app = createApp({
      autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000, production: false,
      supabaseClient: {
        configured: true,
        writeCloudCaptureStatus: async () => { writes += 1 },
        writeCloudTableSnapshot: async () => { writes += 1 },
        writeCloudRoundEvent: async () => { writes += 1 },
      },
    })
    const unfenced = captureRequest(source(1), 1)
    const body = JSON.parse(unfenced.body)
    delete body.source
    delete body.snapshot.source
    for (const round of body.snapshot.rounds) delete round.source
    unfenced.body = JSON.stringify(body)

    const response = await app.inject(unfenced)
    assert.equal(response.statusCode, 409)
    assert.equal(JSON.parse(response.body).error, 'source_fence_invalid')
    assert.equal(writes, 0)
  } finally {
    if (previous == null) delete process.env.REQUIRE_FENCED_INGEST
    else process.env.REQUIRE_FENCED_INGEST = previous
  }
})

test('HTTP source precheck rejects blank identity and extra envelope source keys before persistence', async () => {
  let writes = 0
  const createStrictApp = () => createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000, requireFencedIngest: true,
    supabaseClient: {
      configured: true,
      writeCloudCaptureStatus: async () => { writes += 1 },
      writeCloudTableSnapshot: async () => { writes += 1 },
      writeCloudRoundEvent: async () => { writes += 1 },
    },
  })
  for (const candidate of [source(1, { ownerId: '   ' }), { ...source(1), unexpected: true }]) {
    const request = captureRequest(candidate, 1)
    const response = await createStrictApp().inject(request)
    assert.equal(response.statusCode, 409)
    assert.equal(JSON.parse(response.body).error, 'source_fence_invalid')
  }
  assert.equal(writes, 0)
})

test('proxy-compatible phase still routes any present source through durable fenced persistence before finalize', async () => {
  const persisted = []
  const app = createApp({
    autoConnect: false, ingestKey: 'worker-key', now: () => 1_000_000,
    requireFencedIngest: false,
    supabaseClient: {
      configured: true,
      writeCloudCaptureStatus: async () => {},
      writeCloudTableSnapshot: async () => {},
      writeCloudRoundEvent: async () => {},
      persistCaptureEnvelope: async (capture) => {
        persisted.push(capture)
        return { persisted: true, duplicate: true, acceptedRoundKeys: capture.roundKeys }
      },
    },
  })
  const candidate = source(8)

  const response = await app.inject(captureRequest(candidate, 8))

  assert.equal(response.statusCode, 200)
  assert.deepEqual(persisted[0].source, candidate)
  assert.deepEqual(JSON.parse(response.body).source, candidate)
})

test('release manifest freezes DB-first cutover through fenced finalize and browser backup source', () => {
  assert.equal(existsSync(manifestUrl), true, 'source-fence release manifest is missing')
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))
  assert.deepEqual(manifest.deploymentOrder, [
    'v9-shadow-hydration-migration',
    'v9-shadow-hydration-catalog-acl-readback',
    'v10-shadow-migration',
    'v10-shadow-catalog-acl-readback',
    'v6-v8-retirement-migration',
    'v6-v8-retirement-catalog-acl-readback',
    'database-additive',
    'database-catalog-acl-readback',
    'proxy-compatible',
    'new-api-worker',
    'durable-source-readback',
    'require-fenced-ingest-finalize',
  ])
  assert.equal(manifest.browserColdBackup.requiresSource, true)
  assert.equal(manifest.browserColdBackup.sourceMode, 'browser')
  assert.equal(manifest.behavior.predictionRulesChanged, true)
  assert.equal(manifest.behavior.versionChanged, true)
})

test('Reviewer P1 Rollback Gate drains, checkpoints, and reads back zero unfinished work before proxy or worker rollback', () => {
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))
  assert.deepEqual(manifest.rollback.target, {
    commit: 'dc36e903d008e5f9dfec09d5f47fd454b822c91a',
    tree: '8158a0b61095fcf723f574be5acb8993aeba5b19',
    proxyArtifact: 'proxy-from-exact-target',
    browserWorkerArtifact: 'cloud-browser-worker-from-exact-target',
  })
  assert.deepEqual(manifest.rollback.order.map((step) => step.id), [
    'stop-api-intake-sockets-renewal',
    'drain-pusher-queue',
    'stop-pusher-and-wait',
    'checkpoint-queue-cursor-journal',
    'readback-zero-and-preserved',
    'disable-fenced-requirement',
    'readback-old-unfenced-accepted',
    'disable-v9-shadow-before-proxy-rollback',
    'disable-v10-shadow-before-proxy-rollback',
    'rollback-proxy-compatible',
    'readback-lease-stopped-no-socket',
    'start-old-browser-worker',
  ])
  assert.equal(manifest.rollback.order[0].requireApiIntakeStopped, true)
  assert.equal(manifest.rollback.order[0].requireRenewalTimerStopped, true)
  assert.equal(manifest.rollback.order[1].requireDrainComplete, true)
  assert.equal(manifest.rollback.order[2].requirePusherStopped, true)
  assert.equal(manifest.rollback.order[2].requireInFlight, 0)
  assert.deepEqual(manifest.rollback.order[3].checkpoint, ['queue', 'cursor', 'journal'])
  assert.equal(manifest.rollback.order[4].abortBeforeArtifactRollbackOnFailure, true)
  assert.equal(manifest.rollback.order[5].setEnvironment, 'REQUIRE_FENCED_INGEST=false')
  assert.equal(manifest.rollback.order[6].requireOldUnfencedAccepted, true)
  assert.equal(manifest.rollback.order[7].setEnvironment, 'V105_SHADOW_V9_ENABLED=false')
  assert.equal(manifest.rollback.order[7].requireEnvironmentReadback, 'false')
  assert.equal(manifest.rollback.order[7].preserveShadowEvidence, true)
  assert.equal(manifest.rollback.order[8].setEnvironment, 'V105_SHADOW_V10_ENABLED=false')
  assert.equal(manifest.rollback.order[8].requireEnvironmentReadback, 'false')
  assert.equal(manifest.rollback.order[8].preserveShadowEvidence, true)
  assert.equal(manifest.rollback.order[10].requireLeaseStopped, true)
  assert.equal(manifest.rollback.order[10].requireApiSocketCount, 0)
  assert.deepEqual(manifest.rollback.preserve, ['queue', 'cursor', 'journal'])
  assert.equal(manifest.rollback.preserveShadowEvidence, true)
  assert.equal(manifest.rollback.requireV9ShadowDisabledBeforeProxyRollback, true)
  assert.equal(manifest.rollback.requireV10ShadowDisabledBeforeProxyRollback, true)
  assert.equal(manifest.rollback.requireAllUnfinishedCountsZero, true)
  assert.deepEqual(manifest.rollback.unfinishedCounts, ['pending', 'processing', 'error', 'dead-letter'])
  assert.equal(manifest.rollback.requireNoNewLostFinals, true)
  assert.equal(manifest.rollback.requireCursorNonRegression, true)
  assert.equal(manifest.rollback.requireProducerQuiesce, true)
  assert.deepEqual(manifest.rollback.abortGates, [
    'rollback-target-readback-mismatch',
    'unfinished-count-nonzero',
    'producer-not-quiesced',
    'drain-checkpoint-readback-failed',
    'old-unfenced-not-accepted',
    'proxy-compatibility-readback-failed',
    'api-owner-lease-not-stopped',
    'api-owner-socket-still-open',
    'queue-cursor-journal-preservation-failed',
    'new-lost-final-detected',
    'cursor-regression-detected',
    'v9-shadow-disable-readback-failed',
    'v10-shadow-disable-readback-failed',
  ])

  const zero = { pending: 0, processing: 0, error: 0, 'dead-letter': 0 }
  const quiesced = {
    intakeStopped: true, renewalTimerStopped: true, apiSocketCount: 0, leaseStopped: true,
    pusherDrained: true, pusherStopped: true, inFlight: 0, checkpointReadback: true,
  }
  assert.throws(
    () => verifyRollbackReadiness(manifest.rollback, zero, { ...quiesced, pusherStopped: false, inFlight: 1 }),
    /rollback_producer_not_quiesced/,
  )
  assert.deepEqual(verifyRollbackReadiness(manifest.rollback, zero, quiesced), { ok: true, counts: zero, producer: quiesced })
  for (const field of manifest.rollback.unfinishedCounts) {
    assert.throws(
      () => verifyRollbackReadiness(manifest.rollback, { ...zero, [field]: 1 }, quiesced),
      new RegExp(`rollback_unfinished_counts_nonzero:${field}`),
    )
  }
})
