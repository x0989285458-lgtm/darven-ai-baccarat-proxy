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
  tie: 85,
  superSix: 90,
  bankerPair: 80,
  playerPair: 80,
  bankerDragon: 101,
  playerDragon: 101,
} as const

function buildEqualWeights<const T extends readonly string[]>(keys: T) {
  const weight = Number((1 / keys.length).toFixed(12))
  const weights = Object.fromEntries(keys.map((key) => [key, weight])) as Record<T[number], number>
  const drift = 1 - (Object.values(weights) as number[]).reduce((sum, value) => sum + value, 0)
  const lastKey = keys[keys.length - 1] as T[number]
  weights[lastKey] = Number((weights[lastKey] + drift).toFixed(12))
  return Object.freeze(weights)
}

function buildWeightedProfile<const T extends readonly string[]>(keys: T, profile: Partial<Record<T[number], number>>) {
  const typedKeys = keys as readonly T[number][]
  const weights = Object.fromEntries(typedKeys.map((key) => [key, Number((profile[key] ?? 0).toFixed(12))])) as Record<T[number], number>
  const drift = 1 - (Object.values(weights) as number[]).reduce((sum, value) => sum + value, 0)
  const anchor = typedKeys.find((key) => weights[key] > 0) ?? typedKeys[typedKeys.length - 1]
  weights[anchor] = Number((weights[anchor] + drift).toFixed(12))
  return Object.freeze(weights)
}

export const ALL_MT_EQUAL_MAIN_WEIGHT_KEYS = [
  'table_id', 'display_name', 'table_type', 'room_id', 'dealer_name', 'total_players', 'state', 'order_state', 'source_updated_at',
  'shoe', 'round', 'shoe_stage', 'banker_count', 'player_count', 'tie_count', 'banker_pair_count', 'player_pair_count',
  'bead_road', 'big_road', 'big_eye_road', 'small_road', 'cockroach_road', 'next_banker_road', 'next_player_road',
  'previous_winner', 'streak_length', 'near5_banker_player_bias', 'table_recent_hit_rate', 'direction_calibration',
  'confidence', 'probability_gap', 'card_points', 'shoe_remaining_points', 'pattern_tags', 'historical_backtest', 'super_six',
] as const

export const ALL_MT_EQUAL_SIDE_WEIGHT_KEYS = [
  'tie_count', 'banker_pair_count', 'player_pair_count', 'bead_road', 'big_road', 'big_eye_road', 'small_road', 'cockroach_road',
  'next_banker_road', 'next_player_road', 'dealer_name', 'total_players', 'shoe', 'round', 'shoe_stage', 'state', 'order_state',
  'raw_result', 'player_point', 'banker_point', 'point_diff', 'banker_natural', 'player_natural', 'banker_dragon', 'player_dragon', 'super_six',
  'tie_risk', 'pair_risk', 'ask_road_conflict', 'road_chaos', 'table_side_history',
] as const

export const ALL_MT_EQUAL_MAIN_WEIGHTS = buildWeightedProfile(ALL_MT_EQUAL_MAIN_WEIGHT_KEYS, {
  big_road: 0.15, big_eye_road: 0.13, next_player_road: 0.12, shoe_stage: 0.08,
  confidence: 0.08, probability_gap: 0.08, banker_count: 0.06, player_count: 0.06, bead_road: 0.06,
  cockroach_road: 0.04, banker_pair_count: 0.03, player_pair_count: 0.03, round: 0.02, near5_banker_player_bias: 0.02,
  streak_length: 0.01, previous_winner: 0.01, small_road: 0.01, next_banker_road: 0.005, super_six: 0.005,
})
export const SIDE_PREDICTION_ACTION_RATE_TARGETS = Object.freeze({
  tie: 0.15,
  superSix: 0.10,
  bankerPair: 0.20,
  playerPair: 0.20,
  bankerDragon: 0,
  playerDragon: 0,
})
export const SIDE_PREDICTION_TARGET_HIT_RATE = 0.5
export const SIDE_PREDICTION_WEIGHT_PROFILES = Object.freeze({
  tie: buildWeightedProfile(ALL_MT_EQUAL_SIDE_WEIGHT_KEYS, { tie_risk: 0.28, tie_count: 0.24, road_chaos: 0.12, bead_road: 0.08, big_road: 0.06, shoe_stage: 0.05, table_side_history: 0.05, round: 0.04, point_diff: 0.03, raw_result: 0.02, ask_road_conflict: 0.02, total_players: 0.01 }),
  superSix: buildWeightedProfile(ALL_MT_EQUAL_SIDE_WEIGHT_KEYS, { super_six: 0.30, banker_point: 0.16, point_diff: 0.13, banker_dragon: 0.10, banker_natural: 0.07, banker_pair_count: 0.05, bead_road: 0.05, big_road: 0.04, big_eye_road: 0.03, shoe_stage: 0.03, round: 0.02, table_side_history: 0.02 }),
  bankerPair: buildWeightedProfile(ALL_MT_EQUAL_SIDE_WEIGHT_KEYS, { banker_pair_count: 0.26, pair_risk: 0.22, banker_point: 0.09, bead_road: 0.08, big_road: 0.06, big_eye_road: 0.05, table_side_history: 0.05, raw_result: 0.04, round: 0.04, shoe_stage: 0.03, dealer_name: 0.02, total_players: 0.02, banker_natural: 0.02, point_diff: 0.02 }),
  playerPair: buildWeightedProfile(ALL_MT_EQUAL_SIDE_WEIGHT_KEYS, { player_pair_count: 0.26, pair_risk: 0.22, player_point: 0.09, bead_road: 0.08, big_road: 0.06, big_eye_road: 0.05, table_side_history: 0.05, raw_result: 0.04, round: 0.04, shoe_stage: 0.03, dealer_name: 0.02, total_players: 0.02, player_natural: 0.02, point_diff: 0.02 }),
  bankerDragon: buildWeightedProfile(ALL_MT_EQUAL_SIDE_WEIGHT_KEYS, { banker_dragon: 0.30, point_diff: 0.18, banker_point: 0.13, banker_natural: 0.08, big_road: 0.06, big_eye_road: 0.05, bead_road: 0.05, next_banker_road: 0.04, shoe_stage: 0.03, round: 0.03, table_side_history: 0.03, road_chaos: 0.02 }),
  playerDragon: buildWeightedProfile(ALL_MT_EQUAL_SIDE_WEIGHT_KEYS, { player_dragon: 0.30, point_diff: 0.18, player_point: 0.13, player_natural: 0.08, big_road: 0.06, big_eye_road: 0.05, bead_road: 0.05, next_player_road: 0.04, shoe_stage: 0.03, round: 0.03, table_side_history: 0.03, road_chaos: 0.02 }),
})
export const ALL_MT_EQUAL_SIDE_WEIGHTS = SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair
export const MAIN_PREDICTION_WEIGHTS = ALL_MT_EQUAL_MAIN_WEIGHTS
export const SIDE_PREDICTION_WEIGHTS = ALL_MT_EQUAL_SIDE_WEIGHTS

export type MainPredictionWeights = typeof ALL_MT_EQUAL_MAIN_WEIGHTS
export type SidePredictionKey = keyof typeof SIDE_PREDICTION_THRESHOLDS
export type SideActuals = Record<SidePredictionKey, boolean> & { mainPrediction?: MainOutcome }
export type SideActions = Record<SidePredictionKey, boolean>

export function isSidePredictionActionable(key: SidePredictionKey, probability: number) {
  if (key === 'bankerDragon' || key === 'playerDragon') return false
  return Math.round(probability) >= SIDE_PREDICTION_THRESHOLDS[key]
}

export function getSidePredictionActions(predictions: BonusPredictions, mainPrediction?: MainOutcome): SideActions {
  const keys = Object.keys(SIDE_PREDICTION_THRESHOLDS) as SidePredictionKey[]
  const actions = Object.fromEntries(keys.map((key) => [key, isSidePredictionActionable(key, predictions[key])])) as SideActions
  const bankerDragon = Math.round(predictions.bankerDragon ?? 0)
  const playerDragon = Math.round(predictions.playerDragon ?? 0)
  const dragonDiff = Math.abs(bankerDragon - playerDragon)
  actions.superSix = actions.superSix && mainPrediction === 'Banker'
  actions.bankerDragon = mainPrediction === 'Banker' && bankerDragon >= SIDE_PREDICTION_THRESHOLDS.bankerDragon && dragonDiff >= 6
  actions.playerDragon = mainPrediction === 'Player' && playerDragon >= SIDE_PREDICTION_THRESHOLDS.playerDragon && dragonDiff >= 6
  return actions
}

export function createSidePredictionLearningRecord(predictions: BonusPredictions, actuals: SideActuals) {
  const keys = Object.keys(SIDE_PREDICTION_THRESHOLDS) as SidePredictionKey[]
  const actions = getSidePredictionActions(predictions, actuals.mainPrediction)
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
  const featureScores = buildSideFeatureScores(cells, stats, sampleSize)
  return Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, profile]) => [
    key,
    clamp(Object.entries(profile).reduce((sum, [featureKey, weight]) => sum + (Number(featureScores[featureKey as keyof typeof featureScores] ?? 0) * Number(weight ?? 0)), 0)),
  ])) as BonusPredictions
}

function buildSideFeatureScores(cells: RoadCell[], stats?: BonusPredictionStats, sampleSize = 24) {
  const recent = cells.slice(-sampleSize)
  const recentBanker = recent.filter((cell) => cell.outcome === 'Banker').length
  const recentPlayer = recent.filter((cell) => cell.outcome === 'Player').length
  const recentTie = recent.filter((cell) => cell.outcome === 'Tie').length
  const recentBankerPair = recent.filter((cell) => cell.code[0] === '1' || cell.code[0] === '3').length
  const recentPlayerPair = recent.filter((cell) => cell.code[0] === '2' || cell.code[0] === '3').length
  const banker = toNumber(stats?.total_round_banker) || recentBanker
  const player = toNumber(stats?.total_round_player) || recentPlayer
  const tie = toNumber(stats?.total_round_tie) || recentTie
  const total = banker + player + tie || recent.length || 1
  const bankerPair = toNumber(stats?.total_round_banker_pair) || recentBankerPair
  const playerPair = toNumber(stats?.total_round_player_pair) || recentPlayerPair
  const bankerRate = percentage(banker, total)
  const playerRate = percentage(player, total)
  const tieRate = percentage(tie, total)
  const bankerPairRate = percentage(bankerPair, total)
  const playerPairRate = percentage(playerPair, total)
  const pointDiff = clamp(Math.abs(bankerRate - playerRate) * 2)
  const roadChaos = clamp(100 - Math.abs(bankerRate - playerRate) - Math.abs(tieRate * 0.5))
  const bankerDragon = clamp((bankerRate * 0.7) + (pointDiff * 0.3))
  const playerDragon = clamp((playerRate * 0.7) + (pointDiff * 0.3))
  return {
    tie_count: tieRate,
    banker_pair_count: bankerPairRate,
    player_pair_count: playerPairRate,
    bead_road: clamp(Math.max(bankerRate, playerRate)),
    big_road: clamp(Math.max(bankerRate, playerRate)),
    big_eye_road: clamp(Math.max(bankerRate, playerRate) * 0.9),
    small_road: clamp(Math.max(bankerRate, playerRate) * 0.8),
    cockroach_road: clamp(Math.max(bankerRate, playerRate) * 0.8),
    next_banker_road: askRoadScore(stats?.next_banker2) ? 58 : 50,
    next_player_road: askRoadScore(stats?.next_player2) ? 58 : 50,
    dealer_name: 0,
    total_players: 0,
    shoe: 0,
    round: 0,
    shoe_stage: 50,
    state: 50,
    order_state: 50,
    raw_result: recent.length ? 60 : 0,
    player_point: playerRate,
    banker_point: bankerRate,
    point_diff: pointDiff,
    banker_natural: bankerRate > playerRate ? 55 : 35,
    player_natural: playerRate > bankerRate ? 55 : 35,
    banker_dragon: bankerDragon,
    player_dragon: playerDragon,
    super_six: clamp(bankerRate * 0.5),
    tie_risk: clamp((tieRate * 1.6) + (roadChaos * 0.25)),
    pair_risk: clamp(Math.max(bankerPairRate, playerPairRate) * 2.4),
    ask_road_conflict: 50,
    road_chaos: roadChaos,
    table_side_history: clamp(Math.max(tieRate, bankerPairRate, playerPairRate, bankerDragon, playerDragon)),
  }
}

export type Prediction = {
  recommendation: MainOutcome
  confidence: number
  risk: 'Low' | 'Medium' | 'High'
  reason: string
  weights?: MainPredictionWeights
  sourceScores?: Record<string, DirectionScore>
  scoreTotals?: DirectionScore
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

function addScores(...scores: DirectionScore[]): DirectionScore {
  return scores.reduce((acc, score) => ({
    banker: acc.banker + Number(score.banker ?? 0),
    player: acc.player + Number(score.player ?? 0),
  }), { banker: 0, player: 0 })
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

export type TableContextInput = {
  table_id?: string | number | null
  display_name?: string | null
  table_type?: string | null
  room_id?: string | number | null
  dealer_name?: string | null
  total_players?: number | string | null
  state?: string | number | null
  order_state?: string | number | null
  source_updated_at?: string | null
  shoe?: number | string | null
  round?: number | string | null
  table_recent_hit_rate?: number | string | null
}

export type RoadRawInput = {
  bead_road?: string
  big_road?: string
  big_eye_road?: string
  small_road?: string
  cockroach_road?: string
}

export type FiveRoadPredictionInput = {
  beadCells?: RoadCell[]
  bigRoadCells?: BigRoadCell[]
  askRoad?: Pick<BonusPredictionStats, 'next_banker2' | 'next_player2'>
  tableStats?: PredictionStats
  globalStats?: PredictionStats
  tableContext?: TableContextInput
  roadRaw?: RoadRawInput
  weights?: Partial<MainPredictionWeights>
}

function neutralScore(): DirectionScore { return { banker: 0.5, player: 0.5 } }
function winnerScore(winner: MainOutcome | null): DirectionScore {
  if (winner === 'Banker') return { banker: 0.55, player: 0.45 }
  if (winner === 'Player') return { banker: 0.45, player: 0.55 }
  return neutralScore()
}
function invertWinnerScore(winner: MainOutcome | null): DirectionScore {
  if (winner === 'Banker') return { banker: 0.45, player: 0.55 }
  if (winner === 'Player') return { banker: 0.55, player: 0.45 }
  return neutralScore()
}
function ratioScore(bankerRaw: unknown, playerRaw: unknown): DirectionScore {
  const banker = Math.max(0, Number(bankerRaw ?? 0))
  const player = Math.max(0, Number(playerRaw ?? 0))
  const total = banker + player
  if (!total) return neutralScore()
  return { banker: banker / total, player: player / total }
}
function roadStringScore(raw = ''): DirectionScore {
  const text = String(raw)
  const banker = (text.match(/2/g) ?? []).length + (text.match(/B/gi) ?? []).length
  const player = (text.match(/1/g) ?? []).length + (text.match(/P/gi) ?? []).length
  return ratioScore(banker, player)
}
function roadColorScore(raw = ''): DirectionScore {
  const text = String(raw)
  const red = (text.match(/1/g) ?? []).length
  const blue = (text.match(/2/g) ?? []).length
  return ratioScore(red, blue)
}
function askRoadScoreBySide(raw: unknown, side: MainOutcome): DirectionScore {
  if (!raw) return neutralScore()
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const filled = text.replace(/[,#\s]/g, '').length
  const bump = Math.min(0.08, filled / 2000)
  return side === 'Banker' ? { banker: 0.5 + bump, player: 0.5 - bump } : { banker: 0.5 - bump, player: 0.5 + bump }
}
function inferPreviousWinnerFromCells(cells: RoadCell[]): MainOutcome | null {
  const decisive = cells.map((cell) => normalizeMainOutcome(cell.outcome)).filter(Boolean) as MainOutcome[]
  return decisive.at(-1) ?? null
}
function inferCurrentStreakLength(cells: RoadCell[]) {
  const decisive = cells.map((cell) => normalizeMainOutcome(cell.outcome)).filter(Boolean) as MainOutcome[]
  const last = decisive.at(-1)
  if (!last) return 0
  let count = 0
  for (let index = decisive.length - 1; index >= 0 && decisive[index] === last; index -= 1) count += 1
  return count
}
function inferNear5Bias(cells: RoadCell[]) {
  return cells.map((cell) => normalizeMainOutcome(cell.outcome)).filter(Boolean).slice(-5).reduce((sum, side) => sum + (side === 'Banker' ? 1 : -1), 0)
}
function shoeStage(round: unknown) {
  const roundNo = toNumber(round as number | string | undefined)
  return roundNo <= 10 ? 'early' : roundNo <= 40 ? 'middle' : 'late'
}
function scoreAllMtFeature(key: keyof MainPredictionWeights, ctx: {
  input: FiveRoadPredictionInput
  roadRaw: Required<RoadRawInput>
  tableContext: TableContextInput
  previousWinner: MainOutcome | null
  streakLength: number
  near5Bias: number
  baseProbabilities: DirectionScore
}): DirectionScore {
  const { input, roadRaw, tableContext, previousWinner, streakLength, near5Bias, baseProbabilities } = ctx
  const tableStats = input.tableStats ?? {}
  switch (key) {
    case 'banker_count': return ratioScore(tableStats.banker ?? tableStats.total_round_banker, tableStats.player ?? tableStats.total_round_player)
    case 'player_count': return ratioScore(tableStats.banker ?? tableStats.total_round_banker, tableStats.player ?? tableStats.total_round_player)
    case 'tie_count': return neutralScore()
    case 'banker_pair_count': return ratioScore(tableStats.total_round_banker_pair, tableStats.total_round_player_pair)
    case 'player_pair_count': return ratioScore(tableStats.total_round_banker_pair, tableStats.total_round_player_pair)
    case 'bead_road': return roadStringScore(roadRaw.bead_road)
    case 'big_road': return roadStringScore(roadRaw.big_road)
    case 'big_eye_road': return roadColorScore(roadRaw.big_eye_road)
    case 'small_road': return roadColorScore(roadRaw.small_road)
    case 'cockroach_road': return roadColorScore(roadRaw.cockroach_road)
    case 'next_banker_road': return askRoadScoreBySide(input.askRoad?.next_banker2, 'Banker')
    case 'next_player_road': return askRoadScoreBySide(input.askRoad?.next_player2, 'Player')
    case 'previous_winner': return winnerScore(previousWinner)
    case 'streak_length': return streakLength >= 5 ? invertWinnerScore(previousWinner) : winnerScore(previousWinner)
    case 'near5_banker_player_bias': return near5Bias > 0 ? { banker: 0.55, player: 0.45 } : near5Bias < 0 ? { banker: 0.45, player: 0.55 } : neutralScore()
    case 'table_recent_hit_rate': return tableContext.table_recent_hit_rate == null ? neutralScore() : (Number(tableContext.table_recent_hit_rate) >= 0.5 ? winnerScore(baseProbabilities.banker >= baseProbabilities.player ? 'Banker' : 'Player') : invertWinnerScore(baseProbabilities.banker >= baseProbabilities.player ? 'Banker' : 'Player'))
    case 'direction_calibration': return neutralScore()
    case 'confidence': return baseProbabilities
    case 'probability_gap': return baseProbabilities
    case 'super_six': {
      const banker = toNumber(tableStats.banker ?? tableStats.total_round_banker)
      const player = toNumber(tableStats.player ?? tableStats.total_round_player)
      const tie = toNumber(tableStats.tie ?? tableStats.total_round_tie)
      const total = banker + player + tie
      return total && percentage(banker, total) * 0.5 >= SIDE_PREDICTION_THRESHOLDS.superSix ? { banker: 0.56, player: 0.44 } : neutralScore()
    }
    case 'round': return tableContext.round == null ? neutralScore() : toNumber(tableContext.round as number | string | undefined) % 2 === 0 ? { banker: 0.51, player: 0.49 } : { banker: 0.49, player: 0.51 }
    case 'shoe_stage': return shoeStage(tableContext.round) === 'late' ? { banker: 0.52, player: 0.48 } : neutralScore()
    default: return neutralScore()
  }
}

export function evaluateFiveRoadPrediction(input: FiveRoadPredictionInput): Prediction & { weights: MainPredictionWeights; sourceScores: Record<string, DirectionScore>; patterns: RoadTrends } {
  const weights = { ...MAIN_PREDICTION_WEIGHTS, ...(input.weights ?? {}) } as MainPredictionWeights
  const beadCells = input.beadCells ?? []
  const beadOutcomes = beadCells.map((cell) => cell.outcome)
  const bigRoadOutcomes = (input.bigRoadCells ?? []).map((cell) => cell.outcome)
  const shoeOutcomes = bigRoadOutcomes.length ? bigRoadOutcomes : beadOutcomes
  const auxiliaryRoads = addScores(
    derivedRoadScore(input.bigRoadCells ?? [], 1),
    derivedRoadScore(input.bigRoadCells ?? [], 2),
    derivedRoadScore(input.bigRoadCells ?? [], 3),
  )
  const baseProbabilities = ratioScore(input.tableStats?.banker ?? input.tableStats?.total_round_banker, input.tableStats?.player ?? input.tableStats?.total_round_player)
  const roadRaw: Required<RoadRawInput> = {
    bead_road: input.roadRaw?.bead_road ?? beadCells.map((cell) => cell.code).join(','),
    big_road: input.roadRaw?.big_road ?? (input.bigRoadCells ?? []).map((cell) => cell.code).join(','),
    big_eye_road: input.roadRaw?.big_eye_road ?? '',
    small_road: input.roadRaw?.small_road ?? '',
    cockroach_road: input.roadRaw?.cockroach_road ?? '',
  }
  const tableContext = input.tableContext ?? {}
  const previousWinner = inferPreviousWinnerFromCells(beadCells)
  const streakLength = inferCurrentStreakLength(beadCells)
  const near5Bias = inferNear5Bias(beadCells)
  const sourceScores: Record<string, DirectionScore> = {
    // Legacy grouped scores are kept for existing diagnostics/UI compatibility.
    shoeRoad: directionalScoreFromOutcomes(shoeOutcomes),
    askRoad: askRoadDirectionScore(input.askRoad),
    recentTrend: directionalScoreFromOutcomes(shoeOutcomes, 8),
    bankerPlayerStats: addScores(statsScore(input.tableStats), statsScore(input.globalStats)),
    auxiliaryRoads,
    beadRoad: directionalScoreFromOutcomes(beadOutcomes),
  }
  for (const key of ALL_MT_EQUAL_MAIN_WEIGHT_KEYS) {
    sourceScores[key] = scoreAllMtFeature(key, { input, roadRaw, tableContext, previousWinner, streakLength, near5Bias, baseProbabilities })
  }
  const totals = Object.entries(weights).reduce((acc, [key, weight]) => {
    const score = sourceScores[key] ?? neutralScore()
    acc.banker += score.banker * weight
    acc.player += score.player * weight
    return acc
  }, { banker: 0, player: 0 })
  const difference = Math.abs(totals.banker - totals.player)
  const recommendation: MainOutcome = difference < 1e-9
    ? breakMainPredictionTie({ outcomes: shoeOutcomes, stats: input.tableStats })
    : totals.banker > totals.player ? 'Banker' : 'Player'
  const confidence = clamp(50 + difference * 100, 30, 80)
  const risk: Prediction['risk'] = difference <= 0.007 ? 'High' : difference <= 0.02 ? 'Medium' : 'Low'
  const patterns = detectRoadTrends(bigRoadOutcomes.length ? bigRoadOutcomes : beadOutcomes)
  return {
    recommendation,
    confidence,
    risk,
    reason: `v050全MT平均權重以桌台、靴局、五路、問路、牌點、型態與歷史特徵合成，輸出 ${recommendation === 'Banker' ? '莊' : '閒'}。`,
    weights,
    sourceScores,
    scoreTotals: totals,
    patterns,
  }
}

function breakMainPredictionTie({ outcomes = [], stats }: { outcomes?: Outcome[]; stats?: PredictionStats }): MainOutcome {
  const decisive = outcomes.map(normalizeMainOutcome).filter(Boolean) as MainOutcome[]
  const last = decisive.at(-1)
  if (last === 'Banker') return 'Player'
  if (last === 'Player') return 'Banker'
  const banker = toNumber(stats?.banker ?? stats?.total_round_banker)
  const player = toNumber(stats?.player ?? stats?.total_round_player)
  if (banker !== player) return banker > player ? 'Player' : 'Banker'
  return decisive.length % 2 === 0 ? 'Player' : 'Banker'
}

export function calculatePrediction(input: RoadCell[] | FiveRoadPredictionInput): Prediction {
  if (Array.isArray(input)) {
    const outcomes = input.map((cell) => cell.outcome)
    const totals = directionalScoreFromOutcomes(outcomes)
    const difference = Math.abs(totals.banker - totals.player)
    const recommendation: MainOutcome = difference < 1e-9
      ? breakMainPredictionTie({ outcomes, stats: undefined })
      : totals.banker > totals.player ? 'Banker' : 'Player'
    return {
      recommendation,
      confidence: clamp(30 + (1 - Math.exp(-difference / 8)) * 50, 30, 80),
      risk: difference <= 0.7 ? 'High' : difference <= 2 ? 'Medium' : 'Low',
      reason: `路單走勢輸出 ${recommendation === 'Banker' ? '莊' : '閒'}。`,
      weights: MAIN_PREDICTION_WEIGHTS,
      sourceScores: { beadRoad: totals },
      scoreTotals: totals,
      patterns: detectRoadTrends(outcomes),
    }
  }
  return evaluateFiveRoadPrediction(input)
}

export function calculateMainOutcomeProbabilities(prediction: Pick<Prediction, 'recommendation' | 'confidence' | 'scoreTotals'>, tieProbability = 0): OutcomeProbabilities {
  const tie = clamp(tieProbability, 0, 100)
  const decisiveTotal = Math.max(0, 100 - tie)
  const scoreTotal = Number(prediction.scoreTotals?.banker ?? 0) + Number(prediction.scoreTotals?.player ?? 0)
  if (scoreTotal > 0) {
    const banker = clamp((Number(prediction.scoreTotals?.banker ?? 0) / scoreTotal) * decisiveTotal, 0, decisiveTotal)
    return { banker, player: decisiveTotal - banker, tie }
  }
  const confidence = clamp(Number(prediction.confidence ?? 0), 0, 100)
  const active = clamp(decisiveTotal * (confidence / 100), 0, decisiveTotal)
  const opposite = decisiveTotal - active
  return prediction.recommendation === 'Banker'
    ? { banker: active, player: opposite, tie }
    : { banker: opposite, player: active, tie }
}
