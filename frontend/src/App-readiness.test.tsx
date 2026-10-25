import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { LiveRoadClient, type LiveTable } from './lib/liveClient'

const now = Date.parse('2026-10-25T01:00:00Z')
const pendingText = '預測準備中、不可出手'
const readiness = (overrides = {}) => ({ state: 'pending', tableId: 'BAV01', shoe: 123, round: 18, observedAt: now, expiresAt: now + 1000, ...overrides })
function row(overrides: Record<string, unknown> = {}) {
  return { tableId: 'BAV01', displayName: 'MT百家樂第1桌', tableType: 'BAC', shoe: 123, round: 18,
    sourceUpdatedAt: new Date(now).toISOString(), buildVersion: 'v105', prediction: null,
    predictionReadiness: readiness(), ...overrides }
}
function prediction(overrides = {}) {
  return { source: 'backend', strategyVersion: 'v105', buildVersion: 'v105', targetTableId: 'BAV01', targetShoe: 123, targetRound: 18,
    predictionId: 'fixture-18', issuedAt: new Date(now).toISOString(), predictedResult: 'banker', confidence: 61,
    probabilities: { banker: 61, player: 30, tie: 9 }, scoreTotals: { banker: 61, player: 39 },
    sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
    sideActions: { tie: true, superSix: true, bankerPair: true, playerPair: true, bankerDragon: true, playerDragon: true }, ...overrides }
}
let stream: ReadableStreamDefaultController<Uint8Array>
let rows: ReturnType<typeof row>[]
let statusOnlyCode = 200
let statusCode = 200
let hangTables = false
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function send(next: typeof rows) {
  rows = next
  await act(async () => {
    stream.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({ tables: next })}\n\n`))
    await vi.advanceTimersByTimeAsync(0)
  })
}
async function mount(next = [row()]) {
  rows = next
  const view = render(<App />)
  await flush()
  await send(next)
  return view
}
function inactive() { expect(screen.getByLabelText('AI預測結果').querySelectorAll('.prediction-metric.active')).toHaveLength(0) }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  statusOnlyCode = 200; statusCode = 200; hangTables = false
  window.history.pushState({}, '', '/')
  window.sessionStorage.setItem('darven-member-session-token', 'test-only')
  const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body })
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/stream')) return Promise.resolve({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { stream = c } }) })
    if (url.endsWith('/api/tables')) return hangTables ? new Promise(() => {}) : Promise.resolve(response(rows, statusCode))
    if (url.includes('/ui-history')) return Promise.resolve(response({}, 503))
    if (url.includes('/member-session')) return Promise.resolve(response({ ok: true }))
    if (url.endsWith('/api/status')) return Promise.resolve(response({ connected: true, authenticated: true, buildVersion: 'v105', tableCount: rows.length }, statusOnlyCode === 200 ? statusCode : statusOnlyCode))
    return Promise.resolve(response({ configured: true, connected: true, maintenanceMode: false, items: [], reports: [], strategies: [] }))
  }))
})
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('publishes exact prediction and readiness atomically through the real client', async () => {
  rows = [row()]
  const received: LiveTable[][] = []
  const client = new LiveRoadClient({ onTables: tables => received.push(tables), onStatus: () => {} })
  client.connect()
  await flush()
  await send(rows)
  expect(received.at(-1)?.[0].predictionReadiness?.state).toBe('pending')
  await send([row({ prediction: prediction(), predictionReadiness: readiness({ state: 'ready' }), sourceUpdatedAt: new Date(now - 1).toISOString() })])
  expect(received.at(-1)?.[0].predictionReadiness?.state).toBe('ready')
  expect(received.at(-1)?.[0].prediction?.predictionId).toBe('fixture-18')
  client.disconnect(false)
  await flush()
  expect(vi.getTimerCount()).toBe(0)
})
it('does not mask a status HTTP error as normal pending', async () => {
  await mount()
  statusOnlyCode = 503
  await flush(750)
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  expect(document.querySelectorAll('.prediction-metric.active')).toHaveLength(0)
})

it('rejects a retired shoe arriving late with a newer source clock', async () => {
  await mount()
  await flush(1)
  await send([row({ shoe: 124, sourceUpdatedAt: new Date(now + 1).toISOString(), predictionReadiness: readiness({ shoe: 124 }) })])
  await flush(1)
  await send([row({ sourceUpdatedAt: new Date(now + 2).toISOString(), prediction: prediction(), predictionReadiness: readiness({ state: 'ready' }) })])
  inactive()
  expect(screen.getByText('第124靴 · 第18局', { selector: 'p' })).toBeInTheDocument()
})

it('recovers via heartbeat HTTP and keeps another ready table from enabling the pending table', async () => {
  await mount([row(), row({ tableId: 'BAV02', prediction: prediction({ targetTableId: 'BAV02' }), predictionReadiness: readiness({ state: 'ready', tableId: 'BAV02' }) })])
  inactive()
  rows = [row({ prediction: prediction(), predictionReadiness: readiness({ state: 'ready' }) })]
  await act(async () => {
    stream.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByLabelText('AI預測結果')).toHaveAttribute('data-prediction-id', 'fixture-18')
})

it('does not slide a pending deadline on same-identity replay with a newer source clock', async () => {
  await mount()
  await flush(500)
  await send([row({ sourceUpdatedAt: new Date(now + 500).toISOString(), predictionReadiness: readiness({ observedAt: now + 500, expiresAt: now + 1500 }) })])
  hangTables = true
  await flush(500)
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  expect(screen.getByLabelText('AI預測結果')).toHaveAttribute('data-prediction-readiness', 'unavailable')
  inactive()
})

it('replaces pending with an explicit same-clock unavailable instead of hiding a backend error', async () => {
  await mount()
  await send([row({ predictionReadiness: readiness({ state: 'unavailable' }) })])
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  inactive()
})

it('ignores late old-round predictions even when their source clock is newer', async () => {
  await mount([row({ round: 19, predictionReadiness: readiness({ round: 19 }) })])
  await flush(1)
  await send([row({ sourceUpdatedAt: new Date(now + 1).toISOString(), prediction: prediction(), predictionReadiness: readiness({ state: 'ready' }) })])
  inactive()
  expect(screen.getByRole('button', { name: 'MT百家樂第1桌 第19局' })).toBeInTheDocument()
})

it.each([
  ['old contract', undefined], ['unavailable', readiness({ state: 'unavailable' })],
  ['wrong table', readiness({ tableId: 'BAV02' })], ['wrong shoe', readiness({ shoe: 124 })],
  ['wrong round', readiness({ round: 19 })], ['string round', readiness({ round: '18' })],
  ['long window', readiness({ expiresAt: now + 10001 })], ['expired', readiness({ expiresAt: now })],
  ['future', readiness({ observedAt: now + 1 })], ['invalid clock', readiness({ observedAt: 'invalid' })],
])('fails closed for %s metadata', async (_name, metadata) => {
  await mount([row({ predictionReadiness: metadata })])
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  expect(screen.getByLabelText('AI預測結果')).toHaveAttribute('data-prediction-readiness', 'unavailable')
  inactive()
})

it('does not let ready metadata authorize an inexact prediction', async () => {
  await mount([row({ prediction: prediction({ targetRound: 17 }), predictionReadiness: readiness({ state: 'ready' }) })])
  inactive()
  expect(screen.getByLabelText('AI預測結果')).toHaveAttribute('data-prediction-id', '')
})
it('rejects pending under a mismatched build', async () => {
  await mount([row({ buildVersion: 'old' })])
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  inactive()
})
it('does not preserve pending when a protected HTTP read fails', async () => {
  await mount()
  statusCode = 503
  await flush(750)
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  expect(document.querySelectorAll('.prediction-metric.active')).toHaveLength(0)
})

it('expires locally without a new payload and removes timers on unmount', async () => {
  const view = await mount()
  expect(screen.getByText(pendingText)).toBeInTheDocument()
  hangTables = true
  await flush(1000)
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  expect(screen.getByText(/預測暫不可用，已停止出手/)).toBeInTheDocument()
  inactive()
  view.unmount()
  await flush()
  expect(vi.getTimerCount()).toBe(0)
})

it('exposes exact readiness and actionable prediction ID without adding UI', async () => {
  await mount()
  const card = screen.getByLabelText('AI預測結果')
  expect(card).toHaveAttribute('data-prediction-readiness', 'pending')
  expect(card).toHaveAttribute('data-prediction-id', '')
  await send([row({ prediction: prediction(), predictionReadiness: readiness({ state: 'ready' }) })])
  expect(card).toHaveAttribute('data-prediction-readiness', 'ready')
  expect(card).toHaveAttribute('data-prediction-id', 'fixture-18')
  await send([row({ round: 19, sourceUpdatedAt: new Date(now + 1).toISOString(), predictionReadiness: readiness({ round: 19 }) })])
  inactive()
  expect(card).toHaveAttribute('data-prediction-id', '')
})

it('real App shows non-actionable pending, then atomically accepts exact durable enrichment with regressed source clock', async () => {
  await mount()
  expect(screen.getByText(pendingText)).toBeInTheDocument()
  inactive()
  expect(screen.queryByText(/預測暫不可用，已停止出手/)).not.toBeInTheDocument()
  await send([row({ sourceUpdatedAt: new Date(now - 1).toISOString(), prediction: prediction(), predictionReadiness: readiness({ state: 'ready' }) })])
  expect(screen.queryByText(pendingText)).not.toBeInTheDocument()
  expect(screen.getByLabelText('AI預測結果').querySelectorAll('.prediction-metric.active')).toHaveLength(7)
})
