import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { PRODUCTION_TABLE_IDS } from '../src/table-policy.js'
import { buildWorkerHealth } from '../src/worker-health.js'

const serverUrl = new URL('../src/server.js', import.meta.url)
const source = await readFile(serverUrl, 'utf8')
const start = source.indexOf('const server = http.createServer(')
const end = source.indexOf('\nserver.listen(', start)
assert.ok(start >= 0 && end > start, 'locate the real production HTTP handler')
// Execute the unchanged caller, not a reconstructed buildWorkerHealth call.
// Resolve its actual named imports; only HTTP creation/output and runtime state
// are replaced, so this probe cannot launch a browser, provider, or listener.
const bindings = {}
for (const match of source.matchAll(/^import \{ ([^\n]+) \} from '(\.\/(?:worker-health|snapshot|runtime-config|table-policy)\.js)'$/gm)) {
  const module = await import(new URL(match[2], serverUrl))
  for (const name of match[1].split(',').map(value => value.trim())) bindings[name] = module[name]
}

async function health(overrides = {}) {
  let handler
  let response
  const snapshot = {
    connected: true, authenticated: true, joined: true,
    tables: PRODUCTION_TABLE_IDS.map(tableId => ({ tableId })),
    sourceProgressAt: new Date().toISOString(),
    ...overrides.source,
  }
  runInNewContext(source.slice(start, end), {
    ...bindings, URL,
    http: { createServer(callback) { handler = callback } },
    SERVICE: 'darven-cloud-browser-worker', MT_CAPTURE_ROLE: 'canonical',
    MT_LOGIN_URL: 'https://offline.invalid/', lastError: overrides.sourceError ?? null,
    lastSnapshot: snapshot, snapshotPusher: { snapshot: () => overrides.push ?? {} },
    sendJson(_res, status, body) { response = { status, body } },
  }, { filename: serverUrl.pathname })
  await handler({ method: 'GET', url: '/health', headers: { host: 'localhost' } }, {})
  return response
}

test('production /health accepts the exact active six-table cohort', async () => {
  assert.equal(PRODUCTION_TABLE_IDS.length, 6)
  const result = await health()
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.ok, true)
  assert.equal(result.body.reason, null)
  assert.equal(result.body.source.tableCount, PRODUCTION_TABLE_IDS.length)
})

test('production /health still rejects missing, extra and historical table counts', async () => {
  for (const tableCount of [5, 7, 10]) {
    const result = await health({ source: { tableCount } })
    assert.equal(result.status, 503)
    assert.equal(result.body.reason, 'source_unavailable')
  }
})

test('production /health preserves source, freshness and push failure gates', async () => {
  for (const [overrides, reason] of [
    [{ source: { connected: false } }, 'source_unavailable'],
    [{ source: { authenticated: false } }, 'source_unavailable'],
    [{ source: { joined: false } }, 'source_unavailable'],
    [{ source: { sourceProgressAt: null } }, 'source_progress_stale'],
    [{ source: { sourceProgressAt: '2000-01-01T00:00:00.000Z' } }, 'source_progress_stale'],
    [{ sourceError: 'source failed' }, 'source_error'],
    [{ push: { queueEntryCount: 1, consecutiveFailures: 1, lastError: 'delivery failed' } }, 'push_delivery_failed'],
    [{ push: { stateInvalid: true } }, 'push_durable_state_invalid'],
    [{ push: { legacyMutableQueueDetected: true } }, 'legacy_mutable_queue_requires_cutover'],
  ]) {
    const result = await health(overrides)
    assert.equal(result.status, 503)
    assert.equal(result.body.reason, reason)
  }
})

test('shared worker-health retains its historical default of ten', () => {
  const options = { configured: true, source: {
    connected: true, authenticated: true, tableCount: 10,
    sourceProgressAt: new Date().toISOString(),
  } }
  assert.equal(buildWorkerHealth(options).ok, true)
  options.source.tableCount = PRODUCTION_TABLE_IDS.length
  assert.equal(buildWorkerHealth(options).reason, 'source_unavailable')
})
