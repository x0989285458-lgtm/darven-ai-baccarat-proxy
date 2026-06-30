export type Outcome = 'Banker' | 'Player' | 'Tie'
export type MainOutcome = 'Banker' | 'Player'
export type RoadCell = { code: string; outcome: Outcome }
export type BigRoadCell = { code: string; outcome: Outcome; column: number; row: number }
export type DirectionScore = { banker: number; player: number }
export type RoadTrends = {
  singleJump: boolean
  doubleJump: boolean
  doubleDragon: boolean
  upSlope: boolean
  downSlope: boolean
  longDragon: { side: MainOutcome | null; length: number }
}

/** Reads only the second bead code digit: pair metadata never changes the game outcome. */
export function normalizeOutcomeFromBead(code: string): Outcome | null {
  const value = code.trim()
  if (value.length < 2) return null
  switch (value[1]) {
    case '1': return 'Player'
    case '2': return 'Banker'
    case '3': return 'Tie'
    default: return null
  }
}

export function parseBeadPlate(raw: string): RoadCell[] {
  if (!raw) return []
  return raw.split('#').flatMap((column) =>
    (column.match(/\d{2}/g) ?? []).flatMap((code) => {
      const outcome = normalizeOutcomeFromBead(code)
      return outcome ? [{ code, outcome }] : []
    }),
  )
}

export function parseBigRoad(raw: string): BigRoadCell[] {
  if (!raw) return []
  return raw.split('#').flatMap((column, columnIndex) =>
    column.split(',').flatMap((item, row) => {
      const code = item.trim()
      const last = code.at(-1)
      const outcome = last === '1' ? 'Player' : last === '2' ? 'Banker' : last === '3' ? 'Tie' : null
      return outcome ? [{ code, outcome, column: columnIndex, row }] : []
    }),
  )
}

export type BonusPredictions = {
  bankerDragon: number
  playerDragon: number
  bankerPair: number
  playerPair: number
  superSix: number
  tie: number
}

export const SIDE_PREDICTION_THRESHOLDS = {
  tie: 14,
  superSix: 8,
  bankerPair: 9,
  playerPair: 9,
  bankerDragon: 10,
  playerDragon: 10,
} as const

export const MAIN_PREDICTION_WEIGHTS = {
  beadRoad: 0.18,
  bigRoad: 0.24,
  bigEyeRoad: 0.14,
  smallRoad: 0.10,
  cockroachRoad: 0.10,
  askRoad: 0.12,
  tableStats: 0.06,
  globalStats: 0.06,
} as const

export type MainPredictionWeights = typeof MAIN_PREDICTION_WEIGHTS
export type SidePredictionKey = keyof typeof SIDE_PREDICTION_THRESHOLDS
export type SideActuals = Record<SidePredictionKey, boolean>
export type SideActions = Record<SidePredictionKey, boolean>

export function isSidePredictionActionable(key: SidePredictionKey, probability: number) {
  return Math.round(probability) >= SIDE_PREDICTION_THRESHOLDS[key]
}

export function createSidePredictionLearningRecord(predictions: BonusPredictions, actuals: SideActuals) {
  const keys = Object.keys(SIDE_PREDICTION_THRESHOLDS) as SidePredictionKey[]
  const actions = Object.fromEntries(keys.map((key) => [key, isSidePredictionActionable(key, predictions[key])])) as SideActions
  const hits = Object.fromEntries(keys.map((key) => [key, actions[key] && actuals[key]])) as SideActions
  return {
    predictions,
    actuals,
    actions,
    hits,
    learnedEvents: keys.length,
    actionCount: keys.filter((key) => actions[key]).length,
    hitCount: keys.filter((key) => hits[key]).length,
  }
}

export type BonusPredictionStats = {
  total_round_banker?: number | string
  total_round_player?: number | string
  total_round_tie?: number | string
  total_round_banker_pair?: number | string
  total_round_player_pair?: number | string
  next_banker2?: unknown
  next_player2?: unknown
}

export type PredictionStats = BonusPredictionStats & {
  banker?: number | string
  player?: number | string
  tie?: number | string
}

function toNumber(value: number | string | undefined) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function percentage(count: number, total: number) {
  if (!total) return 0
  return Math.round((count / total) * 100)
}

function pct1(count: number, total: number) {
  if (!total) return 0
  return Math.round((count / total) * 1000) / 10
}

function clamp(value: number, min = 0, max = 99) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

export type OutcomeProbabilities = { banker: number; player: number; tie: number }
export type AskRoadInfluence = { bankerScore: number; playerScore: number; weight: number }

export function calculateAskRoadInfluence(stats?: Pick<BonusPredictionStats, 'next_banker2' | 'next_player2'>): AskRoadInfluence {
  const bankerScore = askRoadScore(stats?.next_banker2)
  const playerScore = askRoadScore(stats?.next_player2)
  return { bankerScore, playerScore, weight: clamp(Math.abs(bankerScore - playerScore) * 2, 0, 6) }
}

export function applyAskRoadWeighting(base: OutcomeProbabilities, stats?: Pick<BonusPredictionStats, 'next_banker2' | 'next_player2'>): OutcomeProbabilities {
  const influence = calculateAskRoadInfluence(stats)
  if (!influence.weight || influence.bankerScore === influence.playerScore) return base
  const direction = influence.bankerScore > influence.playerScore ? 1 : -1
  const decisiveTotal = Math.max(0, 100 - base.tie)
  const banker = clamp(base.banker + influence.weight * direction, 0, decisiveTotal)
  return { banker, player: decisiveTotal - banker, tie: base.tie }
}

function askRoadScore(raw: unknown) {
  if (raw == null) return 0
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const compact = text.toLowerCase()
  const redWords = (compact.match(/red|紅/g) ?? []).length
  const redDigits = (compact.match(/1/g) ?? []).length
  return redWords + redDigits
}

export function calculateBonusPredictions(cells: RoadCell[], stats?: BonusPredictionStats, sampleSize = 24): BonusPredictions {
  const recent = cells.slice(-sampleSize)
  const recentBanker = recent.filter((cell) => cell.outcome === 'Banker').length
  const recentPlayer = recent.filter((cell) => cell.outcome === 'Player').length
  const recentTie = recent.filter((cell) => cell.outcome === 'Tie').length
  const recentBankerPair = recent.filter((cell) => cell.code[0] === '1' || cell.code[0] === '3').length
  const recentPlayerPair = recent.filter((cell) => cell.code[0] === '2' || cell.code[0] === '3').length

  const banker = toNumber(stats?.total_round_banker) || recentBanker
  const player = toNumber(stats?.total_round_player) || recentPlayer
  const tie = toNumber(stats?.total_round_tie) || recentTie
  const total = banker + player + tie || recent.length
  const bankerPair = toNumber(stats?.total_round_banker_pair) || recentBankerPair
  const playerPair = toNumber(stats?.total_round_player_pair) || recentPlayerPair

  const bankerRate = percentage(banker, total)
  const playerRate = percentage(player, total)

  return {
    bankerDragon: clamp(bankerRate * 0.36),
    playerDragon: clamp(playerRate * 0.36),
    bankerPair: percentage(bankerPair, total),
    playerPair: percentage(playerPair, total),
    superSix: clamp(bankerRate * 0.12),
    tie: percentage(tie, total),
  }
}

export type Prediction = {
  recommendation: MainOutcome
  confidence: number
  risk: 'Low' | 'Medium' | 'High'
  reason: string
  weights?: MainPredictionWeights
  sourceScores?: Record<string, DirectionScore>
  patterns?: RoadTrends
}

export function scoreMainPrediction(prediction: MainOutcome, actual: Outcome) {
  if (actual === 'Tie') return { evaluated: false, hit: false, push: true }
  return { evaluated: true, hit: prediction === actual, push: false }
}

export function detectRoadTrends(outcomes: Array<Outcome | MainOutcome | '莊' | '閒'>): RoadTrends {
  const seq = outcomes.map(normalizeMainOutcome).filter(Boolean) as MainOutcome[]
  const recent = seq.slice(-12)
  const groups = groupRuns(recent)
  const singleJump = recent.length >= 5 && recent.slice(-5).every((value, index, arr) => index === 0 || value !== arr[index - 1])
  const last6 = recent.slice(-6)
  const doubleJump = last6.length >= 6 && last6[0] === last6[1] && last6[2] === last6[3] && last6[4] === last6[5] && last6[0] !== last6[2] && last6[2] !== last6[4]
  const strongestRun = groups.reduce<{ side: MainOutcome | null; length: number }>((best, run) => run.length > best.length ? run : best, { side: null, length: 0 })
  const longDragon = { side: strongestRun.length >= 3 ? strongestRun.side : null, length: strongestRun.length }
  const doubleDragon = groups.length >= 2 && groups.slice(-2).every((run) => run.length >= 3)
  const lengths = groups.map((run) => run.length).slice(-4)
  const upSlope = lengths.length >= 3 && lengths.every((length, index) => index === 0 || length >= lengths[index - 1]) && lengths.at(-1)! > lengths[0]
  const downSlope = lengths.length >= 3 && lengths.every((length, index) => index === 0 || length <= lengths[index - 1]) && lengths.at(-1)! < lengths[0]
  return { singleJump, doubleJump, doubleDragon, upSlope, downSlope, longDragon }
}

function groupRuns(seq: MainOutcome[]) {
  const groups: Array<{ side: MainOutcome; length: number }> = []
  for (const side of seq) {
    const last = groups.at(-1)
    if (last?.side === side) last.length += 1
    else groups.push({ side, length: 1 })
  }
  return groups
}

function normalizeMainOutcome(value: Outcome | MainOutcome | '莊' | '閒'): MainOutcome | null {
  if (value === 'Banker' || value === '莊') return 'Banker'
  if (value === 'Player' || value === '閒') return 'Player'
  return null
}

function directionalScoreFromOutcomes(outcomes: Array<Outcome | MainOutcome>, sampleSize = 12): DirectionScore {
  const recent = outcomes.map(normalizeMainOutcome).filter(Boolean).slice(-sampleSize) as MainOutcome[]
  const banker = recent.filter((outcome) => outcome === 'Banker').length
  const player = recent.length - banker
  const trends = detectRoadTrends(recent)
  const score: DirectionScore = { banker, player }
  const last = recent.at(-1)
  if (trends.longDragon.side === 'Banker') score.banker += Math.min(4, trends.longDragon.length)
  if (trends.longDragon.side === 'Player') score.player += Math.min(4, trends.longDragon.length)
  if ((trends.singleJump || trends.doubleJump) && last) {
    const next = last === 'Banker' ? 'Player' : 'Banker'
    score[next === 'Banker' ? 'banker' : 'player'] += 2
  }
  if (trends.upSlope && last) score[last === 'Banker' ? 'banker' : 'player'] += 2
  if (trends.downSlope && last) score[last === 'Banker' ? 'player' : 'banker'] += 1
  if (trends.doubleDragon && last) score[last === 'Banker' ? 'banker' : 'player'] += 1
  return score
}

function derivedRoadScore(bigRoad: BigRoadCell[], offset: number): DirectionScore {
  const seq = bigRoad.filter((cell) => cell.outcome !== 'Tie').map((cell) => cell.outcome as MainOutcome)
  if (seq.length <= offset + 2) return directionalScoreFromOutcomes(seq)
  const derived = seq.slice(offset).map((value, index) => value === seq[index] ? 'Banker' : 'Player') as MainOutcome[]
  return directionalScoreFromOutcomes(derived, 12)
}

function statsScore(stats?: PredictionStats): DirectionScore {
  const banker = toNumber(stats?.banker ?? stats?.total_round_banker)
  const player = toNumber(stats?.player ?? stats?.total_round_player)
  return { banker, player }
}

function askRoadDirectionScore(ask?: Pick<BonusPredictionStats, 'next_banker2' | 'next_player2'>): DirectionScore {
  const influence = calculateAskRoadInfluence(ask)
  return { banker: influence.bankerScore, player: influence.playerScore }
}

export type FiveRoadPredictionInput = {
  beadCells?: RoadCell[]
  bigRoadCells?: BigRoadCell[]
  askRoad?: Pick<BonusPredictionStats, 'next_banker2' | 'next_player2'>
  tableStats?: PredictionStats
  globalStats?: PredictionStats
  weights?: Partial<MainPredictionWeights>
}

export function evaluateFiveRoadPrediction(input: FiveRoadPredictionInput): Prediction & { weights: MainPredictionWeights; sourceScores: Record<string, DirectionScore>; patterns: RoadTrends } {
  const weights = { ...MAIN_PREDICTION_WEIGHTS, ...(input.weights ?? {}) }
  const beadOutcomes = (input.beadCells ?? []).map((cell) => cell.outcome)
  const bigRoadOutcomes = (input.bigRoadCells ?? []).map((cell) => cell.outcome)
  const sourceScores: Record<string, DirectionScore> = {
    beadRoad: directionalScoreFromOutcomes(beadOutcomes),
    bigRoad: directionalScoreFromOutcomes(bigRoadOutcomes),
    bigEyeRoad: derivedRoadScore(input.bigRoadCells ?? [], 1),
    smallRoad: derivedRoadScore(input.bigRoadCells ?? [], 2),
    cockroachRoad: derivedRoadScore(input.bigRoadCells ?? [], 3),
    askRoad: askRoadDirectionScore(input.askRoad),
    tableStats: statsScore(input.tableStats),
    globalStats: statsScore(input.globalStats),
  }
  const totals = Object.entries(weights).reduce((acc, [key, weight]) => {
    const score = sourceScores[key] ?? { banker: 0, player: 0 }
    acc.banker += score.banker * weight
    acc.player += score.player * weight
    return acc
  }, { banker: 0, player: 0 })
  const recommendation: MainOutcome = totals.banker >= totals.player ? 'Banker' : 'Player'
  const difference = Math.abs(totals.banker - totals.player)
  const confidence = clamp(30 + difference * 18, 30, 80)
  const risk: Prediction['risk'] = difference <= 0.7 ? 'High' : difference <= 2 ? 'Medium' : 'Low'
  const patterns = detectRoadTrends(bigRoadOutcomes.length ? bigRoadOutcomes : beadOutcomes)
  return {
    recommendation,
    confidence,
    risk,
    reason: `五路主預測以珠盤路、大路、大眼仔、小路、蟑螂路與路單走勢權重合成，輸出 ${recommendation === 'Banker' ? '莊' : '閒'}。`,
    weights,
    sourceScores,
    patterns,
  }
}

export function calculatePrediction(input: RoadCell[] | FiveRoadPredictionInput): Prediction {
  if (Array.isArray(input)) {
    return evaluateFiveRoadPrediction({ beadCells: input })
  }
  return evaluateFiveRoadPrediction(input)
}
