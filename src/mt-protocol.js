export function buildAuthenticatePacket(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('MT_TOKEN is required')
  }
  return {
    method: 'POST',
    action: { name: '/api/v1/authenticate' },
    body: { type: 3, token },
  }
}

export function buildMemberMePacket({ lang = 'zhtw' } = {}) {
  return {
    method: 'POST',
    action: { name: '/api/v1/member/me', lang },
  }
}

export function buildTablesRequestPacket({ gametypeId = 3, gameId = 1, roomId = 1 } = {}) {
  return {
    method: 'GET',
    action: {
      name: '/api/v1/gametype/*/game/*/room/*/tables',
      data: {
        gametype_id: gametypeId,
        game_id: gameId,
        room_id: roomId,
      },
    },
  }
}

export function buildPingPacket() {
  return {
    method: 'POST',
    action: { name: '/api/v1/ping' },
  }
}
