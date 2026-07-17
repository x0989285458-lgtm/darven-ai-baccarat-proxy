import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { frontendBuildMetadata } from './lib/buildVersion'

const sidePredictions = { tie: 25, superSix: 45, bankerPair: 43, playerPair: 42, bankerDragon: 30, playerDragon: 29 }
const sideActions = { tie: true, superSix: true, bankerPair: true, playerPair: false, bankerDragon: true, playerDragon: false }

function liveTable(overrides: Record<string, unknown> = {}) {
  return {
    tableId: 'BAG01', displayName: 'MT真人百家1桌', tableType: 'BAC', shoe: 88, round: 13,
    bankerCount: 7, playerCount: 5, tieCount: 1, beadPlateRaw: '0102', bigRoadRaw: '0102',
    sourceUpdatedAt: new Date().toISOString(), buildVersion: 'v98',
    prediction: {
      source: 'backend', strategyVersion: 'v98', buildVersion: 'v98', targetTableId: 'BAG01', targetShoe: '88', targetRound: 13,
      predictionId: 'pid-13', issuedAt: '2026-07-17T01:00:00.000Z', predictedResult: 'banker', confidence: 60,
      probabilities: { banker: 60, player: 35, tie: 5 }, scoreTotals: { banker: 0.53, player: 0.47 }, sidePredictions, sideActions,
    },
    ...overrides,
  }
}

function history() {
  return {
    ok: true, buildVersion: 'v98', tableId: 'BAG01', shoe: 88,
    settledPredictions: [
      { round: 11, mainPredictedResult: 'banker', predictedResult: 'banker', actualResult: 'tie', isHit: false, result: 'uncalculated' },
      { round: 12, mainPredictedResult: 'player', predictedResult: 'tie', actualResult: 'tie', isHit: true, result: 'hit' },
    ],
    realCardRounds: [], realCardHistoryCompleteThroughRound: 0,
  }
}

async function renderMember(row = liveTable()) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/online-license/member-session')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, sessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) })
    if (url.includes('/ui-history')) return Promise.resolve({ ok: true, status: 200, json: async () => history() })
    if (url.includes('/api/tables')) return Promise.resolve({ ok: true, status: 200, json: async () => [row] })
    if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v98' }) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ connected: true, configured: true, items: [], reports: [], strategies: [] }) })
  }))
  window.history.pushState({}, '', '/')
  window.sessionStorage.setItem('darven-member-session-token', 'opaque-test-token')
  window.sessionStorage.setItem('darven-member-session-expires-at', new Date(Date.now() + 600000).toISOString())
  render(<App />)
  await waitFor(() => expect(document.querySelector('.main-probability-row')).toBeInTheDocument())
}

describe('v98 frozen frontend release', () => {
  beforeEach(() => window.sessionStorage.clear())
  afterEach(() => { window.sessionStorage.clear(); vi.unstubAllGlobals() })

  it('uses exact v98 build and strategy contracts', () => {
    expect(frontendBuildMetadata).toEqual({ buildVersion: 'v98', strategyVersion: 'v98' })
  })

  it('shows the backend tie side score in the main row and lights tie simultaneously with main and other side actions', async () => {
    await renderMember()
    const mainMetrics = Array.from(document.querySelectorAll('.main-probability-row .prediction-metric'))
    expect(mainMetrics.map((node) => node.querySelector('.probability-value')?.textContent)).toEqual(['47%', '25%', '53%'])
    expect(mainMetrics.filter((node) => node.classList.contains('active'))).toHaveLength(2)
    expect(document.querySelectorAll('.prediction-card .prediction-metric.active')).toHaveLength(5)
  })

  it('fails closed for stale, wrong-version, or incomplete v98 payloads', async () => {
    await renderMember(liveTable({ buildVersion: 'v97' }))
    expect(document.querySelectorAll('.prediction-card .prediction-metric.active')).toHaveLength(0)
  })

  it('renders tie without an action as 不計算, but renders an evidenced tie action as AI預測和命中', async () => {
    await renderMember()
    const rows = Array.from((await screen.findByRole('table', { name: '近十局預測紀錄' })).querySelectorAll('tr'))
    expect(Array.from(rows[1].querySelectorAll('td')).map((node) => node.textContent)).toEqual(['莊', '和'])
    expect(Array.from(rows[2].querySelectorAll('td')).map((node) => node.textContent)).toEqual(['和', '和'])
    expect(Array.from(rows[3].querySelectorAll('td')).map((node) => node.textContent)).toEqual(['不計算', '命中'])
  })
})
