import test from 'node:test'
import assert from 'node:assert/strict'

const loaderModule = await import('../src/formal-daily-memory-loader.js').catch(() => ({}))

test('formal daily loader waits for pending rounds then aggregates v105 authoritative Finals with the admin daily-report rules', async () => {
  assert.equal(typeof loaderModule.createFormalDailySummaryLoader, 'function', 'formal daily memory loader is not implemented')

  const queries = []
  let rows = [{
    table_id: 'BAG01', shoe_no: 'S1', round_no: 1, predicted_result: 'banker', actual_result: null,
    is_hit: null, settlement_final: false, side_hits: {}, prediction_features: { side_actions: completeActions() }, issuance_status: 'pending',
  }]
  const db = {
    async query(sql, params) {
      queries.push({ sql, params })
      return { rows }
    },
  }
  const loadDailySummary = loaderModule.createFormalDailySummaryLoader({ db })
  assert.equal(await loadDailySummary('2026-07-24'), null, 'a Taipei day with pending predictions must not be finalized')

  rows = [
    finalRow({ table_id: 'BAG01', shoe_no: 'S1', round_no: 1, predicted_result: 'banker', actual_result: 'banker', is_hit: true,
      actions: completeActions({ superSix: true, bankerPair: true, bankerDragon: true }),
      hits: completeHits({ superSix: true, bankerPair: true, bankerDragon: true }) }),
    finalRow({ table_id: 'BAG02', shoe_no: 'S2', round_no: 1, predicted_result: 'player', actual_result: 'banker', is_hit: false,
      actions: completeActions({ tie: true, playerDragon: true }), hits: completeHits() }),
    finalRow({ table_id: 'BAG03', shoe_no: 'S3', round_no: 1, predicted_result: 'banker', actual_result: 'tie', is_hit: false,
      actions: completeActions({ tie: true }), hits: completeHits({ tie: true }) }),
  ]
  const summary = await loadDailySummary('2026-07-24')

  assert.equal(queries.length, 2)
  assert.deepEqual(queries[1].params, ['v105', '2026-07-24'])
  assert.match(queries[1].sql, /from\s+public\.daily_prediction_results/i)
  assert.match(queries[1].sql, /created_at\s+>=\s*\(\$2::date::timestamp\s+at\s+time\s+zone\s+'Asia\/Taipei'\)/i)
  assert.match(queries[1].sql, /created_at\s+<\s*\(\(\$2::date\s*\+\s*1\)::timestamp\s+at\s+time\s+zone\s+'Asia\/Taipei'\)/i)
  assert.match(queries[1].sql, /strategy_version\s*=\s*\$1/i)
  assert.match(queries[1].sql, /jsonb_build_object[\s\S]*side_actions[\s\S]*side_hits[\s\S]*settlement_final/i)
  assert.doesNotMatch(queries[1].sql, /issued_prediction_payload|player_card|banker_card|raw_event/i)

  assert.deepEqual(summary, {
    rounds: 3,
    hits: 1,
    misses: 1,
    pushes: 1,
    mainEvaluated: 2,
    mainHitRate: 50,
    sideActions: 6,
    sideHits: 4,
    sideHitRate: 66.67,
    categories: {
      莊: { hits: 1, total: 1, rate: 100 },
      閒: { hits: 0, total: 1, rate: 0 },
      和: { hits: 1, total: 2, rate: 50 },
      龍寶: { hits: 1, total: 2, rate: 50 },
      對子: { hits: 1, total: 1, rate: 100 },
      超六: { hits: 1, total: 1, rate: 100 },
    },
  })
})

function finalRow({ table_id, shoe_no, round_no, predicted_result, actual_result, is_hit, actions, hits }) {
  return {
    table_id, shoe_no, round_no, predicted_result, actual_result, is_hit,
    settlement_final: true,
    side_hits: hits,
    prediction_features: { side_actions: actions },
    issuance_status: 'settled',
  }
}

function completeActions(overrides = {}) {
  return { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false, ...overrides }
}

function completeHits(overrides = {}) {
  return { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false, ...overrides }
}
