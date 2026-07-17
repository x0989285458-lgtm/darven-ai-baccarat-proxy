import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from './App'

const strategyVersion = 'v98'

function table(overrides: Record<string, unknown> = {}) {
  return {
    tableId: 'BAG01',
    displayName: 'MT百家樂第1桌',
    tableType: 'BAC',
    shoe: 123,
    round: 18,
    beadPlateRaw: '0102',
    bigRoadRaw: '0102',
    sourceUpdatedAt: new Date().toISOString(),
    buildVersion: 'v98',
    prediction: {
      source: 'backend',
      strategyVersion,
      buildVersion: 'v98',
      targetTableId: 'BAG01',
      targetShoe: '123',
      targetRound: 18,
      predictionId: 'pid-round-18',
      issuedAt: '2026-07-17T01:00:00.000Z',
      predictedResult: 'banker',
      confidence: 61,
      probabilities: { banker: 61, player: 30, tie: 9 },
      sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false },
    },
    ...overrides,
  }
}

function stubBackend(row: Record<string, unknown>, tablesStatus = 200) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, sessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) })
    if (url.includes('/api/tables')) return Promise.resolve({ ok: tablesStatus === 200, status: tablesStatus, json: () => Promise.resolve(tablesStatus === 200 ? [row] : {}) })
    if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v98' }) })
    if (url.includes('/api/online-license/status')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ connected: true, maintenanceMode: false, items: [], reports: [], strategies: [] }) })
  }))
}

async function renderMemberApp() {
  window.history.pushState({}, '', '/')
  window.sessionStorage.setItem('darven-member-session-token', 'opaque-member-token')
  window.sessionStorage.setItem('darven-member-session-expires-at', new Date(Date.now() + 600000).toISOString())
  render(<App />)
  await waitFor(() => expect(screen.queryByLabelText('會員Session驗證中')).not.toBeInTheDocument())
}

describe('App v098 prediction and session contract', () => {
  beforeEach(() => window.sessionStorage.clear())
  afterEach(() => {
    window.sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('keeps the complete six-value backend contract while displaying the approved five side metrics', async () => {
    stubBackend(table())
    await renderMemberApp()

    const row = await screen.findByLabelText('副項目預測機率')
    expect(Array.from(row.querySelectorAll('.probability-value')).map((node) => node.textContent)).toEqual(['66%', '44%', '22%', '33%', '55%'])
    expect(row.querySelector('[aria-label="和局預測"]')).toBeNull()
    expect(row.querySelectorAll('.prediction-metric.active')).toHaveLength(1)
  })

  it('clears every action and reports unavailable when buildVersion is not 098.23', async () => {
    stubBackend(table({ buildVersion: '097' }))
    await renderMemberApp()

    const prediction = await screen.findByLabelText('AI預測結果')
    expect(prediction.querySelectorAll('.prediction-metric.active')).toHaveLength(0)
    expect(screen.getByText(/建置版本不符.*預測暫不可用/)).toBeInTheDocument()
  })

  it('clears the opaque session immediately when a protected tables request returns 401', async () => {
    stubBackend(table(), 401)
    await renderMemberApp()

    await waitFor(() => expect(window.sessionStorage.getItem('darven-member-session-token')).toBeNull())
    expect(await screen.findByRole('heading', { name: '瑞文AI百家預測' })).toBeInTheDocument()
  })
})
