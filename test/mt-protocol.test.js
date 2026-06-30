import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAuthenticatePacket, buildMemberMePacket, buildPingPacket, buildTablesRequestPacket } from '../src/mt-protocol.js'

test('builds MT authenticate packet without leaking token into code constants', () => {
  const packet = buildAuthenticatePacket('sample-token')
  assert.deepEqual(packet, {
    method: 'POST',
    action: { name: '/api/v1/authenticate' },
    body: { type: 3, token: 'sample-token' },
  })
})

test('builds baccarat tables request packet for game type 3 room 1', () => {
  const packet = buildTablesRequestPacket()
  assert.deepEqual(packet, {
    method: 'GET',
    action: {
      name: '/api/v1/gametype/*/game/*/room/*/tables',
      data: { gametype_id: 3, game_id: 1, room_id: 1 },
    },
  })
})

test('v002 builds member/me packet with Traditional Chinese language', () => {
  assert.deepEqual(buildMemberMePacket(), {
    method: 'POST',
    action: { name: '/api/v1/member/me', lang: 'zhtw' },
  })
})

test('v002 builds 5-second heartbeat ping packet', () => {
  assert.deepEqual(buildPingPacket(), {
    method: 'POST',
    action: { name: '/api/v1/ping' },
  })
})
