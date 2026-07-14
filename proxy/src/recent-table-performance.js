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
    history.push({ identity, hit: predicted === actual })
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

  function summary(tableId) {
    const history = histories.get(String(tableId ?? '').trim()) ?? []
    const hits = history.filter((item) => item.hit).length
    return {
      recentHitRate: history.length ? hits / history.length : null,
      recentPredictionCount: history.length,
      source: 'settled_real_card_window',
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
