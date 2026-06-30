export function buildStrategyAnalysis(reports = []) {
  const strategyRows = reports
    .map((report) => ({
      strategy_version: report.strategy_version ?? report.strategyVersion ?? 'unknown',
      report_type: report.report_type ?? report.reportType ?? 'live_test',
      rounds: numberOrZero(report.rounds ?? report.total?.rounds),
      hits: numberOrZero(report.hits ?? report.total?.hits),
      misses: numberOrZero(report.misses ?? report.total?.misses),
      pushes: numberOrZero(report.pushes ?? report.total?.pushes),
      main_hit_rate: numberOrZero(report.main_hit_rate ?? report.mainHitRate ?? report.total?.hitRate),
      created_at: report.created_at ?? report.createdAt ?? null,
    }))
    .sort((a, b) => b.main_hit_rate - a.main_hit_rate || b.rounds - a.rounds)
    .map((row, index, rows) => {
      const best = rows[0]?.main_hit_rate ?? row.main_hit_rate
      const diff = round(row.main_hit_rate - best)
      return {
        ...row,
        rank: index + 1,
        conclusion: index === 0 ? '目前最佳' : `低於最佳 ${diff.toFixed(2)}%`,
      }
    })

  const bestStrategy = strategyRows[0] ?? null
  const tableRows = collectTableRows(reports)
  const weakTables = tableRows.filter((table) => table.hitRate < 45).sort((a, b) => a.hitRate - b.hitRate)
  const strongTables = tableRows.filter((table) => table.hitRate >= 60).sort((a, b) => b.hitRate - a.hitRate)
  const watchTables = tableRows.filter((table) => table.hitRate >= 45 && table.hitRate < 50).sort((a, b) => a.hitRate - b.hitRate)
  const suggestions = buildSuggestions({ bestStrategy, weakTables, strongTables, watchTables })

  return { strategyRows, bestStrategy, weakTables, strongTables, watchTables, suggestions }
}

function collectTableRows(reports) {
  const rows = []
  for (const report of reports) {
    const raw = report.raw_summary ?? report.rawSummary ?? report
    for (const table of raw.tables ?? []) {
      const name = table.displayName ?? table.name ?? table.tableName ?? `第${table.slot ?? table.table_id ?? '?'}桌`
      rows.push({
        name,
        strategy_version: report.strategy_version ?? report.strategyVersion ?? 'unknown',
        rounds: numberOrZero(table.rounds),
        hitRate: numberOrZero(table.hitRate ?? table.main_hit_rate ?? table.mainHitRate),
        hits: numberOrZero(table.hits),
        misses: numberOrZero(table.misses),
      })
    }
  }
  return rows
}

function buildSuggestions({ bestStrategy, weakTables, strongTables, watchTables }) {
  const suggestions = []
  const bestRate = bestStrategy?.main_hit_rate ?? 0
  if (bestStrategy) {
    suggestions.push(`整體命中率 ${formatRate(bestRate)}%，${bestRate >= 55 ? '已達標 55%，可進入保守放大測試' : '尚未達標 55%，下一版先針對弱桌降權'}`)
  }
  for (const table of weakTables.slice(0, 3)) suggestions.push(`${shortTableName(table.name)}低於45%，建議降低信心權重並啟用反向檢查`)
  for (const table of strongTables.slice(0, 3)) suggestions.push(`${shortTableName(table.name)}高於60%，可提高跟路權重但仍保留信心上限`)
  for (const table of watchTables.slice(0, 2)) suggestions.push(`${shortTableName(table.name)}位於45-50%，列入觀察不先改公式`)
  return suggestions
}

function shortTableName(name) {
  const match = String(name).match(/第\d+[A-Z]?桌/)
  return match?.[0] ?? name
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function round(value) {
  return Math.round(value * 100) / 100
}

function formatRate(value) {
  return Number(value).toFixed(1).replace(/\.0$/, '')
}
