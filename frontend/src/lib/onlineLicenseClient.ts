import { dravenApiBaseUrl } from './apiBase'

const proxyUrl = dravenApiBaseUrl

export type OnlineLicenseStatus = {
  configured?: boolean
  managers: Array<{ username: string; role?: string; is_active?: boolean }>
  agents: Array<{ code: string; name?: string; role?: string; parent_code?: string; permission?: string; is_active?: boolean }>
  plans: Array<{ name: string; duration_days?: number }>
  licenses: Array<{ code: string; member_account?: string; status?: string; agent_code?: string; plan_name?: string; expires_on?: string }>
  agentRows: Array<{ account: string; level: string; permission: string; parent?: string; depth?: number }>
  licenseRows: Array<{ member: string; code: string; status: string; remain: string; agentCode?: string; expiresOn?: string }>
  usedLicenseCodes?: string[]
}

type AdminSessionPayload = { adminSessionToken?: string }

export async function memberLogin(payload: { memberAccount: string; verificationPassword: string; turnstileToken?: string }, fetchImpl = fetch, timeoutMs = 10000) {
  return postJson('/api/online-license/member-login', payload, fetchImpl, timeoutMs)
}

export async function validateMemberSession(memberSessionToken: string, fetchImpl = fetch): Promise<{ ok: boolean; sessionExpiresAt?: string; error?: string }> {
  if (!memberSessionToken) return { ok: false, error: '缺少會員 Session' }
  try {
    const response = await fetchImpl(`${proxyUrl}/api/online-license/member-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${memberSessionToken}` },
    })
    const body = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {}
    if (!response.ok || !body.ok) return { ok: false, error: body.error ?? '會員 Session 無效' }
    return { ok: true, sessionExpiresAt: body.sessionExpiresAt }
  } catch {
    return { ok: false, error: '會員 Session 驗證失敗' }
  }
}

export async function agentLogin(payload: { agentAccount: string; turnstileToken?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/agent-login', payload, fetchImpl)
}

export async function createOnlineAgent(payload: { code: string; name?: string; role?: string; parentCode?: string; permission?: string; adminAccount?: string } & AdminSessionPayload, fetchImpl = fetch) {
  return postJson('/api/online-license/agents', payload, fetchImpl)
}

export async function deleteOnlineAgents(payload: { codes: string[]; adminAccount?: string } & AdminSessionPayload, fetchImpl = fetch) {
  return postJson('/api/online-license/agents/delete', payload, fetchImpl)
}

export async function createOnlineLicense(payload: { memberAccount: string; code: string; agentCode: string; durationDays: number; planName?: string; adminAccount?: string } & AdminSessionPayload, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses', { planName: '正式月卡', ...payload }, fetchImpl)
}

export async function setOnlineLicenseStatus(payload: { code: string; status: 'active' | 'suspended' | 'expired'; adminAccount?: string } & AdminSessionPayload, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/status', payload, fetchImpl)
}

export async function extendOnlineLicense(payload: { code: string; days: number; adminAccount?: string } & AdminSessionPayload, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/extend', payload, fetchImpl)
}

export async function deleteOnlineLicense(payload: { code: string; adminAccount?: string } & AdminSessionPayload, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/delete', payload, fetchImpl)
}

export async function getOnlineLicenseStatus(adminAccountOrFetch?: string | { adminAccount?: string; adminSessionToken?: string } | typeof fetch, fetchImpl = fetch): Promise<OnlineLicenseStatus> {
  try {
    const adminAccount = typeof adminAccountOrFetch === 'string' ? adminAccountOrFetch : typeof adminAccountOrFetch === 'object' ? adminAccountOrFetch.adminAccount : undefined
    const adminSessionToken = typeof adminAccountOrFetch === 'object' ? adminAccountOrFetch.adminSessionToken : undefined
    const resolvedFetch = typeof adminAccountOrFetch === 'function' ? adminAccountOrFetch : fetchImpl
    const params = new URLSearchParams()
    if (adminAccount) params.set('adminAccount', adminAccount)
    const suffix = params.toString() ? `?${params.toString()}` : ''
    const headers = adminSessionToken ? { Authorization: `Bearer ${adminSessionToken}` } : undefined
    const response = await resolvedFetch(`${proxyUrl}/api/online-license/status${suffix}`, { headers })
    if (!response.ok) return emptyStatus()
    const body = await response.json()
    return mapStatus(body)
  } catch {
    return emptyStatus()
  }
}

export async function getCloudDataStatus(fetchImpl = fetch): Promise<{ ok?: boolean; mtAutoLoginEnabled?: boolean; message?: string; tableCount?: number; todayRoundCount?: number; tableStats?: Array<{ tableId: string; mainHitRate: string; sideHitRate: string }>; dailyReports?: Array<Record<string, any>> }> {
  try {
    const response = await fetchImpl(`${proxyUrl}/api/cloud-data/status`, { cache: 'no-store' } as RequestInit)
    if (!response.ok) return { ok: false, mtAutoLoginEnabled: false, message: '雲端資料狀態讀取失敗' }
    return response.json()
  } catch {
    return { ok: false, mtAutoLoginEnabled: false, message: '雲端資料狀態讀取失敗' }
  }
}

async function postJson(path: string, payload: unknown, fetchImpl: typeof fetch, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    const response = await fetchImpl(`${proxyUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const body = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {}
    if (!response.ok) throw new Error(body.error ?? '線上授權 API 失敗')
    return body
  } catch (error) {
    if (controller.signal.aborted) throw new Error('連線逾時，請稍後再試')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function emptyStatus(): OnlineLicenseStatus {
  return { configured: false, managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] }
}

function mapStatus(body: any): OnlineLicenseStatus {
  const managers = body.managers ?? []
  const agents = body.agents ?? []
  const licenses = body.licenses ?? []
  const agentRows = body.agentRows ?? agents.map((agent: any) => ({
    account: agent.code,
    level: roleLabel(agent.role, agent.name),
    permission: agent.permission ?? '可建碼 / 線上授權',
    parent: agent.parent_code,
    depth: inferDepth(agent.role),
  }))
  const licenseRows = body.licenseRows ?? licenses.map((license: any, index: number) => ({
    member: license.member_account ?? `User${String(index + 1).padStart(3, '0')}`,
    code: license.code,
    status: license.status === 'active' ? '啟用中' : license.status === 'suspended' ? '暫停中' : '已過期',
    remain: formatRemain(license.expires_on),
    expiresOn: license.expires_on ? String(license.expires_on).slice(0, 10) : undefined,
    agentCode: license.agent_code,
  }))
  const usedLicenseCodes = Array.isArray(body.usedLicenseCodes) ? body.usedLicenseCodes.filter((code: unknown): code is string => typeof code === 'string') : []
  return { configured: body.configured, managers, agents, plans: body.plans ?? [], licenses, agentRows, licenseRows, usedLicenseCodes }
}

function roleLabel(role?: string, fallback?: string) {
  const value = String(role ?? '').toLowerCase()
  if (value.includes('manager')) return '管理員'
  if (value.includes('viewer')) return '觀察者'
  if (value.includes('super') || value.includes('total')) return '超級管理員'
  return '代理'
}

function inferDepth(role?: string) {
  if (String(role).includes('super')) return 0
  if (String(role).includes('manager')) return 1
  if (String(role).includes('viewer')) return 3
  return 2
}

function formatRemain(expiresOn?: string) {
  if (!expiresOn) return '未設定'
  const today = new Date()
  const expiry = expiresOn.includes('T') ? new Date(expiresOn) : new Date(`${expiresOn}T00:00:00`)
  const diff = Math.ceil((expiry.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000)
  return diff > 0 ? `${diff}天` : '已到期'
}
