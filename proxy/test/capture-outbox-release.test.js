import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const root = new URL('../../', import.meta.url)

test('migration harness refuses an unmarked connection and never prints credentials', () => {
  const secret = 'never-print-this-password'
  const result = spawnSync(process.execPath, ['scripts/test-capture-outbox-migration.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      CAPTURE_OUTBOX_TEST_MODE: '',
      SUPABASE_DB_CONNECTION_STRING: `postgresql://test:${secret}@127.0.0.1:1/postgres`,
    },
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.notEqual(result.status, 0)
  assert.match(output, /disposable|rollback-only/i)
  assert.doesNotMatch(output, new RegExp(secret))
  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'refusal must happen before any connection attempt')
})

test('rollback-only harness also requires an explicit no-commit confirmation before connecting', () => {
  const result = spawnSync(process.execPath, ['scripts/test-capture-outbox-migration.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: {
      ...process.env,
      CAPTURE_OUTBOX_TEST_MODE: 'rollback-only',
      CAPTURE_OUTBOX_ROLLBACK_ONLY_CONFIRM: '',
      SUPABASE_DB_CONNECTION_STRING: 'postgresql://test:test@127.0.0.1:1/postgres',
    },
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.notEqual(result.status, 0)
  assert.match(output, /ROLLBACK_ONLY_NO_COMMIT/)
  assert.doesNotMatch(output, /ECONNREFUSED/)
})

test('capture-outbox.1 release manifest is DB-first and blocks rollback while any durable outbox work remains', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../release/v105-capture-outbox-release-manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.releaseVersion, 'v105-capture-outbox.1')
  assert.equal(manifest.releaseName, '抓牌Outbox解耦正式版')
  assert.equal(manifest.captureOutbox.migration, 'supabase/migrations/20260729043000_v105_capture_settlement_outbox.sql')
  assert.ok(manifest.deploymentOrder.indexOf('capture-outbox-database-additive') < manifest.deploymentOrder.indexOf('capture-outbox-schema-cache-readiness'))
  assert.ok(manifest.deploymentOrder.indexOf('capture-outbox-schema-cache-readiness') < manifest.deploymentOrder.indexOf('capture-outbox-consumer-ready'))
  assert.ok(manifest.deploymentOrder.indexOf('capture-outbox-consumer-ready') < manifest.deploymentOrder.indexOf('render-proxy'))
  assert.deepEqual(manifest.captureOutbox.rollback.requiredOutboxCounts, { pending: 0, error: 0, processing: 0, dead_letter: 0 })
  assert.equal(manifest.captureOutbox.rollback.keepNewConsumerUntilDrainZero, true)
  assert.equal(manifest.captureOutbox.rollback.preserveAcknowledgedFinals, true)
})

test('operations runbook preserves the new consumer after ACK until drain is zero', () => {
  const runbook = readFileSync(new URL('../../docs/runbooks/v105-capture-outbox-operations.md', import.meta.url), 'utf8')
  assert.match(runbook, /舊 Proxy[\s\S]*pending=0[\s\S]*error=0[\s\S]*processing=0[\s\S]*dead_letter=0/i)
  assert.match(runbook, /保留新 consumer/i)
  assert.match(runbook, /已 ACK Final/i)
})
