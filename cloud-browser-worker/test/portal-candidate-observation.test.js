import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { extractSnapshotFromPayloads } from '../src/snapshot.js'
import { isFormalTenTableSnapshot, refreshMtSession } from '../src/portal-session.js'

// Exercise the actual server function without importing the listening server,
// loading credentials, opening sockets, or starting a browser.
const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
const start = source.indexOf('async function validateCandidatePage(')
const end = source.indexOf('\nasync function activateCandidatePage(', start)
assert.ok(start >= 0 && end > start)

async function observe(ids) {
  let clock = 0
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock } },
    process: { env: { PORTAL_CANDIDATE_TIMEOUT_MS: '1' } },
    PAGE_TIMEOUT_MS: 1, BASE_SESSION_ID: 'offline-fixture', pageGeneration: 0,
    captureSessionId: () => 'offline-fixture',
    collectBrowserPayload: async () => ({}),
    extractSnapshotFromPayloads: (payloads, options) => extractSnapshotFromPayloads(payloads, { ...options, now: '2026-10-30T00:00:00Z' }),
    isFormalTenTableSnapshot,
  })
  const validate = vm.runInContext(`${source.slice(start, end)}; validateCandidatePage`, context)
  const snapshot = await validate({ url: () => 'https://offline.invalid/', waitForTimeout: async () => { clock += 1000 } }, {
    payloads: ids.map(table_id => JSON.stringify({ action: '/api/v1/gametype/*/game/*/room/*/table/*/wait', body: { table_id, room_id: 'fixture', shoe: 1, round: 2 } })),
  })
  return snapshot
}

const five = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05']
test('candidate timeout retains observed five tables instead of fabricating unauthenticated zero; admission stays closed', async () => {
  const snapshot = await observe(five)
  assert.equal(snapshot.authenticated, true)
  assert.deepEqual(snapshot.tables.map(t => t.tableId), five)
  assert.equal(isFormalTenTableSnapshot(snapshot), false)
})

test('candidate complete six-table observation still passes admission', async () => {
  const snapshot = await observe([...five, 'BAV06'])
  assert.equal(isFormalTenTableSnapshot(snapshot), true)
})

test('candidate genuinely empty observation remains unauthenticated and rejected', async () => {
  const snapshot = await observe([])
  assert.equal(snapshot.authenticated, false)
  assert.equal(snapshot.tables.length, 0)
  assert.equal(isFormalTenTableSnapshot(snapshot), false)
})

test('incomplete observed candidate closes without persistence or activation', async () => {
  let closed = 0
  const page = { url: () => 'https://offline.invalid/game' }
  const context = {
    newPage: async () => page,
    storageState: async () => assert.fail('must reject before persistence'),
    close: async () => { closed += 1 },
  }
  await assert.rejects(refreshMtSession({
    browser: { newContext: async () => context },
    configuredMtUrl: 'https://offline.invalid/',
    login: async () => {}, openMt: async () => page,
    validate: async () => observe(five),
    activate: async () => assert.fail('must not activate incomplete candidate'),
  }), /portal_auth_refresh_failed/)
  assert.equal(closed, 1)
})
