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
}

export async function memberLogin(payload: { memberAccount: string; verificationPassword: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/member-login', payload, fetchImpl)
}

export async function agentLogin(payload: { agentAccount: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/agent-login', payload, fetchImpl)
}

export async function createOnlineAgent(payload: { code: string; name?: string; role?: string; parentCode?: string; permission?: string; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/agents', payload, fetchImpl)
}

export async function deleteOnlineAgents(payload: { codes: string[]; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/agents/delete', payload, fetchImpl)
}

export async function createOnlineLicense(payload: { memberAccount: string; code: string; agentCode: string; durationDays: number; planName?: string; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses', { planName: '正式月卡', ...payload }, fetchImpl)
}

export async function setOnlineLicenseStatus(payload: { code: string; status: 'active' | 'suspended' | 'expired'; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/status', payload, fetchImpl)
}

export async function extendOnlineLicense(payload: { code: string; days: number; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/extend', payload, fetchImpl)
}

export async function deleteOnlineLicense(payload: { code: string; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/delete', payload, fetchImpl)
}

export async function getOnlineLicenseStatus(fetchImpl = fetch): Promise<OnlineLicenseStatus> {
  try {
    const response = await fetchImpl(`${proxyUrl}/api/online-license/status`)
    if (!response.ok) return emptyStatus()
    const body = await response.json()
    return mapStatus(body)
  } catch {
    return emptyStatus()
  }
}

export async function getCloudDataStatus(fetchImpl = fetch): Promise<{ ok?: boolean; mtAutoLoginEnabled?: boolean; message?: string; tableCount?: number }> {
  try {
    const response = await fetchImpl(`${proxyUrl}/api/cloud-data/status`, { cache: 'no-store' } as RequestInit)
    if (!response.ok) return { ok: false, mtAutoLoginEnabled: false, message: '雲端資料狀態讀取失敗' }
    return response.json()
  } catch {
    return { ok: false, mtAutoLoginEnabled: false, message: '雲端資料狀態讀取失敗' }
  }
}

async function postJson(path: string, payload: unknown, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {}
  if (!response.ok) throw new Error(body.error ?? '線上授權 API 失敗')
  return body
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
  return { configured: body.configured, managers, agents, plans: body.plans ?? [], licenses, agentRows, licenseRows }
}

function roleLabel(role?: string, fallback?: string) {
  if (String(role).includes('manager')) return '管理員'
  if (String(role).includes('viewer')) return '觀察者'
  if (String(role).includes('super')) return '超級管理員'
  return fallback ?? '代理'
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
