import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendPredictionIssue, LiveRoadClient, type BackendPrediction, type LiveTable } from './liveClient'

function snapshot(round = 18, ready = true, shoe = 123) {
  const prediction: BackendPrediction = {
    source: 'backend', strategyVersion: 'v105', buildVersion: 'v105',
    targetTableId: 'BAV01', targetShoe: shoe, targetRound: round,
    predictionId: `test-${shoe}-${round}`, issuedAt: new Date().toISOString(),
    predictedResult: 'banker', confidence: 61,
    probabilities: { banker: 61, player: 30, tie: 9 },
    sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
    sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false },
  }
  return { tableId: 'BAV01', tableType: 'BAC', shoe, round, buildVersion: 'v105',
    sourceUpdatedAt: new Date().toISOString(), prediction: ready ? prediction : undefined }
}

function harness() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T16:23:30Z'))
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const tables = vi.fn<(tables: LiveTable[]) => void>()
  const unauthorized = vi.fn()
  const rest = vi.fn(async () => ({ ok: true, status: 200, json: async () => [snapshot()] }))
  const status = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ buildVersion: 'v105', connected: true, authenticated: true, tableCount: 1 }) }))
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith('/stream')) return Promise.resolve({ ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }) })
    return url.endsWith('/status') ? status() : rest()
  })
  vi.stubGlobal('fetch', fetcher)
  const client = new LiveRoadClient({ memberSessionToken: 'offline-test', onTables: tables, onStatus: vi.fn(), onUnauthorized: unauthorized })
  client.connect()
  return { client, tables, rest, status, unauthorized,
    send: (values: ReturnType<typeof snapshot>[]) => stream.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({ tables: values })}\n\n`)),
    heartbeat: () => stream.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n')),
    last: () => tables.mock.calls.at(-1)?.[0]?.[0],
    close: () => { client.disconnect(false); stream.close() },
  }
}

describe('current prediction recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('starts the first missing-prediction read immediately rather than after 750ms', async () => {
    const h = harness()
    try {
      h.send([snapshot(18, false)])
      await vi.advanceTimersByTimeAsync(1)
      expect(h.rest).toHaveBeenCalledTimes(1)
      expect(getBackendPredictionIssue(h.last())).toBeNull()
    } finally { h.close() }
  })

  it('repairs prediction without requesting or waiting for proxy status', async () => {
    const h = harness()
    h.status.mockImplementation(() => new Promise(() => {}))
    try {
      h.send([snapshot(18, false)])
      await vi.advanceTimersByTimeAsync(1)
      expect(h.rest).toHaveBeenCalledTimes(1)
      expect(h.status).not.toHaveBeenCalled()
      expect(getBackendPredictionIssue(h.last())).toBeNull()
    } finally { h.close() }
  })

  it.each([123, 124])('never carries a prediction into another round or shoe %s', async (shoe) => {
    const h = harness()
    h.rest.mockImplementation(() => new Promise(() => {}))
    try {
      h.send([snapshot()]); await vi.advanceTimersByTimeAsync(1)
      h.send([snapshot(19, false, shoe)]); await vi.advanceTimersByTimeAsync(1)
      expect(h.last()?.trend.current_round).toBe(19)
      expect(h.last()?.trend.current_shoe).toBe(shoe)
      expect(h.last()?.prediction).toBeUndefined()
    } finally { h.close() }
  })

  it('does not hide an explicit build mismatch by retaining the old prediction', async () => {
    const h = harness()
    h.rest.mockImplementation(() => new Promise(() => {}))
    try {
      h.send([snapshot()]); await vi.advanceTimersByTimeAsync(1)
      h.send([{ ...snapshot(18, false), buildVersion: 'WRONG' }]); await vi.advanceTimersByTimeAsync(1)
      expect(h.last()?.buildVersion).toBe('WRONG')
      expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    } finally { h.close() }
  })

  it('does not let an already-held heartbeat status block a prediction-only read', async () => {
    const h = harness()
    h.status.mockImplementation(() => new Promise(() => {}))
    try {
      h.send([snapshot()]); h.heartbeat(); await vi.advanceTimersByTimeAsync(1)
      expect(h.rest).toHaveBeenCalledTimes(1)
      h.rest.mockImplementation(async () => ({ ok: true, status: 200, json: async () => [snapshot(19)] }))
      h.send([snapshot(19, false)]); await vi.advanceTimersByTimeAsync(1)
      expect(h.rest).toHaveBeenCalledTimes(2)
      expect(h.status).toHaveBeenCalledTimes(1)
      expect(h.last()?.prediction?.targetRound).toBe(19)
      expect(getBackendPredictionIssue(h.last())).toBeNull()
    } finally { h.close() }
  })

  it('shares one held tables read between heartbeat and missing-prediction refresh', async () => {
    const h = harness()
    let release!: (value: Awaited<ReturnType<typeof h.rest>>) => void
    h.rest.mockImplementation(() => new Promise(resolve => { release = resolve }))
    try {
      h.heartbeat(); await vi.advanceTimersByTimeAsync(1)
      h.send([snapshot(18, false)]); h.heartbeat(); await vi.advanceTimersByTimeAsync(1)
      expect(h.rest).toHaveBeenCalledTimes(1)
      release({ ok: true, status: 200, json: async () => [snapshot()] })
      await vi.advanceTimersByTimeAsync(1)
      expect(getBackendPredictionIssue(h.last())).toBeNull()
    } finally { h.close() }
  })

  it('fails closed on prediction-only 401 and clears all timers', async () => {
    const h = harness()
    h.rest.mockImplementation(async () => ({ ok: false, status: 401, json: async () => [] }))
    try {
      h.send([snapshot(18, false)]); await vi.advanceTimersByTimeAsync(1)
      expect(h.unauthorized).toHaveBeenCalledTimes(1)
      expect(h.tables.mock.calls.at(-1)?.[0]).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally { h.close() }
  })

  it('does not erase an exact same-identity prediction with a newer null snapshot', async () => {
    const h = harness()
    try {
      h.send([snapshot()]); await vi.advanceTimersByTimeAsync(1)
      expect(getBackendPredictionIssue(h.last())).toBeNull()
      h.send([snapshot(18, false)]); await vi.advanceTimersByTimeAsync(1)
      expect(getBackendPredictionIssue(h.last())).toBeNull()
      expect(h.last()?.prediction?.predictionId).toBe('test-123-18')
      expect(h.last()?.sourceUpdatedAt).toBe(new Date('2026-10-27T16:23:30.001Z').toISOString())
    } finally { h.close() }
  })
})
