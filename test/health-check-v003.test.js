import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeHealth } from '../scripts/health-check.mjs'

test('v003 health checker summarizes service status for operators', () => {
  const summary = summarizeHealth({
    health: { ok: true, version: '004' },
    status: { connected: true, authenticated: true, tableCount: 9, lastMessageAt: '2026-06-25T12:00:00.000Z', reconnectCount: 1 },
  })
  assert.match(summary, /v004/)
  assert.match(summary, /已連線/)
  assert.match(summary, /已驗證/)
  assert.match(summary, /桌數: 9/)
})
