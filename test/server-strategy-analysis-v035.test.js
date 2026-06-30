import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

test('v035 server exposes strategy analysis from online memory reports', async () => {
  const onlineCoreClient = {
    configured: true,
    async getStrategyAnalysis() {
      return {
        connected: true,
        strategyRows: [{ strategy_version: 'v034-auto-memory', rounds: 300, main_hit_rate: 54.5, conclusion: '目前最佳' }],
        weakTables: [{ name: 'MT百家樂第5桌', hitRate: 38.5 }],
        strongTables: [{ name: 'MT百家樂第2桌', hitRate: 64 }],
        suggestions: ['第5桌低於45%，建議降低信心權重並啟用反向檢查'],
      }
    },
  }
  const app = createApp({ autoConnect: false, onlineCoreClient })
  const response = await app.inject({ method: 'GET', url: '/api/online-core/strategy-analysis' })
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(body.connected, true)
  assert.equal(body.strategyRows[0].strategy_version, 'v034-auto-memory')
  assert.equal(body.weakTables[0].name, 'MT百家樂第5桌')
})
