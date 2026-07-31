import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPersistedPortalSessionManager } from '../src/portal-session-manager.js'

test('session manager reads the VM persisted portal session without exposing it in state', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-portal-manager-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sessionPath = path.join(dir, 'mt-session.json')
  await writeFile(sessionPath, JSON.stringify({
    version: 1,
    url: 'https://mt.example/game?token=opaque-fixture-value',
    storageState: { cookies: [], origins: [] },
  }))
  const manager = createPersistedPortalSessionManager({ sessionPath })

  assert.equal(await manager.getSessionToken(), 'opaque-fixture-value')
  assert.deepEqual(manager.snapshot(), { configured: true, loaded: true, refreshes: 0, lastError: null })
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /opaque-fixture-value/)
})

test('session manager refreshes through the existing portal refresh owner then reloads persisted state', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-portal-refresh-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sessionPath = path.join(dir, 'mt-session.json')
  await writeFile(sessionPath, JSON.stringify({ version: 1, url: 'https://mt.example/game', storageState: { cookies: [], origins: [] } }))
  let refreshes = 0
  const manager = createPersistedPortalSessionManager({
    sessionPath,
    refresh: async () => {
      refreshes += 1
      await writeFile(sessionPath, JSON.stringify({
        version: 1, url: 'https://mt.example/game',
        storageState: { cookies: [], origins: [{ origin: 'https://mt.example', localStorage: [{ name: 'token', value: 'refreshed-fixture-value' }] }] },
      }))
    },
  })

  await assert.rejects(manager.getSessionToken(), /portal_session_token_unavailable/)
  await manager.refresh({ reason: 'authenticate_err_21' })
  assert.equal(await manager.getSessionToken(), 'refreshed-fixture-value')
  assert.equal(refreshes, 1)
  assert.equal(manager.snapshot().refreshes, 1)
})
