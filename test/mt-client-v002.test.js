import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowserLikeHeaders, extractTables, shouldRequestTablesAfterAuth } from '../src/mt-client.js'

test('v002 builds browser-like MT websocket headers matching successful Chrome connection', () => {
  const headers = buildBrowserLikeHeaders({ origin: 'https://gsa.ofalive99.net' })

  assert.equal(headers.Origin, 'https://gsa.ofalive99.net')
  assert.match(headers['User-Agent'], /Chrome\/149\.0\.0\.0/)
  assert.equal(headers['Accept-Language'], 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7')
  assert.equal(headers['Accept-Encoding'], 'gzip, deflate, br, zstd')
  assert.equal(headers['Sec-WebSocket-Extensions'], 'permessage-deflate; client_max_window_bits')
  assert.equal(headers['Cache-Control'], 'no-cache')
  assert.equal(headers.Pragma, 'no-cache')
})

test('v002 waits for authenticate err 0 before requesting member and tables', () => {
  assert.equal(shouldRequestTablesAfterAuth('{"action":"/api/v1/authenticate","err":0,"msg":{}}'), true)
  assert.equal(shouldRequestTablesAfterAuth('{"action":"/api/v1/authenticate","err":1,"msg":{}}'), false)
  assert.equal(shouldRequestTablesAfterAuth('{"action":"/api/v1/member/me","err":0,"msg":{}}'), false)
})

test('v002 extracts real MT tables from msg.tables payload shape', () => {
  const tables = extractTables(JSON.stringify({
    action: '/api/v1/gametype/*/game/*/room/*/tables',
    err: 0,
    msg: {
      tables: [
        { table_id: 'BAG01', table_type: 'BAC', trend: { current_round: '34' } },
        { table_id: 'NU01', table_type: 'NU', trend: { current_round: '10' } },
      ],
    },
  }))

  assert.equal(tables.length, 2)
  assert.equal(tables[0].table_id, 'BAG01')
})
