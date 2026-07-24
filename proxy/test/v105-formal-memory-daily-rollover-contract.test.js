import test from 'node:test'
import assert from 'node:assert/strict'

const rolloverModule = await import('../src/formal-daily-memory-rollover.js').catch(() => ({}))

test('first authoritative Final of a Taipei day finalizes the prior day once and retries failures', async () => {
  assert.equal(typeof rolloverModule.createFormalDailyMemoryRollover, 'function', 'formal daily memory rollover is not implemented')

  const loadedDates = []
  const successfulWrites = []
  const upsertAttempts = []
  let failDate = null
  const loadDailySummary = async (reportDate) => {
    loadedDates.push(reportDate)
    return {
      rounds: 1000,
      hits: 506,
      misses: 414,
      pushes: 80,
      mainEvaluated: 920,
      mainHitRate: 55,
      sideActions: 200,
      sideHits: 42,
      sideHitRate: 21,
      categories: {},
    }
  }
  const onlineCoreClient = {
    async upsertDailySummary(summary) {
      upsertAttempts.push(summary.reportDate)
      if (failDate === summary.reportDate) {
        failDate = null
        throw new Error('temporary daily memory failure')
      }
      successfulWrites.push(summary)
      return { ok: true }
    },
  }
  const rollover = rolloverModule.createFormalDailyMemoryRollover({ loadDailySummary, onlineCoreClient })

  const provisional = await rollover.observe({ settlementFinal: false, resolvedAt: '2026-07-24T15:59:58.000Z' })
  assert.equal(provisional.skipped, true)
  assert.equal(loadedDates.length, 0)

  await rollover.observe({ settlementFinal: true, resolvedAt: '2026-07-24T15:59:59.000Z' })
  await rollover.observe({ settlementFinal: true, resolvedAt: '2026-07-24T15:59:59.500Z' })
  assert.deepEqual(loadedDates, ['2026-07-23'])
  assert.deepEqual(successfulWrites.map((row) => row.reportDate), ['2026-07-23'])

  await Promise.all([
    rollover.observe({ settlementFinal: true, resolvedAt: '2026-07-24T16:00:01.000Z' }),
    rollover.observe({ settlementFinal: true, resolvedAt: '2026-07-24T16:00:02.000Z' }),
    rollover.observe({ settlementFinal: true, resolvedAt: '2026-07-24T16:00:03.000Z' }),
  ])
  assert.deepEqual(loadedDates, ['2026-07-23', '2026-07-24'])
  assert.deepEqual(successfulWrites.map((row) => row.reportDate), ['2026-07-23', '2026-07-24'])
  assert.equal(successfulWrites[1].timezone, 'Asia/Taipei')
  assert.equal(successfulWrites[1].strategyVersion, 'v105')

  failDate = '2026-07-25'
  await assert.rejects(
    rollover.observe({ settlementFinal: true, resolvedAt: '2026-07-25T16:00:01.000Z' }),
    /temporary daily memory failure/,
  )
  await rollover.observe({ settlementFinal: true, resolvedAt: '2026-07-25T16:00:02.000Z' })
  assert.deepEqual(upsertAttempts.filter((date) => date === '2026-07-25'), ['2026-07-25', '2026-07-25'])
  assert.equal(successfulWrites.filter((row) => row.reportDate === '2026-07-25').length, 1)
})
