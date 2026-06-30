import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPersistableLiveReport, persistFinalLiveReport } from '../src/test-report-persistence.js'

test('v034 builds cloud memory report row input from 300-round live report', () => {
  const report = buildPersistableLiveReport({
    title: 'Draven 300局',
    total: { rounds: 300, hits: 144, misses: 134, pushes: 22, mainEvaluated: 278, hitRate: 51.8, sideActions: 277, sideHits: 27, sideHitRate: 9.7 },
  }, {
    strategyVersion: 'v034-auto-memory',
    reportType: '300_round_live_test',
    reportPath: 'proxy/reports/draven-v034-300-round-report.png',
    metadata: { source: 'local_chrome', tables: 9 },
  })

  assert.equal(report.strategyVersion, 'v034-auto-memory')
  assert.equal(report.reportType, '300_round_live_test')
  assert.equal(report.total.rounds, 300)
  assert.equal(report.reportPath, 'proxy/reports/draven-v034-300-round-report.png')
  assert.equal(report.metadata.source, 'local_chrome')
})

test('v034 persists final report to online memory center when client is configured', async () => {
  const calls = []
  const onlineCoreClient = {
    configured: true,
    async persistTestReport(report, slug) {
      calls.push({ report, slug })
      return { ok: true, row: { rounds: report.total.rounds, main_hit_rate: report.total.hitRate } }
    },
  }
  const result = await persistFinalLiveReport({
    total: { rounds: 300, hits: 144, misses: 134, pushes: 22, mainEvaluated: 278, hitRate: 51.8 },
  }, { onlineCoreClient, projectSlug: 'ai-baccarat' })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].slug, 'ai-baccarat')
  assert.equal(calls[0].report.reportType, '300_round_live_test')
})
