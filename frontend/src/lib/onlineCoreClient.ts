import { dravenApiBaseUrl } from './apiBase'

export type OnlineCoreStatus = {
  state: 'connecting' | 'connected' | 'error'
  message: string
  projectName?: string
  featureFlags?: Record<string, boolean>
}

export type OnlineMemoryCenter = {
  state: 'connecting' | 'connected' | 'error'
  items: Array<{ title?: string; item_type?: string }>
  reports: Array<{ strategy_version?: string; report_type?: string; rounds?: number; hits?: number; misses?: number; pushes?: number; main_hit_rate?: number | string; side_hit_rate?: number | string; report_path?: string }>
  strategies: Array<{ version?: string; status?: string }>
}

export type OnlineStrategyAnalysis = {
  state: 'connecting' | 'connected' | 'error'
  strategyRows: Array<{ strategy_version?: string; rounds?: number; hits?: number; misses?: number; pushes?: number; main_hit_rate?: number | string; conclusion?: string }>
  weakTables: Array<{ name: string; hitRate: number; strategy_version?: string }>
  strongTables: Array<{ name: string; hitRate: number; strategy_version?: string }>
  watchTables: Array<{ name: string; hitRate: number; strategy_version?: string }>
  suggestions: string[]
}

const proxyUrl = dravenApiBaseUrl

export async function checkOnlineCoreStatus(fetchImpl = fetch): Promise<OnlineCoreStatus> {
  try {
    const response = await fetchImpl(`${proxyUrl}/api/online-core/status`)
    if (!response.ok) return { state: 'error', message: '記憶中心未連線' }
    const body = await response.json()
    if (!body.connected) return { state: 'error', message: body.configured ? '記憶中心異常' : '記憶中心未設定' }
    return {
      state: 'connected',
      message: '記憶中心已連線',
      projectName: body.project?.name ?? body.project?.slug,
      featureFlags: body.featureFlags ?? {},
    }
  } catch {
    return { state: 'error', message: '記憶中心未連線' }
  }
}

export async function getOnlineMemoryCenter(fetchImpl = fetch): Promise<OnlineMemoryCenter> {
  try {
    const response = await fetchImpl(`${proxyUrl}/api/online-core/memory-center`)
    if (!response.ok) return { state: 'error', items: [], reports: [], strategies: [] }
    const body = await response.json()
    if (!body.connected) return { state: 'error', items: [], reports: [], strategies: [] }
    return { state: 'connected', items: body.items ?? [], reports: body.reports ?? [], strategies: body.strategies ?? [] }
  } catch {
    return { state: 'error', items: [], reports: [], strategies: [] }
  }
}

export async function getOnlineStrategyAnalysis(fetchImpl = fetch): Promise<OnlineStrategyAnalysis> {
  try {
    const response = await fetchImpl(`${proxyUrl}/api/online-core/strategy-analysis`)
    if (!response.ok) return { state: 'error', strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] }
    const body = await response.json()
    if (!body.connected) return { state: 'error', strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] }
    return {
      state: 'connected',
      strategyRows: body.strategyRows ?? [],
      weakTables: body.weakTables ?? [],
      strongTables: body.strongTables ?? [],
      watchTables: body.watchTables ?? [],
      suggestions: body.suggestions ?? [],
    }
  } catch {
    return { state: 'error', strategyRows: [], weakTables: [], strongTables: [], watchTables: [], suggestions: [] }
  }
}

export async function updateOnlineAppSetting(payload: { scope: string; key: string; value: unknown; isPublic?: boolean }, fetchImpl = fetch) {
  const response = await fetchImpl(`${proxyUrl}/api/online-core/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('線上設定更新失敗')
  return response.json()
}

export async function updateOnlineFeatureFlag(payload: { flagKey: string; enabled: boolean }, fetchImpl = fetch) {
  const response = await fetchImpl(`${proxyUrl}/api/online-core/feature-flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('功能開關更新失敗')
  return response.json()
}
