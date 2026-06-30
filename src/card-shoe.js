const FACE_BY_RANK = new Map([
  [1, 'A'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [7, '7'], [8, '8'], [9, '9'], [10, '10'], [11, 'J'], [12, 'Q'], [13, 'K'],
])
const RANK_FACES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const POINT_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

export function parseBaccaratCard(code) {
  const numeric = Number(code)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  const rank = ((numeric - 1) % 13) + 1
  const face = FACE_BY_RANK.get(rank)
  const baccaratPoint = rank >= 1 && rank <= 9 ? rank : 0
  return { code: numeric, rank, face, baccaratPoint }
}

export function buildRoundCardSnapshot(round = {}) {
  const raw = Array.isArray(round.rawResult) ? round.rawResult : []
  const playerCards = [raw[0], raw[2], raw[4]].map(parseBaccaratCard)
  const bankerCards = [raw[1], raw[3], raw[5]].map(parseBaccaratCard)
  const playerPoint = numberOrNull(round.playerPoint ?? raw[8])
  const bankerPoint = numberOrNull(round.bankerPoint ?? raw[9])
  const playerFirstTwo = moduloPoint(playerCards[0]?.baccaratPoint, playerCards[1]?.baccaratPoint)
  const bankerFirstTwo = moduloPoint(bankerCards[0]?.baccaratPoint, bankerCards[1]?.baccaratPoint)
  const winner = normalizeWinner(round.winner, playerPoint, bankerPoint)
  return {
    playerCards,
    bankerCards,
    playerCardCodes: playerCards.map((card) => card?.code ?? 0),
    bankerCardCodes: bankerCards.map((card) => card?.code ?? 0),
    playerCardRanks: playerCards.map((card) => card?.rank ?? null),
    bankerCardRanks: bankerCards.map((card) => card?.rank ?? null),
    playerCardFaces: playerCards.map((card) => card?.face ?? null),
    bankerCardFaces: bankerCards.map((card) => card?.face ?? null),
    playerCardPoints: playerCards.map((card) => card?.baccaratPoint ?? null),
    bankerCardPoints: bankerCards.map((card) => card?.baccaratPoint ?? null),
    playerPoint,
    bankerPoint,
    pointDiff: playerPoint == null || bankerPoint == null ? null : Math.abs(playerPoint - bankerPoint),
    winner,
    playerDrew: Boolean(playerCards[2]),
    bankerDrew: Boolean(bankerCards[2]),
    playerNatural: playerFirstTwo === 8 || playerFirstTwo === 9,
    bankerNatural: bankerFirstTwo === 8 || bankerFirstTwo === 9,
    playerPair: sameRank(playerCards[0], playerCards[1]),
    bankerPair: sameRank(bankerCards[0], bankerCards[1]),
    superSix: winner === 'banker' && bankerPoint === 6,
    bankerDragon: winner === 'banker' && playerPoint != null && bankerPoint != null && Math.abs(bankerPoint - playerPoint) >= 4,
    playerDragon: winner === 'player' && playerPoint != null && bankerPoint != null && Math.abs(playerPoint - bankerPoint) >= 4,
  }
}

export function createShoeTracker({ deckCount = 8 } = {}) {
  const shoes = new Map()
  const seenRoundKeys = new Set()

  function getShoe(tableId, shoe) {
    const key = `${tableId || 'unknown'}:${shoe ?? 'unknown'}`
    if (!shoes.has(key)) shoes.set(key, createInitialShoeState({ tableId, shoe, deckCount }))
    return shoes.get(key)
  }

  return {
    recordRound(round = {}) {
      const tableId = String(round.tableId ?? '')
      const shoe = round.shoe ?? null
      const roundKey = `${tableId}:${shoe ?? ''}:${round.round ?? ''}:${JSON.stringify(round.rawResult ?? [])}`
      const state = getShoe(tableId, shoe)
      if (seenRoundKeys.has(roundKey)) return snapshotShoeState(state, buildRoundCardSnapshot(round))
      seenRoundKeys.add(roundKey)
      const snapshot = buildRoundCardSnapshot(round)
      for (const card of [...snapshot.playerCards, ...snapshot.bankerCards]) {
        if (!card) continue
        const face = card.face
        state.seenRankCounts[face] += 1
        state.remainingRankCounts[face] = Math.max(0, state.remainingRankCounts[face] - 1)
        state.cardsSeenTotal += 1
      }
      state.cardsRemainingTotal = Math.max(0, state.initialCardsTotal - state.cardsSeenTotal)
      state.lastRound = snapshot
      return snapshotShoeState(state, snapshot)
    },
    getState(tableId, shoe) {
      const state = shoes.get(`${tableId || 'unknown'}:${shoe ?? 'unknown'}`)
      return state ? snapshotShoeState(state, state.lastRound ?? null) : null
    },
  }
}

export function scoreCardShoeInfluence({ lastRound = {}, shoeState = null } = {}) {
  const cardSnapshot = lastRound.playerCards ? lastRound : buildRoundCardSnapshot(lastRound)
  const remainingPointCounts = shoeState?.remainingPointCounts ?? buildPointCountsFromRankCounts(shoeState?.remainingRankCounts ?? createInitialRankCounts(8))
  const totalRemaining = Math.max(1, Object.values(remainingPointCounts).reduce((sum, value) => sum + Number(value ?? 0), 0))
  const zeroRate = remainingPointCounts['0'] / totalRemaining
  const sixRate = remainingPointCounts['6'] / totalRemaining
  const highRate = ((remainingPointCounts['8'] ?? 0) + (remainingPointCounts['9'] ?? 0)) / totalRemaining
  const lowRate = ((remainingPointCounts['1'] ?? 0) + (remainingPointCounts['2'] ?? 0) + (remainingPointCounts['3'] ?? 0)) / totalRemaining
  const bankerPoint = Number(cardSnapshot.bankerPoint ?? 0)
  const playerPoint = Number(cardSnapshot.playerPoint ?? 0)
  const diff = Math.abs(bankerPoint - playerPoint)
  const bankerMomentum = bankerPoint > playerPoint ? 1 + diff / 10 : 0
  const playerMomentum = playerPoint > bankerPoint ? 1 + diff / 10 : 0
  return {
    main: {
      banker: bankerMomentum + zeroRate * 0.8 + sixRate * 0.7,
      player: playerMomentum + highRate * 0.6 + lowRate * 0.2,
    },
    side: {
      tie: clamp(6 + (1 - Math.min(diff, 9) / 9) * 8 + zeroRate * 8, 0, 80),
      superSix: clamp(4 + sixRate * 60 + zeroRate * 8 + (bankerPoint === 6 ? 4 : 0), 0, 80),
      bankerPair: estimatePairProbability(shoeState?.remainingRankCounts ?? null),
      playerPair: estimatePairProbability(shoeState?.remainingRankCounts ?? null),
      bankerDragon: clamp(6 + highRate * 30 + zeroRate * 10 + (bankerPoint > playerPoint && diff >= 4 ? 8 : 0), 0, 80),
      playerDragon: clamp(6 + highRate * 30 + zeroRate * 10 + (playerPoint > bankerPoint && diff >= 4 ? 8 : 0), 0, 80),
    },
    features: {
      playerCardFaces: cardSnapshot.playerCardFaces,
      bankerCardFaces: cardSnapshot.bankerCardFaces,
      playerCardPoints: cardSnapshot.playerCardPoints,
      bankerCardPoints: cardSnapshot.bankerCardPoints,
      playerPoint: cardSnapshot.playerPoint,
      bankerPoint: cardSnapshot.bankerPoint,
      pointDiff: cardSnapshot.pointDiff,
      playerNatural: cardSnapshot.playerNatural,
      bankerNatural: cardSnapshot.bankerNatural,
      playerDrew: cardSnapshot.playerDrew,
      bankerDrew: cardSnapshot.bankerDrew,
      remainingRankCounts: shoeState?.remainingRankCounts ?? null,
      remainingPointCounts,
      zeroPointRate: roundPercent(zeroRate),
      sixPointRate: roundPercent(sixRate),
      highPointRate: roundPercent(highRate),
      lowPointRate: roundPercent(lowRate),
      cardsSeenTotal: shoeState?.cardsSeenTotal ?? null,
      cardsRemainingTotal: shoeState?.cardsRemainingTotal ?? null,
      shoeProgressRatio: shoeState?.shoeProgressRatio ?? null,
    },
  }
}

export function buildPointCountsFromRankCounts(rankCounts = {}) {
  const points = Object.fromEntries(POINT_KEYS.map((key) => [key, 0]))
  for (const face of RANK_FACES) {
    const point = face === 'A' ? '1' : ['10', 'J', 'Q', 'K'].includes(face) ? '0' : face
    points[point] += Number(rankCounts[face] ?? 0)
  }
  return points
}

function createInitialShoeState({ tableId, shoe, deckCount }) {
  const remainingRankCounts = createInitialRankCounts(deckCount)
  const initialCardsTotal = deckCount * 52
  return {
    tableId,
    shoe,
    deckCount,
    initialRankCounts: { ...remainingRankCounts },
    seenRankCounts: Object.fromEntries(RANK_FACES.map((face) => [face, 0])),
    remainingRankCounts,
    cardsSeenTotal: 0,
    cardsRemainingTotal: initialCardsTotal,
    initialCardsTotal,
    lastRound: null,
  }
}

function createInitialRankCounts(deckCount) {
  return Object.fromEntries(RANK_FACES.map((face) => [face, deckCount * 4]))
}

function snapshotShoeState(state, roundSnapshot) {
  const remainingPointCounts = buildPointCountsFromRankCounts(state.remainingRankCounts)
  return {
    tableId: state.tableId,
    shoe: state.shoe,
    deckCount: state.deckCount,
    initialRankCounts: { ...state.initialRankCounts },
    seenRankCounts: { ...state.seenRankCounts },
    remainingRankCounts: { ...state.remainingRankCounts },
    remainingPointCounts,
    cardsSeenTotal: state.cardsSeenTotal,
    cardsRemainingTotal: state.cardsRemainingTotal,
    initialCardsTotal: state.initialCardsTotal,
    shoeProgressRatio: Number((state.cardsSeenTotal / Math.max(1, state.initialCardsTotal)).toFixed(4)),
    lastRound: roundSnapshot,
  }
}

function estimatePairProbability(rankCounts) {
  if (!rankCounts) return 0
  const total = Object.values(rankCounts).reduce((sum, value) => sum + Number(value ?? 0), 0)
  if (total < 2) return 0
  const pairWays = Object.values(rankCounts).reduce((sum, count) => sum + Number(count ?? 0) * Math.max(0, Number(count ?? 0) - 1), 0)
  return clamp((pairWays / (total * (total - 1))) * 100, 0, 80)
}

function sameRank(a, b) {
  return Boolean(a && b && a.rank === b.rank)
}

function moduloPoint(a, b) {
  if (a == null || b == null) return null
  return (Number(a) + Number(b)) % 10
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeWinner(winner, playerPoint, bankerPoint) {
  if (winner === 1 || winner === '1' || winner === 'player') return 'player'
  if (winner === 2 || winner === '2' || winner === 'banker') return 'banker'
  if (winner === 3 || winner === '3' || winner === 'tie') return 'tie'
  if (playerPoint != null && bankerPoint != null) {
    if (playerPoint > bankerPoint) return 'player'
    if (bankerPoint > playerPoint) return 'banker'
  }
  return 'tie'
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

function roundPercent(rate) {
  return Number((rate * 100).toFixed(2))
}
