import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PORTAL_SELECTORS,
  assertAllowedMtUrl,
  createPortalRefreshController,
  openPortalMtPage,
  loginPortalPage,
  persistCandidateSession,
  readPortalCredentials,
  recoverRedirectedInitialSession,
  refreshMtSession,
} from '../src/portal-session.js'

const productionTables = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
const healthy = { connected: true, authenticated: true, tables: productionTables.map((tableId) => ({ tableId })) }
const expired = { connected: true, authenticated: false, tables: [] }

test('portal selectors target credentials, submit, announcement close, and MT真人 without opt-out checkbox', () => {
  assert.match(PORTAL_SELECTORS.username.join(' '), /user|account|帳號/i)
  assert.equal(PORTAL_SELECTORS.username.includes('input[type="text"]'), false)
  assert.match(PORTAL_SELECTORS.username.join(' '), /:not\(\[readonly\]\).*:not\(\[role="combobox"\]\)/i)
  assert.match(PORTAL_SELECTORS.password.join(' '), /password|密碼/i)
  assert.match(PORTAL_SELECTORS.submit.join(' '), /submit|login|登入/i)
  assert.match(PORTAL_SELECTORS.announcementClose.join(' '), /close|關閉|×/i)
  assert.doesNotMatch(PORTAL_SELECTORS.announcementClose.join(' '), /checkbox|不再顯示/i)
  assert.deepEqual(PORTAL_SELECTORS.mtCasinoText, ['MT真人'])
})

test('portal login closes layered notices, opens the login view, fills credentials, and clicks the final 登入 action', async () => {
  const page = fakePortalLoginPage()
  await loginPortalPage(page, { username: 'safe-user', password: 'safe-pass' }, { timeoutMs: 100 })
  assert.deepEqual(page.filled, { username: 'safe-user', password: 'safe-pass' })
  assert.equal(page.loginClicks, 2)
  assert.equal(page.noticeClicks, 6)
  assert.equal(page.stage(), 'authenticated')
})

test('portal login waits for delayed announcement layers before opening the login view', async () => {
  const page = fakePortalLoginPage({ delayedInitialNotices: true })
  await loginPortalPage(page, { username: 'safe-user', password: 'safe-pass' }, { timeoutMs: 100 })
  assert.equal(page.stage(), 'authenticated')
  assert.equal(page.noticeClicks, 6)
})

test('portal MT opening accepts a popup page', async () => {
  const portal = fakePage('https://ag001.3a1788.bet/')
  const popup = fakePage('https://mt.example/game')
  const context = fakeContext([popup])
  const result = await openPortalMtPage({ context, portalPage: portal, timeoutMs: 20 })
  assert.equal(result, popup)
  assert.deepEqual(portal.clickedText, [])
  assert.equal(portal.clickedSelectors.length, 3)
  assert.ok(portal.clickedSelectors.every((selector) => selector === 'div.absolute.top-3.right-5.cursor-pointer.font-bold.text-xl'))
  assert.deepEqual(portal.clickedMtText, ['MT真人'])
})

test('portal MT popup listener starts only after a delayed MT control becomes visible', async () => {
  let visible = false
  let resolvePopup
  const popup = fakePage('https://mt.example/game')
  const context = {
    waitForEvent() {
      assert.equal(visible, true, 'popup listener started before the MT control became visible')
      return new Promise((resolve) => { resolvePopup = resolve })
    },
  }
  const portal = {
    locator() {
      const hidden = () => ({ isVisible: async () => false })
      return { first: hidden, last: hidden }
    },
    getByText(text) {
      const item = () => ({
        waitFor: async () => {
          if (text === 'MT真人') { await new Promise((resolve) => setTimeout(resolve, 10)); visible = true }
        },
        isVisible: async () => text === '真人' || visible,
        click: async () => {
          if (text === '真人') visible = true
          else resolvePopup(popup)
        },
      })
      return { first: item, last: item }
    },
  }
  assert.equal(await openPortalMtPage({ context, portalPage: portal, timeoutMs: 100 }), popup)
})

test('portal MT opening accepts same-tab navigation', async () => {
  const portal = fakePage('https://ag001.3a1788.bet/', { sameTabUrl: 'https://mt.example/game' })
  const context = fakeContext([null])
  const result = await openPortalMtPage({ context, portalPage: portal, timeoutMs: 20 })
  assert.equal(result, portal)
  assert.equal(result.url(), 'https://mt.example/game')
})

test('candidate MT URL requires HTTPS and the configured MT host or explicit allowlist', () => {
  assert.equal(assertAllowedMtUrl('https://mt.example/game', 'https://mt.example/login'), 'https://mt.example/game')
  assert.equal(assertAllowedMtUrl('https://backup.example/game', 'https://mt.example/login', ['backup.example']), 'https://backup.example/game')
  assert.throws(() => assertAllowedMtUrl('http://mt.example/game', 'https://mt.example/login'), /HTTPS/)
  assert.throws(() => assertAllowedMtUrl('https://evil.example/game', 'https://mt.example/login'), /allowlist/)
  assert.throws(() => assertAllowedMtUrl('https://mt.example:444/game', 'https://mt.example/login'), /allowlist/)
  assert.equal(assertAllowedMtUrl('https://mt.example:444/game', 'https://mt.example/login', ['mt.example:444']), 'https://mt.example:444/game')
})

test('expired initial redirect closes the old context and refreshes through the verified portal candidate', async () => {
  const events = []
  const candidate = { connected: true, authenticated: true, tables: productionTables.map((tableId) => ({ tableId })) }
  const result = await recoverRedirectedInitialSession({
    navigationResponse: redirectedResponse(),
    refreshEnabled: true,
    closeExpired: async () => { events.push('closed') },
    refresh: async () => { events.push('refreshed'); return candidate },
  })
  assert.deepEqual(events, ['closed', 'refreshed'])
  assert.equal(result, candidate)
})

test('initial redirect remains fail-closed when portal refresh is not configured', async () => {
  await assert.rejects(
    recoverRedirectedInitialSession({
      navigationResponse: redirectedResponse(),
      refreshEnabled: false,
      closeExpired: async () => assert.fail('must not close into a refresh path'),
      refresh: async () => assert.fail('must not refresh without credentials'),
    }),
    /redirect/i,
  )
})

test('same-page incident triggers after two expired snapshots, caps at two attempts, backs off, and reports only category', async () => {
  let now = 100
  let calls = 0
  const secret = 'portal-password-should-never-escape'
  const controller = createPortalRefreshController({
    enabled: true,
    now: () => now,
    baseBackoffMs: 50,
    refresh: async () => { calls += 1; throw new Error(`login failed ${secret}`) },
  })

  assert.deepEqual(await controller.observe(expired, 'page-1'), { attempted: false })
  assert.deepEqual(await controller.observe(expired, 'page-1'), { attempted: true })
  assert.equal(calls, 1)
  now = 120
  assert.deepEqual(await controller.observe(expired, 'page-1'), { attempted: false })
  now = 150
  assert.deepEqual(await controller.observe(expired, 'page-1'), { attempted: true, errorCategory: 'portal_auth_refresh_failed' })
  assert.equal(calls, 2)
  now = 1000
  assert.deepEqual(await controller.observe(expired, 'page-1'), { attempted: false, errorCategory: 'portal_auth_refresh_failed' })
  assert.equal(calls, 2)
  assert.doesNotMatch(JSON.stringify(controller.state()), new RegExp(secret))
})

test('a formal ten-table snapshot clears the incident and a successful refresh resets silently', async () => {
  let calls = 0
  const controller = createPortalRefreshController({ enabled: true, refresh: async () => { calls += 1 } })
  await controller.observe(expired, 'page-1')
  await controller.observe(healthy, 'page-1')
  assert.deepEqual(controller.state(), { pageKey: null, consecutive: 0, attempts: 0, locked: false, nextAttemptAt: 0 })
  await controller.observe(expired, 'page-1')
  assert.deepEqual(await controller.observe(expired, 'page-1'), { attempted: true })
  assert.equal(calls, 1)
  assert.deepEqual(controller.state(), { pageKey: null, consecutive: 0, attempts: 0, locked: false, nextAttemptAt: 0 })
})

test('concurrent snapshots cannot start duplicate refresh attempts', async () => {
  let release
  let calls = 0
  const pending = new Promise((resolve) => { release = resolve })
  const controller = createPortalRefreshController({
    enabled: true,
    refresh: async () => { calls += 1; await pending; throw new Error('failed') },
  })
  await controller.observe(expired, 'page-1')
  const first = controller.observe(expired, 'page-1')
  const duplicate = controller.observe(expired, 'page-1')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  await Promise.all([first, duplicate])
  assert.equal(calls, 1)
})

test('formal ten-table recovery stays reset when an older in-flight attempt later fails', async () => {
  let rejectRefresh
  const pending = new Promise((_, reject) => { rejectRefresh = reject })
  const controller = createPortalRefreshController({ enabled: true, refresh: async () => pending })
  await controller.observe(expired, 'page-1')
  const attempt = controller.observe(expired, 'page-1')
  await new Promise((resolve) => setImmediate(resolve))
  await controller.observe(healthy, 'page-1')
  rejectRefresh(new Error('stale failure'))
  await attempt
  assert.deepEqual(controller.state(), { pageKey: null, consecutive: 0, attempts: 0, locked: false, nextAttemptAt: 0 })
})

test('secret file is optional, parsed from path, never persisted, and session write leaves Queue/Cursor unchanged', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-portal-session-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const secretPath = path.join(dir, 'portal-secret.json')
  const sessionPath = path.join(dir, 'mt-session.json')
  const queuePath = path.join(dir, 'latest-snapshot.json')
  const cursorPath = `${queuePath}.cursor.json`
  await writeFile(secretPath, JSON.stringify({ username: 'agent-user', password: 'agent-pass' }))
  await writeFile(queuePath, 'queue-before')
  await writeFile(cursorPath, 'cursor-before')

  assert.equal(await readPortalCredentials(''), null)
  assert.deepEqual(await readPortalCredentials(secretPath), { username: 'agent-user', password: 'agent-pass' })
  await persistCandidateSession(sessionPath, {
    url: 'https://mt.example/game?token=session-token',
    storageState: { cookies: [{ name: 'sid', value: 'cookie-secret' }], origins: [] },
  })

  assert.equal(await readFile(queuePath, 'utf8'), 'queue-before')
  assert.equal(await readFile(cursorPath, 'utf8'), 'cursor-before')
  const session = JSON.parse(await readFile(sessionPath, 'utf8'))
  assert.equal(session.url, 'https://mt.example/game?token=session-token')
  assert.equal(session.storageState.cookies[0].value, 'cookie-secret')
  assert.doesNotMatch(await readFile(sessionPath, 'utf8'), /agent-user|agent-pass/)
})

test('candidate session validates formal ten tables, persists, then atomically activates', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darven-candidate-session-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sessionPath = path.join(dir, 'mt-session.json')
  const candidatePage = fakePage('https://mt.example/game')
  const context = {
    newPage: async () => fakePage('https://ag001.3a1788.bet/'),
    storageState: async () => ({ cookies: [{ name: 'sid', value: 'candidate' }], origins: [] }),
    close: async () => { throw new Error('validated context must remain open') },
  }
  const events = []

  const result = await refreshMtSession({
    browser: { newContext: async () => context },
    credentials: { username: 'agent-user', password: 'agent-pass' },
    configuredMtUrl: 'https://mt.example/login',
    sessionPath,
    login: async () => { events.push('login') },
    openMt: async () => candidatePage,
    validate: async () => { events.push('validate'); return healthy },
    activate: async ({ page }) => {
      assert.equal(page, candidatePage)
      assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).storageState.cookies[0].value, 'candidate')
      events.push('activate')
    },
  })

  assert.equal(result, undefined)
  assert.deepEqual(events, ['login', 'validate', 'activate'])
})

test('invalid candidate is closed and exposes only portal_auth_refresh_failed', async () => {
  let closed = 0
  const context = {
    newPage: async () => fakePage('https://ag001.3a1788.bet/'),
    storageState: async () => ({ cookies: [], origins: [] }),
    close: async () => { closed += 1 },
  }
  await assert.rejects(
    refreshMtSession({
      browser: { newContext: async () => context },
      credentials: { username: 'secret-user', password: 'secret-pass' },
      configuredMtUrl: 'https://mt.example/login',
      sessionPath: 'unused.json',
      login: async () => {},
      openMt: async () => fakePage('https://mt.example/game'),
      validate: async () => expired,
      activate: async () => assert.fail('invalid candidate must not activate'),
    }),
    (error) => error.message === 'portal_auth_refresh_failed' && !/secret/.test(error.message),
  )
  assert.equal(closed, 1)
})

function fakePortalLoginPage({ delayedInitialNotices = false } = {}) {
  let currentStage = 'home'
  let remainingNotices = delayedInitialNotices ? 0 : 3
  let initialNoticesMaterialized = !delayedInitialNotices
  const page = {
    filled: {},
    loginClicks: 0,
    noticeClicks: 0,
    stage: () => currentStage,
    goto: async () => {},
    waitForTimeout: async () => {
      if (currentStage === 'home' && !initialNoticesMaterialized) {
        remainingNotices = 3
        initialNoticesMaterialized = true
      }
    },
    locator(selector) {
      const buildLocator = (topmost) => ({
        isVisible: async () => {
          if (selector === PORTAL_SELECTORS.announcementClose[0]) return remainingNotices > 0
          if (PORTAL_SELECTORS.username.includes(selector)) return currentStage === 'login' && selector === PORTAL_SELECTORS.username[0]
          if (PORTAL_SELECTORS.password.includes(selector)) return currentStage === 'login' && selector === PORTAL_SELECTORS.password[0]
          return false
        },
        fill: async (value) => {
          if (PORTAL_SELECTORS.username.includes(selector)) page.filled.username = value
          if (PORTAL_SELECTORS.password.includes(selector)) page.filled.password = value
        },
        click: async () => {
          if (selector === PORTAL_SELECTORS.announcementClose[0]) {
            if (!topmost) throw new Error('lower announcement is covered by the topmost overlay')
            remainingNotices -= 1
            page.noticeClicks += 1
          }
        },
      })
      return { first: () => buildLocator(false), last: () => buildLocator(true) }
    },
    getByText(text) {
      return {
        last: () => ({
          isVisible: async () => text === '登入' && (currentStage === 'home' || currentStage === 'login'),
          click: async () => {
            if (currentStage === 'home' && !initialNoticesMaterialized) {
              remainingNotices = 3
              initialNoticesMaterialized = true
            }
            if (remainingNotices > 0) throw new Error('announcement overlay intercepts login')
            page.loginClicks += 1
            if (currentStage === 'home') currentStage = 'login'
            else if (currentStage === 'login') {
              currentStage = 'authenticated'
              remainingNotices = 3
            }
          },
        }),
      }
    },
  }
  return page
}

function redirectedResponse() {
  return { request: () => ({ redirectedFrom: () => ({ url: () => 'https://mt.example/expired' }) }) }
}

function fakeContext(popups) {
  return {
    async waitForEvent() {
      const page = popups.shift()
      if (!page) throw new Error('timeout')
      return page
    },
  }
}

function fakePage(initialUrl, { sameTabUrl = null, announcementCount = 3 } = {}) {
  let currentUrl = initialUrl
  let remainingAnnouncements = announcementCount
  return {
    clickedText: [],
    clickedMtText: [],
    clickedSelectors: [],
    url: () => currentUrl,
    waitForTimeout: async () => {},
    locator(selector) {
      const announcementLocator = () => ({
        isVisible: async () => selector === PORTAL_SELECTORS.announcementClose[0] && remainingAnnouncements > 0,
        click: async () => {
          this.clickedSelectors.push(selector)
          remainingAnnouncements -= 1
        },
      })
      return { first: announcementLocator, last: announcementLocator }
    },
    getByText(text) {
      return {
        first: () => ({
          isVisible: async () => true,
          click: async () => {
            if (text === '真人') this.clickedText.push(text)
            if (text === 'MT真人') {
              this.clickedMtText.push(text)
              if (sameTabUrl) currentUrl = sameTabUrl
            }
          },
        }),
      }
    },
  }
}
