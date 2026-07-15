export function isExactTenRawResult(value) {
  if (!Array.isArray(value) || value.length !== 10) return false
  if (value.some((item) => typeof item !== 'number' || !Number.isInteger(item))) return false
  if (!value.slice(0, 4).every((item) => item >= 1 && item <= 52)) return false
  if (!value.slice(4, 8).every((item) => item >= -1 && item <= 52)) return false
  return value.slice(8, 10).every((item) => item >= 0 && item <= 9)
}

export function hasExactRealCardCodes(round = {}) {
  return isExactTenRawResult(round?.rawResult)
}

export function normalizeExactRealCardEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent) || !hasExactRealCardCodes(rawEvent)) return null
  const rawResult = rawEvent.rawResult.map(Number)
  const playerPoint = rawResult[8]
  const bankerPoint = rawResult[9]
  if (!Number.isInteger(playerPoint) || playerPoint < 0 || playerPoint > 9
    || !Number.isInteger(bankerPoint) || bankerPoint < 0 || bankerPoint > 9) return null
  const result = bankerPoint > playerPoint ? 'banker' : playerPoint > bankerPoint ? 'player' : 'tie'
  if (rawEvent.winner != null && rawEvent.winner !== result) return null
  return { rawResult, result, bankerPoint, playerPoint }
}
