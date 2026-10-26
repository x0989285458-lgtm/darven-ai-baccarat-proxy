import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { LiveTable } from './lib/liveClient'

let publish: (tables: LiveTable[]) => void
vi.mock('./lib/liveClient', async (original) => ({
  ...await original<typeof import('./lib/liveClient')>(),
  LiveRoadClient: class {
    constructor(options: { onTables: typeof publish }) { publish = options.onTables }
    connect() {}
    disconnect() {}
  },
}))
function table(visible = 22, count = 21): LiveTable {
  return { trendBundle: { schemaVersion: 1, tableId: 'BAV01', shoe: '123', completedRound: count, status: 'available', reason: 'complete' }, id: 'BAV01', table_type: 'BAC', sourceUpdatedAt: new Date().toISOString(), trend: {
    current_shoe: 123, current_round: visible,
    total_round_banker: count, total_round_player: 0, total_round_tie: 0,
    bead_plate2: '02'.repeat(count), big2: Array(count).fill('0802').join('#'),
  } }
}
async function mount(row: LiveTable) {
  const previous = publish
  render(<App />)
  await waitFor(() => { expect(publish).toBeTypeOf('function'); expect(publish).not.toBe(previous) })
  act(() => publish([row]))
}
const road = () => document.querySelector('.road-card h2')!
const stats = () => document.querySelector('.dashboard-stats-row')!
beforeEach(() => {
  window.history.pushState({}, '', '/')
  window.sessionStorage.setItem('darven-member-session-token', 'test-token')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () =>
    url.includes('member-session') ? { ok: true, sessionExpiresAt: new Date(Date.now() + 600000).toISOString() } : {} })))
})
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals() })
it('marks visible53/count51 pending in existing titles and restores same-round enrichment without layout changes', async () => {
  await mount(table(53, 51))
  expect(road()).toHaveTextContent('更新中')
  expect(stats()).toHaveTextContent('更新中')
  expect(road()).toHaveTextContent('截至第51局')
  const shape = Array.from(document.querySelectorAll('.member-dashboard *:not(.big-cell):not(.big-cell span)')).map(n => [n.tagName, n.className])
  act(() => publish([table(53, 52)]))
  expect(road()).toHaveTextContent(/^路單$/)
  expect(stats()).not.toHaveTextContent('更新中')
  expect(Array.from(document.querySelectorAll('.member-dashboard *:not(.big-cell):not(.big-cell span)')).map(n => [n.tagName, n.className])).toEqual(shape)
  expect(document.querySelectorAll('.road-card')).toHaveLength(1)
})
it.each(['beads-short', 'big-short', 'unknown-bead', 'unknown-big', 'missing-bead', 'missing-big', 'wrong-outcomes', 'cross-shoe'])('fails closed for %s despite aligned counts', async (kind) => {
  const row = table()
  if (kind === 'beads-short') row.trend.bead_plate2 = '02'.repeat(20)
  if (kind === 'big-short') row.trend.big2 = Array(20).fill('0802').join('#')
  if (kind === 'unknown-bead') row.trend.bead_plate2 += 'unknown'
  if (kind === 'unknown-big') row.trend.big2 += '#unknown'
  if (kind === 'missing-bead') row.trend.bead_plate2 = ''
  if (kind === 'missing-big') row.trend.big2 = ''
  if (kind === 'wrong-outcomes') row.trend.big2 = Array(21).fill('0801').join('#')
  if (kind === 'cross-shoe') { row.trend.current_shoe = 124; row.trend.current_round = 2; row.trend.total_round_banker = 1 }
  await mount(row)
  expect(road()).toHaveTextContent('更新中／資料待補齊')
  expect(stats()).toHaveTextContent('更新中')
  expect(road()).not.toHaveTextContent('截至')
})
it('missing source metadata stays pending even with aligned counts', async () => {
  const row = table()
  delete row.trendBundle
  await mount(row)
  expect(road()).toHaveTextContent('更新中／資料待補齊')
  expect(stats()).toHaveTextContent('更新中')
})
it.each(['fake-available', 'different-shoe', 'coverage-mismatch', 'source-pending', 'foreign-table', 'unknown-schema'])('source contract fails closed: %s', async (kind) => {
  const row = table()
  if (kind === 'fake-available') row.trendBundle!.reason = 'missing-or-invalid-bundle'
  if (kind === 'different-shoe') row.trendBundle!.shoe = '122'
  if (kind === 'coverage-mismatch') row.trendBundle!.completedRound = 20
  if (kind === 'source-pending') { row.trendBundle!.status = 'pending'; row.trendBundle!.reason = 'coverage-mismatch' }
  if (kind === 'foreign-table') row.trendBundle!.tableId = 'BAV02'
  if (kind === 'unknown-schema') Object.assign(row.trendBundle!, { schemaVersion: 99 })
  await mount(row)
  expect(road()).toHaveTextContent('更新中')
  expect(stats().textContent?.match(/更新中/g)).toHaveLength(3)
  if (kind === 'source-pending') expect(road()).toHaveTextContent('截至第21局')
  if (kind === 'coverage-mismatch') expect(road()).not.toHaveTextContent('截至')
  if (['different-shoe', 'foreign-table', 'unknown-schema', 'fake-available'].includes(kind)) expect(road()).not.toHaveTextContent('截至')
  act(() => publish([table()]))
  expect(road()).toHaveTextContent(/^路單$/)
  expect(stats()).not.toHaveTextContent('更新中')
})
it('accepts source-validated empty new shoe at completed round zero', async () => {
  await mount(table(1, 0))
  expect(road()).toHaveTextContent(/^路單$/)
  expect(stats()).not.toHaveTextContent('更新中')
})
it('keeps visible22/completed21 and tie-aware non-tie road totals unmarked', async () => {
  const row = table()
  row.trend.total_round_banker = 20
  row.trend.total_round_tie = 1
  row.trend.bead_plate2 = '02'.repeat(20) + '03'
  row.trend.big2 = Array(20).fill('0802').join('#')
  await mount(row)
  expect(road()).toHaveTextContent(/^路單$/)
  expect(stats()).not.toHaveTextContent('更新中')
})
