import { dravenApiBaseUrl } from './apiBase'

export type OnlineCoreStatus = {
  state: 'connecting' | 'connected' | 'error'
  message: string
  projectName?: string
  featureFlags?: Record<string, boolean>
  settings?: Record<string, any>
  maintenanceMode?: boolean
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

export type ShadowIterationHead = {
  key: 'main' | 'tie' | 'superSix' | 'bankerDragon' | 'playerDragon' | 'bankerPair' | 'playerPair'
  label: string
  actions: number
  eligibleRounds: number
  actionRate: number | null
  hitRate: number | null
  fixedNetUnits: number
  weightedNetUnits: number
  iterationProgress: number
}

export type ShadowIterationReport = {
  cycleNumber: number
  settledRounds?: number
  startedAt?: string
  completedAt?: string
}

export type ShadowIterationSuggestion = {
  id: string
  headKey: ShadowIterationHead['key']
  actionCycle: number
  status: 'pending' | 'approved' | 'rejected'
  currentWeights: Record<string, number>
  suggestedWeights: Record<string, number>
  baselineMetrics?: Record<string, number>
  candidateMetrics?: Record<string, number>
  modelVersion?: string
  searchMethod?: string
  autoApply?: false
  reviewedBy?: string | null
  reviewedAt?: string | null
  createdAt?: string
}

export type ShadowIterationStatus = {
  state: 'connecting' | 'connected' | 'error'
  enabled: boolean
  shadowVersion?: string
  formalStrategyVersion?: string
  settledRounds: number
  currentCycleProgress: number
  heads: ShadowIterationHead[]
  reports: ShadowIterationReport[]
  suggestions: ShadowIterationSuggestion[]
  message?: string
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
      settings: body.settings ?? {},
      maintenanceMode: Boolean(body.settings?.frontend?.ui_defaults?.maintenanceMode ?? body.settings?.frontend?.maintenance?.enabled ?? body.featureFlags?.maintenance_mode),
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

export async function getShadowIterationStatus(adminSessionToken: string, fetchImpl = fetch): Promise<ShadowIterationStatus> {
  const empty: ShadowIterationStatus = {
    state: 'error', enabled: false, settledRounds: 0, currentCycleProgress: 0,
    heads: [], reports: [], suggestions: [], message: '影子預測資料未連線',
  }
  if (!adminSessionToken) return { ...empty, message: '需要超級管理員Session' }
  try {
    const response = await fetchImpl(`${proxyUrl}/api/v104-iteration-shadow/admin/status`, {
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    })
    if (!response.ok) return { ...empty, message: response.status === 403 ? '僅超級管理員可查看' : '影子預測資料未連線' }
    const body = await response.json()
    if (!body?.ok) return empty
    return {
      state: 'connected',
      enabled: body.enabled === true,
      shadowVersion: body.shadowVersion,
      formalStrategyVersion: body.formalStrategyVersion,
      settledRounds: Number(body.settledRounds ?? 0),
      currentCycleProgress: Number(body.currentCycleProgress ?? 0),
      heads: Array.isArray(body.heads) ? body.heads : [],
      reports: Array.isArray(body.reports) ? body.reports : [],
      suggestions: Array.isArray(body.suggestions) ? body.suggestions : [],
      message: body.message,
    }
  } catch {
    return empty
  }
}

export async function getShadowIterationReportSvg(cycleNumber: number, adminSessionToken: string, fetchImpl = fetch): Promise<string> {
  const cycle = Math.floor(Number(cycleNumber))
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error('影子報告輪次錯誤')
  if (!adminSessionToken) throw new Error('需要超級管理員Session')
  const response = await fetchImpl(`${proxyUrl}/api/v104-iteration-shadow/admin/reports/${cycle}/image.svg`, {
    headers: { Authorization: `Bearer ${adminSessionToken}` },
  })
  if (!response.ok) throw new Error('影子報告讀取失敗')
  const contentType = response.headers?.get?.('content-type') ?? ''
  const svg = await response.text()
  if (!contentType.toLowerCase().includes('image/svg+xml') || svg.length > 1_000_000 || !/^\s*<svg[\s>]/i.test(svg)) {
    throw new Error('影子報告格式錯誤')
  }
  return svg
}

export async function reviewShadowIterationSuggestion(suggestionId: string, decision: 'approved' | 'rejected', adminSessionToken: string, fetchImpl = fetch) {
  if (!suggestionId || !['approved', 'rejected'].includes(decision)) throw new Error('影子建議審核資料錯誤')
  if (!adminSessionToken) throw new Error('需要超級管理員Session')
  const response = await fetchImpl(`${proxyUrl}/api/v104-iteration-shadow/admin/suggestions/${encodeURIComponent(suggestionId)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSessionToken}` },
    body: JSON.stringify({ decision }),
  })
  if (!response.ok) throw new Error('影子建議審核失敗')
  return response.json()
}

export async function updateOnlineAppSetting(payload: { scope: string; key: string; value: unknown; isPublic?: boolean; adminSessionToken?: string }, fetchImpl = fetch) {
  const response = await fetchImpl(`${proxyUrl}/api/online-core/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('線上設定更新失敗')
  return response.json()
}

export async function updateOnlineFeatureFlag(payload: { flagKey: string; enabled: boolean; adminSessionToken?: string }, fetchImpl = fetch) {
  const response = await fetchImpl(`${proxyUrl}/api/online-core/feature-flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('功能開關更新失敗')
  return response.json()
}
