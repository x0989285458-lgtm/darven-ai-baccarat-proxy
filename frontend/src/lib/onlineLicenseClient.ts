import { dravenApiBaseUrl } from './apiBase'

const proxyUrl = dravenApiBaseUrl

export type OnlineLicenseStatus = {
  managers: Array<{ username: string; role?: string; is_active?: boolean }>
  agents: Array<{ code: string; name?: string }>
  plans: Array<{ name: string; duration_days?: number }>
  licenses: Array<{ code: string; status?: string; agent_code?: string; plan_name?: string; expires_on?: string }>
  agentRows: Array<{ account: string; level: string; permission: string }>
  licenseRows: Array<{ member: string; code: string; status: string; remain: string; agentCode?: string }>
}

export async function memberLogin(payload: { memberAccount: string; verificationPassword: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/member-login', payload, fetchImpl)
}

export async function agentLogin(payload: { agentAccount: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/agent-login', payload, fetchImpl)
}

export async function createOnlineLicense(payload: { code: string; agentCode: string; durationDays: number; planName?: string; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses', { planName: '正式月卡', adminAccount: 'DV1788', ...payload }, fetchImpl)
}

export async function setOnlineLicenseStatus(payload: { code: string; status: 'active' | 'suspended' | 'expired'; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/status', { adminAccount: 'DV1788', ...payload }, fetchImpl)
}

export async function extendOnlineLicense(payload: { code: string; days: number; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/extend', { adminAccount: 'DV1788', ...payload }, fetchImpl)
}

export async function deleteOnlineLicense(payload: { code: string; adminAccount?: string }, fetchImpl = fetch) {
  return postJson('/api/online-license/licenses/delete', { adminAccount: 'DV1788', ...payload }, fetchImpl)
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
  return { managers: [], agents: [], plans: [], licenses: [], agentRows: [], licenseRows: [] }
}

function mapStatus(body: any): OnlineLicenseStatus {
  const managers = body.managers ?? []
  const agents = body.agents ?? []
  const licenses = body.licenses ?? []
  return {
    managers,
    agents,
    plans: body.plans ?? [],
    licenses,
    agentRows: agents.map((agent: any) => ({
      account: agent.code,
      level: agent.name ?? '正式代理',
      permission: '可建碼 / 線上授權',
    })),
    licenseRows: licenses.map((license: any, index: number) => ({
      member: `User${String(index + 1).padStart(3, '0')}`,
      code: license.code,
      status: license.status === 'active' ? '啟用中' : license.status === 'suspended' ? '暫停中' : '已過期',
      remain: formatRemain(license.expires_on),
      agentCode: license.agent_code,
    })),
  }
}

function formatRemain(expiresOn?: string) {
  if (!expiresOn) return '未設定'
  const today = new Date()
  const expiry = expiresOn.includes('T') ? new Date(expiresOn) : new Date(`${expiresOn}T00:00:00`)
  const diff = Math.ceil((expiry.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000)
  return diff > 0 ? `${diff}天` : '已到期'
}
