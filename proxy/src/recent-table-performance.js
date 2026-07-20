export function createRecentTablePerformanceStore({ windowSize = 18 } = {}) {
  const limit = Math.max(1, Number(windowSize) || 18)
  const histories = new Map()
  const identities = new Set()

  function record(row = {}) {
    const tableId = String(row.table_id ?? row.tableId ?? '').trim()
    const shoe = String(row.shoe_no ?? row.shoe ?? '').trim()
    const round = Number(row.round_no ?? row.round)
    const predicted = normalizeSide(row.predicted_result ?? row.predictedResult)
    const actual = normalizeSide(row.actual_result ?? row.actualResult)
    if (!tableId || !shoe || !Number.isSafeInteger(round) || !predicted || !actual) return false
    const identity = `${tableId}:${shoe}:${round}`
    if (identities.has(identity)) return false
    identities.add(identity)
    const history = histories.get(tableId) ?? []
    history.push({ identity, shoe, predicted, hit: predicted === actual })
    while (history.length > limit) {
      const removed = history.shift()
      identities.delete(removed.identity)
    }
    histories.set(tableId, history)
    return true
  }

  function hydrate(rows = []) {
    histories.clear()
    identities.clear()
    const ordered = [...rows].sort((left, right) => Date.parse(left.created_at ?? left.createdAt ?? 0) - Date.parse(right.created_at ?? right.createdAt ?? 0))
    for (const row of ordered) record(row)
  }

  function summary(tableId, currentShoe = null) {
    const history = histories.get(String(tableId ?? '').trim()) ?? []
    const hits = history.filter((item) => item.hit).length
    const result = {
      recentHitRate: history.length ? hits / history.length : null,
      recentPredictionCount: history.length,
      source: 'settled_real_card_window',
    }
    if (!history.length) return result
    const settledDirectionalPredictionStats = Object.fromEntries(['banker', 'player'].map((direction) => {
      const directional = history.filter((item) => item.predicted === direction)
      const directionalHits = directional.filter((item) => item.hit).length
      return [direction, {
        settledPredictionCount: directional.length,
        hits: directionalHits,
        hitRate: directional.length ? directionalHits / directional.length : null,
      }]
    }))
    const latest = history.at(-1)
    let streakCount = 0
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index]
      if (item.shoe !== latest.shoe || item.predicted !== latest.predicted) break
      streakCount += 1
    }
    const requestedShoe = currentShoe == null ? '' : String(currentShoe).trim()
    return {
      ...result,
      settledDirectionalPredictionStats,
      ...(!requestedShoe || requestedShoe === latest.shoe
        ? { priorMainPredictionStreak: { direction: latest.predicted, count: streakCount } }
        : {}),
    }
  }

  return { hydrate, record, summary }
}

function normalizeSide(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'banker' || normalized === '莊' || normalized === '2') return 'banker'
  if (normalized === 'player' || normalized === '閒' || normalized === '1') return 'player'
  return null
}
