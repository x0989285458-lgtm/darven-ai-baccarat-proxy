import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

test('server defaults to API owner and wires journal ACK through the existing snapshot pusher', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  assert.match(source, /MT_SOURCE_MODE\s*=\s*process\.env\.MT_SOURCE_MODE\s*\?\?\s*'api'/)
  assert.match(source, /getSnapshot:\s*getOwnedSnapshot/)
  assert.match(source, /onAcknowledged:\s*acknowledgeOwnedSnapshot/)
  assert.match(source, /createWorkerSourceRuntime/)
  assert.match(source, /createPersistedPortalSessionManager/)
  assert.match(source, /createFinalJournal/)
  assert.match(source, /bootstrapFromSnapshotPusherCursor/)
  const canonicalRuntime = source.slice(source.indexOf('async function ensureSourceRuntime'), source.indexOf('async function readOptionalJson'))
  assert.ok(canonicalRuntime.indexOf('bootstrapFromSnapshotPusherCursor') < canonicalRuntime.indexOf('await runtime.start()'), 'exact-ACK cursor bootstrap must finish before the API socket runtime starts')
  assert.match(source, /createBackupJournalReplayProvider/)
  assert.match(source, /MT_BACKUP_FINAL_JOURNAL_PATH/)
  assert.match(source, /MT_BACKUP_SESSION_TOKEN_FILE/)
  assert.doesNotMatch(source, /MT_SECOND_SESSION_TOKEN_AVAILABLE/)
  assert.match(source, /await quiesceWorkerProducers\(\{[\s\S]*sourceRuntime,[\s\S]*snapshotPusher,[\s\S]*abortAfterTimeout:/)
})

test('Reviewer P1 server wiring: browser, backup role, and stale backup env fail before server listen', () => {
  const cases = [
    { MT_SOURCE_MODE: 'browser', MT_CAPTURE_ROLE: 'canonical', expected: 'release_runtime_source_mode_must_be_api' },
    { MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'backup-journal', expected: 'release_runtime_capture_role_must_be_canonical' },
    { MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical', MT_BACKUP_FINAL_JOURNAL_PATH: 'stale.jsonl', expected: 'release_runtime_backup_environment_must_be_empty' },
    { MT_SOURCE_MODE: 'api', MT_CAPTURE_ROLE: 'canonical', MT_BACKUP_SESSION_TOKEN_FILE: 'stale-token', expected: 'release_runtime_backup_environment_must_be_empty' },
  ]
  for (const fixture of cases) {
    const { expected, ...runtime } = fixture
    const result = spawnSync(process.execPath, ['src/server.js'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, NODE_ENV: 'development', PORT: '-1', PUSH_TARGET_URL: '', INGEST_KEY: '', ...runtime },
    })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(expected))
  }
})

test('Reviewer P1 rollback producer quiesce stops every Final producer before pusher drain and awaits in-flight settlement', async () => {
  let shutdownModule = null
  try {
    shutdownModule = await import('../src/worker-shutdown.js')
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  assert.equal(typeof shutdownModule?.quiesceWorkerProducers, 'function')
  const events = []
  const dependency = (label) => ({ stop: async () => { events.push(`${label}.stop`) } })
  const snapshotPusher = {
    drain: async () => { events.push('pusher.drain') },
    stopAndWait: async (options) => { events.push(`pusher.stopAndWait:${options.abortAfterTimeout}`) },
  }
  await shutdownModule.quiesceWorkerProducers({
    sourceRuntime: dependency('api'),
    backupJournalRuntime: dependency('backup'),
    browserSourceRuntime: dependency('browser'),
    snapshotPusher,
    abortAfterTimeout: 25,
    closeBrowser: async () => { events.push('browser.close') },
  })
  assert.deepEqual(events, [
    'api.stop', 'backup.stop', 'browser.stop',
    'pusher.drain', 'pusher.stopAndWait:25', 'browser.close',
  ])
})
