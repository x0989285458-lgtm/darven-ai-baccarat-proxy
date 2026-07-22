import path from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { PRODUCTION_TABLE_IDS, canonicalProductionTableId } from './table-policy.js'
import { assertMtNavigationResponse } from './runtime-config.js'

export const PORTAL_URL = 'https://ag001.3a1788.bet/'

export const PORTAL_SELECTORS = Object.freeze({
  username: Object.freeze([
    'input[name="username"]', 'input[name="account"]', 'input[autocomplete="username"]',
    'input[placeholder*="帳號"]', 'input[placeholder*="账号"]',
    'input[type="text"]:not([readonly]):not([role="combobox"])',
  ]),
  password: Object.freeze([
    'input[name="password"]', 'input[autocomplete="current-password"]',
    'input[placeholder*="密碼"]', 'input[placeholder*="密码"]', 'input[type="password"]',
  ]),
  submit: Object.freeze([
    'button[type="submit"]', 'input[type="submit"]', 'button:has-text("登入")',
    '[role="button"]:has-text("登入")', 'button:has-text("Login")',
  ]),
  announcementClose: Object.freeze([
    'div.absolute.top-3.right-5.cursor-pointer.font-bold.text-xl',
    'button[aria-label="關閉"]', 'button[aria-label="关闭"]', 'button[aria-label="Close"]',
    '.modal button.close', '.announcement button.close', '[class*="modal"] [class*="close"]',
    '[class*="announcement"] [class*="close"]', '.el-dialog__headerbtn', '.van-popup__close-icon',
    'button:has-text("×")',
  ]),
  mtCasinoText: Object.freeze(['MT真人']),
})

export async function readPortalCredentials(secretPath) {
  if (!String(secretPath ?? '').trim()) return null
  let value
  try {
    value = JSON.parse(await readFile(String(secretPath), 'utf8'))
  } catch {
    throw new Error('portal credentials secret could not be read')
  }
  const username = String(value?.username ?? '').trim()
  const password = String(value?.password ?? '')
  if (!username || !password) throw new Error('portal credentials secret is invalid')
  return { username, password }
}

export async function loginPortalPage(page, credentials, { portalUrl = PORTAL_URL, timeoutMs = 45000 } = {}) {
  const parsed = new URL(String(portalUrl))
  if (parsed.protocol !== 'https:') throw new Error('Portal URL must use HTTPS')
  await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.waitForTimeout?.(1000)
  await closeAnnouncement(page)
  if (!await hasVisible(page, PORTAL_SELECTORS.username)) {
    await clickExactTextAfterClosingAnnouncements(page, '登入')
    await waitForVisible(page, PORTAL_SELECTORS.username, timeoutMs)
  }
  await fillFirstVisible(page, PORTAL_SELECTORS.username, credentials.username)
  await fillFirstVisible(page, PORTAL_SELECTORS.password, credentials.password)
  if (!await clickFirstVisible(page, PORTAL_SELECTORS.submit)) await clickExactText(page, '登入')
  await page.waitForTimeout?.(1000)
  await closeAnnouncement(page)
}

export async function openPortalMtPage({ context, portalPage, timeoutMs = 45000 } = {}) {
  await closeAnnouncement(portalPage)
  return clickTextAndCapturePopup(context, portalPage, PORTAL_SELECTORS.mtCasinoText[0], timeoutMs)
}

export function assertAllowedMtUrl(candidateUrl, configuredMtUrl, allowedHosts = []) {
  const candidate = new URL(String(candidateUrl))
  const configured = new URL(String(configuredMtUrl))
  if (candidate.protocol !== 'https:') throw new Error('Candidate MT URL must use HTTPS')
  const hosts = new Set([configured.host, ...normalizeAllowedHosts(allowedHosts)])
  if (!hosts.has(candidate.host)) throw new Error('Candidate MT host is not in the MT allowlist')
  return candidate.href
}

export function parseMtHostAllowlist(value) {
  return normalizeAllowedHosts(String(value ?? '').split(','))
}

export async function persistCandidateSession(sessionPath, session) {
  if (!String(sessionPath ?? '').trim()) throw new Error('MT session path is required')
  const target = String(sessionPath)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify({
    version: 1,
    url: String(session.url),
    storageState: session.storageState,
  }), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

export async function readPersistedSession(sessionPath, configuredMtUrl, allowedHosts = []) {
  if (!String(sessionPath ?? '').trim()) return null
  try {
    const value = JSON.parse(await readFile(String(sessionPath), 'utf8'))
    if (value?.version !== 1 || !value?.storageState || typeof value.storageState !== 'object') return null
    return {
      url: assertAllowedMtUrl(value.url, configuredMtUrl, allowedHosts),
      storageState: value.storageState,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return null
  }
}

export async function recoverRedirectedInitialSession({
  navigationResponse,
  refreshEnabled = false,
  closeExpired,
  refresh,
} = {}) {
  try {
    assertMtNavigationResponse(navigationResponse)
    return null
  } catch (error) {
    if (!refreshEnabled || typeof refresh !== 'function') throw error
    await closeExpired?.()
    return refresh()
  }
}

export async function refreshMtSession({
  browser,
  credentials,
  configuredMtUrl,
  allowedHosts = [],
  sessionPath,
  contextOptions = {},
  timeoutMs = 45000,
  prepareContext = async () => null,
  login = loginPortalPage,
  openMt = openPortalMtPage,
  validate,
  activate,
} = {}) {
  let context = null
  try {
    context = await browser.newContext(contextOptions)
    const prepared = await prepareContext(context)
    const portalPage = await context.newPage()
    await login(portalPage, credentials, { portalUrl: PORTAL_URL, timeoutMs })
    const candidatePage = await openMt({ context, portalPage, timeoutMs })
    await candidatePage.waitForLoadState?.('domcontentloaded', { timeout: timeoutMs }).catch(() => {})
    const candidateUrl = assertAllowedMtUrl(candidatePage.url(), configuredMtUrl, allowedHosts)
    const snapshot = await validate(candidatePage, prepared)
    if (!isFormalTenTableSnapshot(snapshot)) throw new Error('candidate MT session did not expose the formal tables')
    const storageState = await context.storageState()
    await persistCandidateSession(sessionPath, { url: candidateUrl, storageState })
    await activate({ page: candidatePage, context, snapshot, prepared })
    context = null
  } catch {
    await context?.close().catch(() => {})
    throw new Error('portal_auth_refresh_failed')
  }
}

export function isFormalTenTableSnapshot(snapshot) {
  if (snapshot?.connected !== true || snapshot?.authenticated !== true || !Array.isArray(snapshot.tables)) return false
  const ids = new Set(snapshot.tables.map((table) => canonicalProductionTableId(table?.tableId ?? table?.table_id)))
  return ids.size === PRODUCTION_TABLE_IDS.length && PRODUCTION_TABLE_IDS.every((tableId) => ids.has(tableId))
}

export function createPortalRefreshController({
  enabled = false,
  refresh,
  maxAttempts = 2,
  baseBackoffMs = 5000,
  now = Date.now,
} = {}) {
  let pageKey = null
  let consecutive = 0
  let attempts = 0
  let locked = false
  let nextAttemptAt = 0
  let refreshing = false
  let incidentVersion = 0

  function reset() {
    pageKey = null
    consecutive = 0
    attempts = 0
    locked = false
    nextAttemptAt = 0
    incidentVersion += 1
  }

  async function observe(snapshot, observedPageKey) {
    if (!enabled || typeof refresh !== 'function') return { attempted: false }
    if (isFormalTenTableSnapshot(snapshot)) {
      reset()
      return { attempted: false }
    }

    const key = String(observedPageKey ?? '')
    if (pageKey !== key) {
      reset()
      pageKey = key
    }
    if (refreshing) return { attempted: false }
    const expired = snapshot?.connected === true
      && snapshot?.authenticated === false
      && Array.isArray(snapshot?.tables)
      && snapshot.tables.length === 0
    if (!expired) {
      consecutive = 0
      return locked
        ? { attempted: false, errorCategory: 'portal_auth_refresh_failed' }
        : { attempted: false }
    }

    consecutive += 1
    if (consecutive < 2) return { attempted: false }
    if (locked) return { attempted: false, errorCategory: 'portal_auth_refresh_failed' }
    const timestamp = Number(now())
    if (timestamp < nextAttemptAt) return { attempted: false }

    attempts += 1
    const attemptVersion = incidentVersion
    refreshing = true
    try {
      await refresh()
      if (attemptVersion === incidentVersion) reset()
      return { attempted: true }
    } catch {
      if (attemptVersion !== incidentVersion) return { attempted: true }
      if (attempts >= Math.max(1, Number(maxAttempts) || 2)) {
        locked = true
        return { attempted: true, errorCategory: 'portal_auth_refresh_failed' }
      }
      nextAttemptAt = timestamp + Math.max(0, Number(baseBackoffMs) || 0) * (2 ** (attempts - 1))
      return { attempted: true }
    } finally {
      refreshing = false
    }
  }

  return {
    observe,
    reset,
    state: () => ({ pageKey, consecutive, attempts, locked, nextAttemptAt }),
  }
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value)
      return
    }
  }
  throw new Error('required portal field was not found')
}

async function hasVisible(page, selectors) {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true
  }
  return false
}

async function waitForVisible(page, selectors, timeoutMs) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 45000)
  do {
    if (await hasVisible(page, selectors)) return
    await page.waitForTimeout?.(100)
  } while (Date.now() < deadline)
  throw new Error('required portal field was not found')
}

async function clickExactText(page, text, timeoutMs = 5000) {
  const locator = page.getByText(text, { exact: true }).last()
  if (!await locator.isVisible().catch(() => false)) throw new Error('required portal action was not found')
  await locator.click({ timeout: Math.max(1, Math.min(5000, Number(timeoutMs) || 5000)) })
}

async function clickExactTextAfterClosingAnnouncements(page, text) {
  try {
    await clickExactText(page, text)
  } catch {
    await closeAnnouncement(page)
    await clickExactText(page, text)
  }
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible().catch(() => false)) {
      await locator.click()
      return true
    }
  }
  return false
}

async function closeAnnouncement(page, maxClosures = 6) {
  for (let attempt = 0; attempt < maxClosures; attempt += 1) {
    let clicked = false
    for (const selector of PORTAL_SELECTORS.announcementClose) {
      const locator = page.locator(selector).last()
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => {})
        await page.waitForTimeout?.(100)
        clicked = true
        break
      }
    }
    if (!clicked) return
  }
}

async function clickTextAndCapturePopup(context, page, text, timeoutMs) {
  const locator = page.getByText(text, { exact: true }).first()
  if (typeof locator.waitFor === 'function') {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {})
  }
  if (!await locator.isVisible().catch(() => false)) throw new Error('required portal game link was not found')
  const popupPromise = context.waitForEvent('page', { timeout: Math.min(1500, timeoutMs) }).catch(() => null)
  await locator.click()
  return (await popupPromise) ?? page
}

function normalizeAllowedHosts(values) {
  return values
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value.includes('://') ? new URL(value).host : new URL(`https://${value}`).host)
}
