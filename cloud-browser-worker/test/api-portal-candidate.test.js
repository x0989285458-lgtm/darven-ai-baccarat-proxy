import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createApiCandidateCapture } from '../src/api-portal-candidate.js'
import { persistCandidateSession, refreshMtSession } from '../src/portal-session.js'

const auth = { action: '/api/v1/authenticate', err: 0 }
const chatAuth = { action: '/api/v1/chat/authenticate', err: 0 }
const tables = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05'].map((table_id, i) => ({ table_id, room_id: 48 + i, hall: 3, table_type: 'BAC', shoe: 1, round: 2 }))
const catalog = (rows = tables) => ({ action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: rows } })
function fixture() {
  const context = new EventEmitter()
  const capture = createApiCandidateCapture(context)
  const page = new EventEmitter()
  page.url = () => 'https://offline.invalid/game'
  context.emit('page', page)
  const game = new EventEmitter(), chat = new EventEmitter()
  page.emit('websocket', game); page.emit('websocket', chat)
  const receive = (packet, socket = game) => socket.emit('framereceived', { payload: JSON.stringify(packet) })
  const ready = () => { receive(auth); receive(chatAuth, chat); receive(catalog()) }
  return { context, capture, page, game, chat, receive, ready }
}

test('explicit candidate game/chat auth and authoritative catalog admit five valid tables with BAV06 quarantined', () => {
  const f = fixture(); f.ready()
  assert.equal(f.capture.admit(null, f.page), true)
  const missing = f.capture.snapshot(f.page).tables.find(t => t.table_id === 'BAV06')
  assert.equal(missing.catalogMissing, true)
  assert.equal(missing.catalogScreenInvalid, true)
  for (let i = 0; i < 1000; i++) f.receive({ action: 'wait', body: { table_id: 'BAV01' } })
  assert.equal(f.capture.admit(null, f.page), true)
})

test('broadcasts, sent auth, missing err, chat-only, unrelated page and socket cannot authorize', () => {
  const f = fixture()
  f.game.emit('framesent', { payload: JSON.stringify(auth) })
  f.receive(catalog()); f.receive(chatAuth, f.chat)
  assert.equal(f.capture.admit(null, f.page), false)
  f.receive({ action: auth.action }); f.receive(catalog())
  assert.equal(f.capture.admit(null, f.page), false)
  f.receive(auth)
  assert.equal(f.capture.admit(null, f.page), false, 'pre-auth catalog is not reused')
  f.receive(catalog(), f.chat)
  assert.equal(f.capture.admit(null, f.page), false)
  f.receive(catalog()); assert.equal(f.capture.admit(null, f.page), true)
  assert.equal(f.capture.admit(null, new EventEmitter()), false)
})

test('invalid identity, empty catalog and non-catalog tables cannot admit', () => {
  for (const packet of [catalog([]), catalog(tables.map(t => ({ ...t, room_id: 999 }))), catalog(tables.map(t => ({ ...t, table_id: 'OTHER' }))), { action: 'wait', msg: { tables } }]) {
    const f = fixture(); f.receive(auth); f.receive(chatAuth, f.chat); f.receive(packet)
    assert.equal(f.capture.admit(null, f.page), false)
  }
})

test('logout/errors revoke permanently even after rolling noise and late old auth/catalog', () => {
  for (const packet of [{ name: '/api/v1/member/logout', err: 0 }, { action: auth.action, err: 1 }, { action: 'error', err: 5 }]) {
    const f = fixture(); f.ready(); const old = f.capture.snapshot(f.page)
    f.receive(packet)
    for (let i = 0; i < 600; i++) f.receive({ action: 'wait' })
    f.ready()
    assert.equal(f.capture.admit(old, f.page), false)
  }
})

test('replacement socket needs its own catalog; invalid latest catalog cannot reuse earlier authority', () => {
  const f = fixture(); f.ready()
  const replacement = new EventEmitter(); f.page.emit('websocket', replacement)
  f.receive(auth, replacement)
  assert.equal(f.capture.admit(null, f.page), false)
  f.receive(catalog(), replacement)
  assert.equal(f.capture.admit(null, f.page), true)
  f.receive(catalog([{ ...tables[0], hall: 9 }]), replacement)
  assert.equal(f.capture.admit(null, f.page), false)
})

test('authenticated socket closure/error revokes candidate', () => {
  for (const event of ['close', 'socketerror']) {
    const f = fixture(); f.ready(); f.game.emit(event)
    assert.equal(f.capture.admit(null, f.page), false)
  }
})

test('production API refresh wires real receive capture, polling, admission and persistence without Join', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function refreshApiPersistedSession(')
  const end = source.indexOf('\nfunction prepareCandidateCapture(', start)
  const dir = await mkdtemp(path.join(tmpdir(), 'api-refresh-wiring-'))
  try {
    const context = new EventEmitter(), page = new EventEmitter()
    page.url = () => 'https://offline.invalid/game'
    page.waitForTimeout = async () => assert.fail('ready candidate should not time out')
    let closed = 0
    Object.assign(context, { newPage: async () => { context.emit('page', page); return page },
      close: async () => { closed++ }, storageState: async () => ({ cookies: [], origins: [] }) })
    const sandbox = vm.createContext({ process: { env: {} }, PAGE_TIMEOUT_MS: 1,
      PORTAL_CREDENTIALS_FILE: 'offline-fixture', MT_LOGIN_URL: page.url(), MT_ALLOWED_HOSTS: [],
      MT_SESSION_PATH: path.join(dir, 'session.json'), BROWSER_CONTEXT_OPTIONS: {},
      readPortalCredentials: async () => null, ensureBrowser: async () => ({ newContext: async () => context }),
      createApiCandidateCapture,
      refreshMtSession: options => refreshMtSession({ ...options, login: async () => {}, openMt: async () => {
        const game = new EventEmitter(), chat = new EventEmitter()
        page.emit('websocket', game); page.emit('websocket', chat)
        game.emit('framereceived', { payload: JSON.stringify(auth) })
        chat.emit('framereceived', { payload: JSON.stringify(chatAuth) })
        game.emit('framereceived', { payload: JSON.stringify(catalog()) })
        return page
      } }),
    })
    await vm.runInContext(`${source.slice(start, end)}; refreshApiPersistedSession()`, sandbox)
    assert.equal(JSON.parse(await readFile(path.join(dir, 'session.json'))).url, page.url())
    assert.equal(closed, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('refresh persistence uses API admission and rechecks revocation after storageState', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'api-refresh-'))
  try {
    for (const revoke of [false, true]) {
      const f = fixture(); f.ready()
      const sessionPath = path.join(dir, `${revoke}.json`)
      let activated = false, closed = false
      Object.assign(f.context, { newPage: async () => f.page, close: async () => { closed = true }, storageState: async () => {
        if (revoke) f.receive({ name: '/api/v1/member/logout', err: 0 })
        return { cookies: [], origins: [] }
      } })
      const run = refreshMtSession({ browser: { newContext: async () => f.context }, configuredMtUrl: f.page.url(), sessionPath,
        prepareContext: () => f.capture, login: async () => {}, openMt: async () => f.page,
        validate: async () => f.capture.snapshot(f.page), admit: f.capture.admit,
        activate: async () => { activated = true } })
      if (revoke) {
        await assert.rejects(run, /portal_auth_refresh_failed/)
        await assert.rejects(readFile(sessionPath), { code: 'ENOENT' })
        assert.equal(closed, true); assert.equal(activated, false)
      } else { await run; assert.equal(activated, true); assert.equal(JSON.parse(await readFile(sessionPath)).version, 1) }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('revocation at file commit preserves the previous persisted session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'api-refresh-commit-'))
  const sessionPath = path.join(dir, 'session.json')
  try {
    await persistCandidateSession(sessionPath, { url: 'https://offline.invalid/previous', storageState: {} })
    const f = fixture(); f.ready()
    await assert.rejects(persistCandidateSession(sessionPath, { url: f.page.url(), storageState: {} }, () => {
      f.receive({ name: '/api/v1/member/logout', err: 0 })
      return f.capture.admit(null, f.page)
    }), /revoked/)
    assert.equal(JSON.parse(await readFile(sessionPath)).url, 'https://offline.invalid/previous')
    await assert.rejects(readFile(`${sessionPath}.tmp`), { code: 'ENOENT' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('reviewer rename race: commit is admitted and queued logout prevents activation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'api-refresh-rename-race-'))
  const sessionPath = path.join(dir, 'session.json')
  const originalRename = fsPromises.rename, originalRenameSync = fs.renameSync
  const f = fixture(); f.ready()
  let commits = 0, syncCommits = 0, admittedAtCommit, activated = false, closed = false
  const logout = () => f.receive({ name: '/api/v1/member/logout', err: 0 })
  try {
    await persistCandidateSession(sessionPath, { url: 'https://offline.invalid/previous', storageState: {} })
    // Preserve the reviewer's real async-rename counterexample on the old code.
    // Instrument the NEW sync seam too: a queued logout cannot interleave with
    // disk commit, but runs before refresh resumes from await persistence.
    fsPromises.rename = async (...args) => {
      await Promise.resolve(); logout()
      commits++; admittedAtCommit = f.capture.admit(null, f.page)
      return originalRename(...args)
    }
    fs.renameSync = (...args) => {
      queueMicrotask(logout)
      commits++; syncCommits++; admittedAtCommit = f.capture.admit(null, f.page)
      return originalRenameSync(...args)
    }
    syncBuiltinESMExports()
    Object.assign(f.context, { newPage: async () => f.page,
      close: async () => { closed = true }, storageState: async () => ({ cookies: [], origins: [] }) })
    let failure
    await refreshMtSession({ browser: { newContext: async () => f.context }, configuredMtUrl: f.page.url(), sessionPath,
      prepareContext: () => f.capture, login: async () => {}, openMt: async () => f.page,
      validate: async () => f.capture.snapshot(f.page), admit: f.capture.admit,
      activate: async () => { activated = true } }).catch(error => { failure = error })
    assert.equal(commits, 1, 'real filesystem commit seam must execute exactly once')
    assert.equal(admittedAtCommit, true, 'revoked candidate must never commit')
    assert.equal(syncCommits, 1, 'new synchronous commit seam must be exercised')
    assert.equal(f.capture.admit(null, f.page), false, 'real logout handler must execute')
    assert.equal(activated, false, 'revocation before activation must reject')
    assert.match(failure?.message ?? '', /portal_auth_refresh_failed/)
    assert.equal(closed, true)
    // Logout AFTER the linearization point does not retroactively undo commit.
    assert.equal(JSON.parse(await readFile(sessionPath)).url, f.page.url())
    await assert.rejects(readFile(`${sessionPath}.tmp`), { code: 'ENOENT' })
  } finally {
    fsPromises.rename = originalRename; fs.renameSync = originalRenameSync
    syncBuiltinESMExports()
    await rm(dir, { recursive: true, force: true })
  }
})
