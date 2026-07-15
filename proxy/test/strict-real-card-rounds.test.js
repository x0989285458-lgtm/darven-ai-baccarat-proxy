import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createApp } from '../src/server.js'

test('v098.19 strict real-card mode persists only verified final summary cards', async () => {
  const previous = process.env.REQUIRE_REAL_CARD_ROUNDS
  process.env.REQUIRE_REAL_CARD_ROUNDS = 'true'
  const persisted = []
  const app = createApp({
    port: 0,
    autoConnect: false,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async (round) => persisted.push(round),
    },
  })

  try {
    app.state.setTables([{ tableId: 'BAG01', shoe: 1, round: 0 }])
    app.state.upsertRoundEvent({
      tableId: 'BAG01',
      shoe: 1,
      round: 1,
      winner: 'tie',
      rawResult: [0, 0, 0, 0, 0, 0, -1, -1, 0, 0],
      sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/show_poker',
    })
    await setImmediate()
    assert.equal(persisted.length, 0)

    app.state.setTables([{ tableId: 'BAG01', shoe: 1, round: 1 }])
    app.state.upsertRoundEvent({
      tableId: 'BAG01',
      shoe: 1,
      round: 2,
      winner: 'banker',
      rawResult: [11, 22, 48, 34, 0, 0, -1, -1, 9, 7],
      sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/show_poker',
    })
    await setImmediate()
    assert.equal(persisted.length, 0)

    app.state.upsertRoundEvent({
      tableId: 'BAG01',
      shoe: 1,
      round: 2,
      winner: 'banker',
      rawResult: [11, 22, 48, 34, 0, 0, -1, -1, 9, 7],
      sourceAction: '/api/v1/gametype/*/game/*/room/*/table/*/summary',
    })
    await setImmediate()
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].round, 2)
    assert.match(persisted[0].sourceAction, /\/summary$/)
  } finally {
    await app.stop().catch(() => {})
    if (previous === undefined) delete process.env.REQUIRE_REAL_CARD_ROUNDS
    else process.env.REQUIRE_REAL_CARD_ROUNDS = previous
  }
})

test('strict real-card mode is enabled by default unless REQUIRE_REAL_CARD_ROUNDS=false', async () => {
  const previous = process.env.REQUIRE_REAL_CARD_ROUNDS
  delete process.env.REQUIRE_REAL_CARD_ROUNDS
  const persisted = []
  const app = createApp({
    port: 0,
    autoConnect: false,
    supabaseClient: {
      configured: true,
      ensureInitialStrategy: async () => {},
      persistRound: async (round) => persisted.push(round),
    },
  })

  try {
    app.state.upsertRoundEvent({
      tableId: 'BAG01',
      shoe: 1,
      round: 1,
      winner: 'banker',
      rawResult: [0, 0, 0, 0, 0, 0, -1, -1, 7, 9],
      sourceAction: 'table_snapshot_delta',
    })
    await setImmediate()
    assert.equal(persisted.length, 0)
  } finally {
    await app.stop().catch(() => {})
    if (previous === undefined) delete process.env.REQUIRE_REAL_CARD_ROUNDS
    else process.env.REQUIRE_REAL_CARD_ROUNDS = previous
  }
})
