import { describe, expect, it, vi } from 'vitest'
import { getOnlineStrategyAnalysis, getShadowIterationReportSvg, getShadowIterationStatus, reviewShadowIterationSuggestion } from './onlineCoreClient'

describe('onlineCoreClient strategy analysis', () => {
  it('reads strategy comparison and weak-table suggestions from proxy', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        connected: true,
        strategyRows: [{ strategy_version: 'v034-auto-memory', rounds: 300, main_hit_rate: 54.5, conclusion: '目前最佳' }],
        weakTables: [{ name: 'MT百家樂第5桌', hitRate: 38.5 }],
        strongTables: [{ name: 'MT百家樂第2桌', hitRate: 64 }],
        suggestions: ['第5桌低於45%，建議降低信心權重並啟用反向檢查'],
      }),
    }))

    const analysis = await getOnlineStrategyAnalysis(fetchMock as unknown as typeof fetch)

    expect(analysis.state).toBe('connected')
    expect(analysis.strategyRows[0].strategy_version).toBe('v034-auto-memory')
    expect(analysis.weakTables[0].name).toBe('MT百家樂第5桌')
    expect(String((fetchMock as any).mock.calls[0][0])).toContain('/api/online-core/strategy-analysis')
  })
})

describe('影子預測後台資料', () => {
  it('只用Bearer管理Session讀取七項狀態，不把Token放進網址', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        ok: true,
        enabled: true,
        shadowVersion: 'v104-seven-head-shadow-v1',
        formalStrategyVersion: 'v104',
        settledRounds: 432,
        currentCycleProgress: 432,
        heads: [
          { key: 'main', label: '莊／閒', actions: 432, eligibleRounds: 432, actionRate: 100, hitRate: 53.2, fixedNetUnits: 11.4, weightedNetUnits: 18.8, iterationProgress: 432 },
        ],
        reports: [],
        suggestions: [],
      }),
    }))

    const status = await getShadowIterationStatus('opaque-admin-session', fetchMock as unknown as typeof fetch)

    expect(status.state).toBe('connected')
    expect(status.heads[0].label).toBe('莊／閒')
    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(String(url)).toContain('/api/v104-iteration-shadow/admin/status')
    expect(String(url)).not.toContain('opaque-admin-session')
    expect(init.headers.Authorization).toBe('Bearer opaque-admin-session')
  })

  it('批准建議只用Bearer且不把Session放入網址或Body', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, status: 'approved', auto_apply: false }) }))
    await reviewShadowIterationSuggestion('v104:main:1', 'approved', 'opaque-admin-session', fetchMock as unknown as typeof fetch)
    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(String(url)).toContain('/suggestions/v104%3Amain%3A1/review')
    expect(String(url)).not.toContain('opaque-admin-session')
    expect(init.headers.Authorization).toBe('Bearer opaque-admin-session')
    expect(JSON.parse(init.body)).toEqual({ decision: 'approved' })
  })

  it('用Bearer抓取整張SVG報告且拒絕非SVG內容', async () => {
    const okFetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'image/svg+xml; charset=utf-8' : null },
      text: () => Promise.resolve('<svg aria-label="影子預測第1輪"></svg>'),
    }))
    await expect(getShadowIterationReportSvg(1, 'opaque-admin-session', okFetch as unknown as typeof fetch)).resolves.toContain('影子預測第1輪')
    const [url, init] = (okFetch as any).mock.calls[0]
    expect(String(url)).toContain('/reports/1/image.svg')
    expect(String(url)).not.toContain('opaque-admin-session')
    expect(init.headers.Authorization).toBe('Bearer opaque-admin-session')

    const badFetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve('<script>alert(1)</script>'),
    }))
    await expect(getShadowIterationReportSvg(1, 'opaque-admin-session', badFetch as unknown as typeof fetch)).rejects.toThrow('影子報告格式錯誤')
  })
})
