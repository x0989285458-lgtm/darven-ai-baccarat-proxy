import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import App from './App'
import type { TrendBundle } from './lib/liveClient'

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals() })
it('real API and SSE LiveRoadClient delivers source metadata to App and clears same-identity pending', async () => {
  window.history.pushState({}, '', '/')
  window.sessionStorage.setItem('darven-member-session-token', 'test-token')
  const metadata: TrendBundle = { schemaVersion: 1, tableId: 'BAV01', shoe: '123', completedRound: 21, status: 'pending', reason: 'coverage-mismatch' }
  const row = { tableId: 'BAV01', tableType: 'BAC', shoe: 123, round: 22, bankerCount: 21, playerCount: 0, tieCount: 0,
    beadPlateRaw: '02'.repeat(21), bigRoadRaw: Array(21).fill('0802').join('#'), sourceUpdatedAt: new Date().toISOString(), trendBundle: metadata }
  let stream: ReadableStreamDefaultController<Uint8Array>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/member-session')) return { ok: true, status: 200, json: async () => ({ ok: true, sessionExpiresAt: new Date(Date.now() + 600000).toISOString() }) }
    if (url.includes('/api/tables/stream')) return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n')) } }) }
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ connected: true, authenticated: true, tableCount: 1, buildVersion: 'v105' }) }
    if (url.endsWith('/api/tables')) return { ok: true, status: 200, json: async () => [row] }
    return { ok: false, status: 404, json: async () => ({}) }
  }))
  render(<App />)
  const heading = () => document.querySelector('.road-card h2')
  await waitFor(() => expect(heading()).toHaveTextContent('更新中／截至第21局'))
  await waitFor(() => expect(stream!).toBeDefined())
  await act(async () => {
    stream!.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({ tables: [{ ...row, trendBundle: { ...metadata, status: 'available', reason: 'complete' } }] })}\n\n`))
  })
  await waitFor(() => expect(heading()).toHaveTextContent(/^路單$/))
  expect(document.querySelectorAll('.road-card')).toHaveLength(1)
  expect(document.querySelector('.dashboard-stats-row')).not.toHaveTextContent('更新中')
})
