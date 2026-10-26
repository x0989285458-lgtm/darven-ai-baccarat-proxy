const REASONS = new Set(['complete', 'missing-or-invalid-bundle', 'shoe-mismatch', 'coverage-mismatch', 'legacy-unverified', 'invalid-contract'])

// Coverage is source-owned. Never derive a watermark from partial road/count data.
export function normalizeTrendBundle(table = {}) {
  const value = table.trendBundle
  const pending = (reason, shoe = null, completedRound = null) => ({
    schemaVersion: 1, tableId: table.tableId, shoe, completedRound, status: 'pending', reason,
  })
  if (value == null) return pending('missing-or-invalid-bundle')
  // Re-normalizing our absent-metadata marker must not turn legacy table IDs
  // into an explicit invalid source contract. This never grants completeness.
  if (value.schemaVersion === 1 && value.tableId === table.tableId
    && value.status === 'pending' && value.reason === 'missing-or-invalid-bundle'
    && value.shoe === null && value.completedRound === null) return pending('missing-or-invalid-bundle')
  if (typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || !/^BAV\d{2}A?$/.test(value.tableId) || value.tableId !== table.tableId
    || !(value.shoe === null || (typeof value.shoe === 'string' && value.shoe.length > 0 && value.shoe.trim() === value.shoe))
    || !(value.completedRound === null || (Number.isSafeInteger(value.completedRound) && value.completedRound >= 0))
    || !['available', 'pending'].includes(value.status) || !REASONS.has(value.reason)
    || (value.status === 'available' && (value.reason !== 'complete' || value.completedRound === null || value.shoe === null))
    || (value.status === 'pending' && value.reason === 'complete')) return pending('invalid-contract')
  if (value.shoe === null) return pending(value.reason)
  if (table.shoe == null || value.shoe !== String(table.shoe)) return pending('shoe-mismatch', value.shoe)
  if (value.status === 'pending' && value.completedRound === null) return pending(value.reason, value.shoe)
  const screenRound = table.round == null ? NaN : Number(table.round)
  const completed = table.roundBasis === 'completed' ? screenRound : screenRound - 1
  if (!Number.isSafeInteger(completed) || completed < 0 || value.completedRound !== completed) {
    const asOf = Number.isSafeInteger(completed) && value.completedRound !== null && value.completedRound <= completed ? value.completedRound : null
    return pending('coverage-mismatch', value.shoe, asOf)
  }
  return {schemaVersion:1, tableId:table.tableId, shoe:value.shoe, completedRound:value.completedRound, status:value.status, reason:value.reason}
}

export function withTrendBundle(table) {
  return {...table, trendBundle:normalizeTrendBundle(table)}
}
