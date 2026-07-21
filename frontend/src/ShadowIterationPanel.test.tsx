import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ShadowIterationPanel } from './ShadowIterationPanel'
import { getShadowIterationReportSvg, getShadowIterationStatus, reviewShadowIterationSuggestion } from './lib/onlineCoreClient'

vi.mock('./lib/onlineCoreClient', () => ({
  getShadowIterationStatus: vi.fn(),
  getShadowIterationReportSvg: vi.fn(),
  reviewShadowIterationSuggestion: vi.fn(),
}))

const heads = [
  ['main', '莊／閒'], ['tie', '和'], ['superSix', '超六'],
  ['bankerDragon', '莊龍寶'], ['playerDragon', '閒龍寶'],
  ['bankerPair', '莊對'], ['playerPair', '閒對'],
].map(([key, label], index) => ({
  key, label, actions: 100 + index, eligibleRounds: 432,
  actionRate: key === 'main' ? 100 : 20 + index,
  hitRate: 50 + index, fixedNetUnits: index - 2.5,
  weightedNetUnits: 12.5 - index, iterationProgress: 100 + index,
}))

describe('ShadowIterationPanel', () => {
  beforeEach(() => {
    vi.mocked(getShadowIterationStatus).mockResolvedValue({
      state: 'connected', enabled: true,
      shadowVersion: 'v104-seven-head-shadow-v1', formalStrategyVersion: 'v104',
      settledRounds: 1432, currentCycleProgress: 432,
      heads: heads as any,
      reports: [{ cycleNumber: 1, settledRounds: 1000 }],
      suggestions: [{ id: 's1', headKey: 'main', actionCycle: 1, status: 'pending', currentWeights: {}, suggestedWeights: {} }],
    })
    vi.mocked(getShadowIterationReportSvg).mockResolvedValue('<svg aria-label="影子預測第1輪"></svg>')
    vi.mocked(reviewShadowIterationSuggestion).mockResolvedValue({ ok: true, status: 'approved', auto_apply: false })
  })

  it('顯示七項出手率、命中率與普通正負單位數字', async () => {
    render(<ShadowIterationPanel adminSessionToken="opaque-admin-session" />)

    const table = await screen.findByRole('table', { name: '七項影子預測結果' })
    expect(within(table).getAllByRole('row')).toHaveLength(8)
    for (const label of ['莊／閒', '和', '超六', '莊龍寶', '閒龍寶', '莊對', '閒對']) expect(within(table).getByText(label)).toBeInTheDocument()
    expect(within(table).getByText('-2.50 單位')).toBeInTheDocument()
    expect(within(table).getByText('+12.50 單位')).toBeInTheDocument()
    expect(table.textContent).not.toMatch(/[🟢🔴⚪]/u)
    expect(screen.getByText('待審核權重建議：1')).toBeInTheDocument()
  })

  it('人工批准只送Suggestion ID、決策與超管Session', async () => {
    render(<ShadowIterationPanel adminSessionToken="opaque-admin-session" />)
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    await waitFor(() => expect(reviewShadowIterationSuggestion).toHaveBeenCalledWith('s1', 'approved', 'opaque-admin-session'))
  })

  it('以整張安全圖片顯示千局報告', async () => {
    render(<ShadowIterationPanel adminSessionToken="opaque-admin-session" />)

    const image = await screen.findByRole('img', { name: '影子預測完整千局圖表' })
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(getShadowIterationReportSvg).toHaveBeenCalledWith(1, 'opaque-admin-session')
    await waitFor(() => expect(screen.getByText('本輪千局進度')).toHaveTextContent('432／1,000'))
  })
})
