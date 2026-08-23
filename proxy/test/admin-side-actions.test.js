import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'

test('admin requires complete boolean side_actions and side_hits before reporting availability', async () => {
  const queries = []
  const parameters = []
  const pool = {
    async query(sql, params = []) {
      queries.push(String(sql))
      parameters.push(params)
      if (queries.length === 1) return { rows: [{ rounds: 1 }] }
      if (queries.length === 2) {
        return { rows: [{ table_id: 'BAG01', rounds: 1, main_total: 1, main_hits: 1, side_actions: 0, side_hits: 0, side_actions_available: false }] }
      }
      return { rows: [{
        date: '2026-07-12', rounds: 1,
        banker_hit_rate: '100.0%', player_hit_rate: '-',
        side_actions_available: false,
        tie_hit_rate: 'unavailable', dragon_hit_rate: 'unavailable', pair_hit_rate: 'unavailable', six_hit_rate: 'unavailable',
      }] }
    },
  }

  const analytics = await createLicenseAdminClient({ pool }).getDailyAnalytics()

  assert.deepEqual(analytics.tableStats[0], {
    tableId: 'BAG01', tableName: '1桌', rounds: 1,
    mainHitRate: '100.0%', sideHitRate: 'unavailable', sideActionsAvailable: false,
  })
  assert.equal(analytics.dailyReports[0].side_actions_available, false)
  const sql = queries.join('\n')
  assert.match(sql, /jsonb_typeof\s*\(\s*prediction_features->'side_actions'\s*\)\s*=\s*'object'/i)
  for (const key of ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']) {
    assert.match(sql, new RegExp(`side_actions'\\s*\\?\\s*'${key}'`, 'i'))
    assert.match(sql, new RegExp(`coalesce\\(side_hits,\\s*prediction_features->'side_hits'\\)\\s*\\?\\s*'${key}'`, 'i'))
    assert.match(sql, new RegExp(`side_actions'->>'${key}'[\\s\\S]*in \\('true','false'\\)`, 'i'))
    assert.match(sql, new RegExp(`coalesce\\(side_hits,\\s*prediction_features->'side_hits'\\)->>'${key}'[\\s\\S]*in \\('true','false'\\)`, 'i'))
  }
  assert.doesNotMatch(sql, /jsonb_object_length/i)
  assert.doesNotMatch(sql, /jsonb_object_keys/i)
  assert.deepEqual(analytics.tableStats.map((row) => row.tableId), ['BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10'])
  assert.doesNotMatch(sql, /::date\s*-\s*6/i)
  assert.equal((sql.match(/strategy_version\s*=\s*\$1/gi) ?? []).length, 2)
  assert.equal((sql.match(/settlement_final\s+is\s+true/gi) ?? []).length, 2)
  assert.doesNotMatch(sql, /settlement_final\s+is\s+null/i)
  assert.doesNotMatch(sql, /prediction_features->>'settlement_final'/i)
  assert.deepEqual(parameters, [
    ['v105'],
    ['v105'],
  ])
})

test('admin analytics shares one in-flight load and reuses the successful cache', async () => {
  let calls = 0
  const pool = {
    async query(sql) {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      const text = String(sql)
      if (/select count\(distinct table_id/.test(text) && !/group by s\.table_id/.test(text)) return { rows: [{ rounds: 2 }] }
      if (/group by s\.table_id/.test(text)) return { rows: [] }
      return { rows: [] }
    },
  }
  const client = createLicenseAdminClient({ pool })
  const [first, second] = await Promise.all([client.getDailyAnalytics(), client.getDailyAnalytics()])
  assert.equal(first.todayRoundCount, 2)
  assert.deepEqual(second, first)
  assert.equal(calls, 2)
  await client.getDailyAnalytics()
  assert.equal(calls, 2)
})
