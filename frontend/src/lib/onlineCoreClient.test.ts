import { describe, expect, it, vi } from 'vitest'
import { getOnlineStrategyAnalysis } from './onlineCoreClient'

describe('onlineCoreClient strategy analysis', () => {
  it('v035 reads strategy comparison and weak-table suggestions from proxy', async () => {
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
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8787/api/online-core/strategy-analysis')
  })
})
