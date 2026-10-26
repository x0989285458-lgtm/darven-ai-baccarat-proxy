import type { LiveTable } from './liveClient'

/** A count is not a contiguous-round watermark. Never invent an "as of" round. */
export function trendPendingNotice(table?: LiveTable): string {
  const pending = '（更新中／資料待補齊）'
  const trend = table?.trend
  if (!table?.trendBundle) return pending
  if (!trend || !trend.current_shoe || !Number.isSafeInteger(trend.current_round)) return pending
  const completed = Number(trend.current_round) - 1
  const meta = table.trendBundle
  const reasons = ['complete', 'missing-or-invalid-bundle', 'shoe-mismatch', 'coverage-mismatch', 'legacy-unverified', 'invalid-contract']
  if (meta.schemaVersion !== 1 || typeof meta.tableId !== 'string' || !/^BAV\d{2}A?$/.test(meta.tableId)
    || meta.tableId !== String(table.table_id ?? table.id)
    || typeof meta.shoe !== 'string' || !meta.shoe || meta.shoe !== String(trend.current_shoe)
    || !['available', 'pending'].includes(meta.status) || !reasons.includes(meta.reason)
    || (meta.status === 'available' && meta.reason !== 'complete')
    || (meta.status === 'pending' && meta.reason === 'complete')
    || !Number.isSafeInteger(meta.completedRound) || Number(meta.completedRound) < 0
    || Number(meta.completedRound) > completed) return pending
  const coverage = Number(meta.completedRound)
  const notice = meta.status === 'pending' || coverage !== completed ? `（更新中／截至第${coverage}局）` : ''
  const counts = [trend.total_round_player, trend.total_round_banker, trend.total_round_tie]
  if (completed < 0 || !counts.every(n => Number.isSafeInteger(n) && Number(n) >= 0)
    || counts.reduce<number>((sum, n) => sum + Number(n), 0) !== coverage) return pending
  if (coverage === 0) return trend.bead_plate2 === '' && trend.big2 === '' ? notice : pending

  // Match the existing MT bead decoder's two-digit cells, but reject unknown
  // fragments instead of silently dropping them as a display parser may do.
  if (typeof trend.bead_plate2 !== 'string' || !/^(?:[0-3][123])+(?:[#,](?:[0-3][123])+)*$/.test(trend.bead_plate2)) return pending
  const beads = trend.bead_plate2.match(/\d{2}/g) ?? []
  if (beads.length !== coverage || counts.some((n, i) => beads.filter(code => Number(code[1]) === i + 1).length !== n)) return pending

  if (typeof trend.big2 !== 'string') return pending
  const tokens = trend.big2.split(/[#,]/).map(code => code.trim())
  // Empty positions and 0000 are layout padding, never usable road cells.
  if (tokens.some(code => code !== '' && code !== '0000' && !/^\d[0-9][0-3][12]$/.test(code))) return pending
  const cells = tokens.filter(code => /^\d[0-9][0-3][12]$/.test(code))
  if (cells.length !== Number(counts[0]) + Number(counts[1])
    || cells.filter(code => code[3] === '1').length !== counts[0]
    || cells.filter(code => code[3] === '2').length !== counts[1]) return pending
  return notice
}
