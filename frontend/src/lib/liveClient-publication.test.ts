import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendPredictionIssue, LiveRoadClient, type LiveTable } from './liveClient'

const clock = '2026-10-28T01:00:00.000Z'
function table(revision = 1): LiveTable & { publication: any } {
  return {
    id: 'BAV01', table_id: 'BAV01', table_type: 'BAC', buildVersion: 'v105', sourceUpdatedAt: clock,
    trend: { bead_plate2: '0102', big2: '0201', big_eye2: '01', small2: '02', cockroach2: '01', current_shoe: 123, current_round: 18, total_round_banker: 9, total_round_player: 8 },
    publication: { state: 'ready', revision, publishedAt: clock, sourceCapturedAt: clock,
      rawIdentity: { tableId: 'BAV01', shoe: 123, round: 18 },
      readyIdentity: { tableId: 'BAV01', shoe: 123, round: 18, predictionId: 'pid-18' } },
    prediction: { source: 'backend', strategyVersion: 'v105', buildVersion: 'v105', targetTableId: 'BAV01', targetShoe: 123, targetRound: 18,
      predictionId: 'pid-18', issuedAt: clock, predictedResult: 'banker', confidence: 61,
      probabilities: { banker: 61, player: 30, tie: 9 },
      sidePredictions: { tie: 11, superSix: 22, bankerPair: 33, playerPair: 44, bankerDragon: 55, playerDragon: 66 },
      sideActions: { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: true, playerDragon: false } },
  }
}
function harness() {
  vi.useFakeTimers(); vi.setSystemTime(new Date(clock))
  let last: LiveTable | undefined
  const client = new LiveRoadClient({ onTables: tables => { last = tables[0] }, onStatus: vi.fn() })
  return { send: (value: LiveTable) => (client as any).publishTables([value], 'test'), last: () => last }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('atomic publication revocation', () => {
  it('rejects empty identity components rather than coercing an incomplete identity into ready', () => {
    const h = harness(); const next = table()
    next.publication.rawIdentity.shoe = ''; next.publication.readyIdentity.shoe = ''
    next.trend.current_shoe = ''; next.prediction!.targetShoe = ''
    h.send(next); expect(getBackendPredictionIssue(h.last())).not.toBeNull()
  })

  it.each(['rawIdentity', 'readyIdentity'])('rejects every mismatched %s component', key => {
    const h = harness()
    for (const [field, value] of [['tableId', 'other'], ['shoe', 124], ['round', 19], ['round', '18']]) {
      const next = table(); next.publication[key][field] = value
      h.send(next); expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    }
  })
  it('keeps original full prediction gates and actual source expiry', () => {
    const h = harness()
    for (const patch of [{ buildVersion: 'wrong' }, { strategyVersion: 'wrong' }, { predictionId: 'other' },
      { targetRound: 19 }, { sideActions: undefined }, { sidePredictions: undefined }, { probabilities: undefined }]) {
      const next = table(); next.prediction = { ...next.prediction!, ...patch }
      expect(getBackendPredictionIssue(next)).not.toBeNull()
    }
    const next = table(); next.publication.sourceCapturedAt = '2026-10-28T00:57:00.000Z'
    expect(getBackendPredictionIssue(next)).not.toBeNull()
    h.send(table()); const newer = table(2); newer.sourceUpdatedAt = '2026-10-28T00:59:59.000Z'
    newer.trend.big2 = '010201'; h.send(newer)
    expect(h.last()?.sourceUpdatedAt).toBe(clock)
    expect(h.last()?.trend.big2).toBe('010201')
    expect(getBackendPredictionIssue(h.last())).toBeNull()
  })

  it('does not let a stale lower revision evict a newer ready publication', () => {
    const h = harness(); h.send(table(5))
    const old = table(1); old.sourceUpdatedAt = '2026-10-27T00:00:00.000Z'; h.send(old)
    expect(getBackendPredictionIssue(h.last())).toBeNull()
    expect((h.last() as any).publication.revision).toBe(5)
  })
  it.each(['sourceCapturedAt', 'publishedAt'])('rejects non-ISO %s metadata', field => {
    const h = harness(); const value = table(); value.publication[field] = '2026/10/28 01:00:00 GMT'; h.send(value)
    expect(getBackendPredictionIssue(h.last())).not.toBeNull()
  })

  it('fences stale ready and same-revision resurrection; only newer exact ready restores', () => {
    const h = harness(); h.send(table(2))
    const pending = table(3); pending.publication.state = 'pending'; pending.prediction = undefined
    h.send(pending); h.send(table(2)); expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    h.send(table(3)); expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    const bad = table(4); bad.prediction!.buildVersion = 'wrong'; h.send(bad)
    expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    h.send(table(5)); expect(getBackendPredictionIssue(h.last())).toBeNull()
    expect(h.last()?.trend).toEqual(table(5).trend)
    h.send(table(1)); expect((h.last() as any).publication.revision).toBe(5)
  })

  it('rejects sourceCapturedAt rollback and metadata downgrade even after eviction', () => {
    const h = harness(); h.send(table(2))
    const regressed = table(3); regressed.publication.sourceCapturedAt = '2026-10-28T00:59:59.000Z'
    h.send(regressed); expect((h.last() as any).publication.sourceCapturedAt).toBe(clock)
    const absent = table(4); delete (absent as any).publication; h.send(absent)
    expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    h.send(table(4)); expect(getBackendPredictionIssue(h.last())).toBeNull()
    const stale = table(5); stale.sourceUpdatedAt = '2026-10-27T00:00:00.000Z'; h.send(stale)
    h.send(table(4)); expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    h.send(table(1)); expect(getBackendPredictionIssue(h.last())).not.toBeNull()
  })

  it.each([null, {}, [], 'ready', { state: 'ready', revision: 1 }, undefined])('fails closed on malformed metadata %j', publication => {
    const h = harness(); h.send(table()); h.send({ ...table(), publication })
    expect(getBackendPredictionIssue(h.last())).not.toBeNull()
  })

  it('normalizes full publication and road through the actual SSE reader', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(clock))
    const input = table(); let received: LiveTable | undefined
    const wire = { tableId: input.id, tableType: 'BAC', shoe: 123, round: 18, buildVersion: input.buildVersion,
      sourceUpdatedAt: clock, prediction: input.prediction, publication: input.publication,
      beadPlateRaw: input.trend.bead_plate2, bigRoadRaw: input.trend.big2, bigEyeRaw: input.trend.big_eye2,
      smallRoadRaw: input.trend.small2, cockroachRaw: input.trend.cockroach2, bankerCount: 9, playerCount: 8 }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({ tables: [wire] })}\n\n`))
    } }) })))
    const client = new LiveRoadClient({ onTables: rows => { received = rows[0] }, onStatus: vi.fn() })
    try {
      client.connect(); await vi.advanceTimersByTimeAsync(1)
      expect(received?.publication).toEqual(input.publication)
      expect(received?.trend).toMatchObject(input.trend)
      expect(received?.prediction).toEqual(input.prediction)
      expect(getBackendPredictionIssue(received)).toBeNull()
    } finally { client.disconnect(false) }
  })

  it.each(['pending', 'unavailable', 'wrong-identity'])('revokes same identity and source timestamp on %s', state => {
    const h = harness(); h.send(table()); expect(getBackendPredictionIssue(h.last())).toBeNull()
    const next = table()
    if (state === 'wrong-identity') next.publication.rawIdentity.round = 19
    else { next.publication.state = state; next.prediction = undefined }
    h.send(next)
    expect(getBackendPredictionIssue(h.last())).not.toBeNull()
    // Ready-only contract: revocation is not a visible old or new screen.
    expect(h.last()?.screenUnavailable).toBe(true)
    expect(h.last()?.trend).toEqual({ bead_plate2: '', big2: '' })
    expect(h.last()?.prediction).toBeUndefined()
  })
})
