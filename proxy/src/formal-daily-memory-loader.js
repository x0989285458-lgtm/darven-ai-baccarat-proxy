const STRATEGY_VERSION = 'v105'
const SIDE_KEYS = ['tie', 'superSix', 'bankerPair', 'playerPair', 'bankerDragon', 'playerDragon']

export function createFormalDailySummaryLoader({ db } = {}) {
  if (typeof db?.query !== 'function') throw new Error('formal daily memory loader requires a database client')

  return async function loadDailySummary(reportDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate ?? ''))) throw new Error('formal daily memory loader requires a YYYY-MM-DD date')
    const result = await db.query(
      `select table_id, shoe_no, round_no, predicted_result, actual_result, is_hit,
              settlement_final, side_hits,
              jsonb_build_object(
                'side_actions', prediction_features->'side_actions',
                'side_hits', prediction_features->'side_hits',
                'settlement_final', prediction_features->'settlement_final'
              ) as prediction_features,
              issuance_status
         from public.daily_prediction_results
        where strategy_version = $1
          and created_at >= ($2::date::timestamp at time zone 'Asia/Taipei')
          and created_at < (($2::date + 1)::timestamp at time zone 'Asia/Taipei')`,
      [STRATEGY_VERSION, reportDate],
    )
    const rows = Array.isArray(result?.rows) ? result.rows : []
    if (rows.some(isUnresolvedPendingRow)) return null
    const finals = rows.filter(isAuthoritativeFinalRow)
    if (finals.length === 0) return null
    if (!finals.every(hasCompleteSavedSideResults)) throw new Error('formal daily memory loader found incomplete six-item side settlement data')
    return aggregateFinalRows(finals)
  }
}

function aggregateFinalRows(rows) {
  const mainRows = rows.filter((row) => ['banker', 'player'].includes(row.predicted_result) && ['banker', 'player'].includes(row.actual_result))
  const mainHits = mainRows.filter((row) => row.is_hit === true).length
  const pushes = rows.filter((row) => ['banker', 'player'].includes(row.predicted_result) && row.actual_result === 'tie').length
  const banker = mainCategory(rows, 'banker')
  const player = mainCategory(rows, 'player')
  const tie = sideCategory(rows, () => ['tie'])
  const dragon = sideCategory(rows, (row) => row.predicted_result === 'banker' ? ['bankerDragon'] : row.predicted_result === 'player' ? ['playerDragon'] : [])
  const pair = sideCategory(rows, () => ['bankerPair', 'playerPair'])
  const superSix = sideCategory(rows, () => ['superSix'])
  const sideCategories = [tie, dragon, pair, superSix]
  const sideActions = sideCategories.reduce((sum, item) => sum + item.total, 0)
  const sideHits = sideCategories.reduce((sum, item) => sum + item.hits, 0)
  return {
    rounds: new Set(rows.map((row) => `${row.table_id}:${row.shoe_no}:${row.round_no}`)).size,
    hits: mainHits,
    misses: mainRows.length - mainHits,
    pushes,
    mainEvaluated: mainRows.length,
    mainHitRate: percentage(mainHits, mainRows.length),
    sideActions,
    sideHits,
    sideHitRate: percentage(sideHits, sideActions),
    categories: { 莊: banker, 閒: player, 和: tie, 龍寶: dragon, 對子: pair, 超六: superSix },
  }
}

function mainCategory(rows, prediction) {
  const scoped = rows.filter((row) => row.predicted_result === prediction && ['banker', 'player'].includes(row.actual_result))
  const hits = scoped.filter((row) => row.actual_result === prediction).length
  return { hits, total: scoped.length, rate: percentage(hits, scoped.length) }
}

function sideCategory(rows, keysForRow) {
  let total = 0
  let hits = 0
  for (const row of rows) {
    const actions = row.prediction_features.side_actions
    const sideHits = savedSideHits(row)
    for (const key of keysForRow(row)) {
      if (actions[key] !== true) continue
      total += 1
      if (sideHits[key] === true) hits += 1
    }
  }
  return { hits, total, rate: percentage(hits, total) }
}

function isAuthoritativeFinalRow(row = {}) {
  return row.settlement_final === true || (row.settlement_final == null && row.prediction_features?.settlement_final === true)
}

function isUnresolvedPendingRow(row = {}) {
  if (isAuthoritativeFinalRow(row)) return false
  return !['expired_no_final', 'abandoned_shoe_change'].includes(String(row.issuance_status ?? 'pending'))
}

function hasCompleteSavedSideResults(row = {}) {
  return isCompleteBooleanMap(row.prediction_features?.side_actions) && isCompleteBooleanMap(savedSideHits(row))
}

function savedSideHits(row = {}) {
  return row.side_hits && typeof row.side_hits === 'object' && !Array.isArray(row.side_hits)
    ? row.side_hits
    : row.prediction_features?.side_hits
}

function isCompleteBooleanMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === SIDE_KEYS.length && SIDE_KEYS.every((key) => typeof value[key] === 'boolean')
}

function percentage(hits, total) {
  if (!total) return null
  return Math.round(((hits / total) * 100 + Number.EPSILON) * 100) / 100
}
