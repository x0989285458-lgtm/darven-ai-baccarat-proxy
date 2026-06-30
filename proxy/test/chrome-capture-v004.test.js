import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTablesFromCdpFrame, isTablesPayload, buildChromeLaunchArgs } from '../src/chrome-capture.js'

test('v004 extracts MT tables from Chrome DevTools websocket frame payload', () => {
  const frame = JSON.stringify({
    action: '/api/v1/gametype/*/game/*/room/*/tables',
    err: 0,
    msg: { tables: [{ table_id: 'BAG01', table_type: 'BAC', trend: { current_round: 12 } }] },
  })
  const tables = extractTablesFromCdpFrame(frame)
  assert.equal(tables.length, 1)
  assert.equal(tables[0].table_id, 'BAG01')
})

test('v004 recognizes tables payload by action name and msg.tables', () => {
  assert.equal(isTablesPayload({ action: '/api/v1/gametype/*/game/*/room/*/tables', msg: { tables: [] } }), true)
  assert.equal(isTablesPayload({ action: '/api/v1/ping', msg: {} }), false)
})

test('v004 launches Chrome with remote debugging and isolated profile', () => {
  const args = buildChromeLaunchArgs({ url: 'https://example.com', userDataDir: 'C:/tmp/draven', port: 9229 })
  assert.ok(args.includes('--remote-debugging-port=9229'))
  assert.ok(args.includes('--user-data-dir=C:/tmp/draven'))
  assert.ok(args.includes('https://example.com'))
})
