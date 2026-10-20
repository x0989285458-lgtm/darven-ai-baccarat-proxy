import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App, { selectMemberTable } from './App'
import type { LiveTable } from './lib/liveClient'

const ids = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']
const labels = ['B01-L', 'B02-L', 'B03-L', 'B04-L', 'B05-L', 'B06-L']
const live = vi.hoisted(() => ({ ready: false, publish: (_tables: LiveTable[]) => {} }))
vi.mock('./lib/liveClient', async (original) => ({
  ...await original<typeof import('./lib/liveClient')>(),
  LiveRoadClient: class {
    constructor(options: { onTables: (tables: LiveTable[]) => void }) { live.publish = options.onTables; live.ready = true }
    connect() {}
    disconnect() {}
  },
}))
function row(id: string): LiveTable {
  return { id, name: 'untrusted display label', table_type: 'BAC', sourceUpdatedAt: new Date().toISOString(),
    trend: { bead_plate2: '', big2: '', current_shoe: 123, current_round: 0 } }
}
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals() })
it('renders exactly six raw BAV identities in approved label order and keeps selection/history by identity', async () => {
  window.history.pushState({}, '', '/')
  window.sessionStorage.setItem('darven-member-session-token', 'test-session')
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(String(url))
    const historyId = String(url).match(/tables\/([^/]+)\/ui-history/)?.[1]
    return { ok: true, status: 200, json: async () => historyId
      ? { ok: true, buildVersion: 'v105', tableId: historyId, shoe: 123, settledPredictions: [], realCardRounds: [], realCardHistoryCompleteThroughRound: 0 }
      : { ok: true, configured: true, connected: true, maintenanceMode: false, sessionExpiresAt: new Date(Date.now()+600000).toISOString() } }
  }))
  render(<App />)
  await waitFor(() => expect(live.ready).toBe(true))
  const unknown = [...ids.map(id => `${id}_LIVE`), 'BAG01', 'BAG03A', 'BAV04', 'BAV07', 'bav01', ' BAV01 ', 'BAV1', 'B01-L']
  const rows = [...ids].reverse().map(row)
  act(() => live.publish([...unknown.map(row), ...rows, row(ids[0])]))
  await waitFor(() => expect(document.querySelectorAll('button[data-table-id]')).toHaveLength(6))
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-table-id]'))
  expect(buttons.map(button => button.dataset.tableId)).toEqual(ids)
  buttons.forEach((button, index) => expect(button).toHaveTextContent(labels[index]))
  for (const [index, button] of buttons.entries()) {
    fireEvent.click(button)
    await waitFor(() => expect(requests.some(url => url.includes(`/api/tables/${ids[index]}/ui-history`))).toBe(true))
  }
  fireEvent.click(buttons[3])
  act(() => live.publish(rows.filter(table => table.id !== ids[0]).reverse()))
  expect(document.querySelector('button.active[data-table-id]')).toHaveAttribute('data-table-id', ids[3])
  expect(screen.getByLabelText('AI預測結果')).toHaveTextContent('B04-L')
  act(() => live.publish(rows))
  expect(document.querySelector('button.active[data-table-id]')).toHaveAttribute('data-table-id', ids[3])
  expect(requests.filter(url => url.includes('/ui-history')).every(url => /\/BAV(?:01|02|03|03A|05|06)\/ui-history/.test(url))).toBe(true)
  expect(selectMemberTable(rows, ids[3])).toBe(rows.find(table => table.id === ids[3]))
  expect(selectMemberTable(unknown.map(row), ids[0])).toBeUndefined()
  act(() => live.publish(unknown.map(row)))
  expect(document.querySelectorAll('button[data-table-id]')).toHaveLength(0)
})
