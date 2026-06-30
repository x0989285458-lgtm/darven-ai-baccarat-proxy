import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStrategyAnalysis } from '../src/strategy-analysis.js'

test('v035 compares strategy versions and marks best baseline by main hit rate', () => {
  const analysis = buildStrategyAnalysis([
    { strategy_version: 'v033-chrome-capture', rounds: 300, hits: 144, misses: 134, pushes: 22, main_hit_rate: '51.80' },
    { strategy_version: 'v034-auto-memory', rounds: 300, hits: 150, misses: 125, pushes: 25, main_hit_rate: '54.50' },
  ])

  assert.equal(analysis.bestStrategy.strategy_version, 'v034-auto-memory')
  assert.equal(analysis.strategyRows[0].rank, 1)
  assert.equal(analysis.strategyRows[0].conclusion, '目前最佳')
  assert.equal(analysis.strategyRows[1].conclusion, '低於最佳 -2.70%')
})

test('v035 extracts weak and strong tables from raw report summaries for next strategy advice', () => {
  const analysis = buildStrategyAnalysis([
    { strategy_version: 'v033-chrome-capture', rounds: 300, main_hit_rate: '51.80', raw_summary: { tables: [
      { displayName: 'MT百家樂第2桌', rounds: 36, hitRate: 64 },
      { displayName: 'MT百家樂第5桌', rounds: 26, hitRate: 38.5 },
      { displayName: 'MT百家樂第8桌', rounds: 30, hitRate: 45 },
    ] } },
  ])

  assert.deepEqual(analysis.strongTables.map((table) => table.name), ['MT百家樂第2桌'])
  assert.deepEqual(analysis.weakTables.map((table) => table.name), ['MT百家樂第5桌'])
  assert.ok(analysis.suggestions.some((text) => text.includes('第5桌') && text.includes('降低信心權重')))
  assert.ok(analysis.suggestions.some((text) => text.includes('整體命中率 51.8%') && text.includes('尚未達標 55%')))
})
