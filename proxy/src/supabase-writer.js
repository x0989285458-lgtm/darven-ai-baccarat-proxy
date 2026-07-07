import { buildRoundCardSnapshot, scoreCardShoeInfluence } from './card-shoe.js'

const SOURCE = 'ofalive99'
const DEFAULT_STRATEGY_VERSION = 'v012_equal_weight_seed'
export const SHORT_RUN_STRATEGY_VERSION = 'v049_no_observe_confidence_30_80'
export const ALL_MT_EQUAL_STRATEGY_VERSION = 'v080_高勝率主權重副預測修正版'

function buildEqualWeights(keys) {
  const weight = Number((1 / keys.length).toFixed(12))
  const weights = Object.fromEntries(keys.map((key) => [key, weight]))
  const drift = 1 - Object.values(weights).reduce((sum, value) => sum + value, 0)
  weights[keys[keys.length - 1]] = Number((weights[keys[keys.length - 1]] + drift).toFixed(12))
  return Object.freeze(weights)
}

function buildWeightedProfile(keys, profile) {
  const weights = Object.fromEntries(keys.map((key) => [key, Number((profile[key] ?? 0).toFixed(12))]))
  const drift = 1 - Object.values(weights).reduce((sum, value) => sum + value, 0)
  const anchor = keys.find((key) => weights[key] > 0) ?? keys[keys.length - 1]
  weights[anchor] = Number((weights[anchor] + drift).toFixed(12))
  return Object.freeze(weights)
}

const MAIN_WEIGHT_KEYS = [
  'table_type', 'total_players', 'state', 'source_updated_at',
  'shoe', 'shoe_stage', 'banker_count', 'player_count', 'tie_count',
  'bead_road', 'big_road', 'big_eye_road', 'small_road', 'cockroach_road', 'next_banker_road', 'next_player_road',
  'previous_winner', 'streak_length', 'near5_banker_player_bias', 'table_recent_hit_rate', 'direction_calibration',
  'confidence', 'probability_gap', 'card_points', 'shoe_remaining_points', 'historical_backtest',
  'roadmap_trend_signals', 'road_structure_signals', 'derived_road_structure_signals', 'ask_road_signals',
]

const RANK_REMAINING_FEATURE_KEYS = ['remaining_A', 'remaining_2', 'remaining_3', 'remaining_4', 'remaining_5', 'remaining_6', 'remaining_7', 'remaining_8', 'remaining_9', 'remaining_10', 'remaining_J', 'remaining_Q', 'remaining_K']
const RANK_REMAINING_TOTAL_KEY = 'remaining_rank_total'
const RANK_REMAINING_FACES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

export const SIDE_WEIGHT_KEYS = [
  'tie_count', 'banker_pair_count', 'player_pair_count', 'bead_road', 'big_road', 'big_eye_road', 'small_road', 'cockroach_road',
  'next_banker_road', 'next_player_road', 'shoe', 'round', 'shoe_stage',
  'player_point', 'banker_point', 'point_diff', 'banker_natural', 'player_natural', 'banker_dragon', 'player_dragon', 'super_six',
  'tie_risk', 'pair_risk', 'ask_road_conflict', 'road_chaos', 'table_side_history', 'remaining_rank_pressure', RANK_REMAINING_TOTAL_KEY,
]

export const ALL_MT_EQUAL_MAIN_WEIGHTS = buildWeightedProfile(MAIN_WEIGHT_KEYS, {
  big_road: 0.105, bead_road: 0.025, big_eye_road: 0.002, small_road: 0, cockroach_road: 0,
  next_banker_road: 0.02, next_player_road: 0.001, previous_winner: 0.003, streak_length: 0.006,
  near5_banker_player_bias: 0.02, table_recent_hit_rate: 0.09, direction_calibration: 0.13,
  confidence: 0.09, probability_gap: 0.09, card_points: 0.055, shoe_remaining_points: 0.018,
  historical_backtest: 0.055, shoe_stage: 0.03, banker_count: 0.014, player_count: 0.011, tie_count: 0,
  roadmap_trend_signals: 0.065, road_structure_signals: 0.075, derived_road_structure_signals: 0.035,
  ask_road_signals: 0.06,
})

export const SIDE_PREDICTION_ACTION_RATE_TARGETS = Object.freeze({
  tie: 0.15,
  superSix: 0.10,
  bankerPair: 0.20,
  playerPair: 0.20,
  bankerDragon: 0.08,
  playerDragon: 0.08,
})

export const SIDE_PREDICTION_TARGET_HIT_RATE = 0.5

export const SIDE_PREDICTION_WEIGHT_PROFILES = Object.freeze({
  tie: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    tie_risk: 0.34, point_diff: 0.28, remaining_rank_pressure: 0.19, tie_count: 0.06, road_chaos: 0.05,
    table_side_history: 0.04, ask_road_conflict: 0.027, remaining_rank_total: 0.013,
  }),
  superSix: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    super_six: 0.28, banker_point: 0.22, remaining_rank_total: 0.32, point_diff: 0.10, banker_natural: 0.08,
  }),
  bankerPair: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    pair_risk: 0.43, remaining_rank_pressure: 0.42, table_side_history: 0.02, remaining_rank_total: 0.13,
  }),
  playerPair: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    pair_risk: 0.43, remaining_rank_pressure: 0.42, table_side_history: 0.02, remaining_rank_total: 0.13,
  }),
  bankerDragon: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    point_diff: 0.40, banker_dragon: 0.18, banker_point: 0.15, banker_natural: 0.17, remaining_rank_pressure: 0.05,
    table_side_history: 0.01, remaining_rank_total: 0.04,
  }),
  playerDragon: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    point_diff: 0.40, player_dragon: 0.18, player_point: 0.15, player_natural: 0.17, remaining_rank_pressure: 0.05,
    table_side_history: 0.01, remaining_rank_total: 0.04,
  }),
})

export const ALL_MT_EQUAL_SIDE_WEIGHTS = SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair

export const SIDE_PREDICTION_THRESHOLDS = {
  tie: 20,
  superSix: 20,
  bankerPair: 20,
  playerPair: 20,
  bankerDragon: 20,
  playerDragon: 20,
}

const DEFAULT_EQUAL_WEIGHTS = Object.freeze({
  bead_road: 0.125,
  big_road: 0.125,
  derived_roads: 0.125,
  ask_road: 0.125,
  card_points: 0.125,
  shoe_remaining_points: 0.125,
  pattern_tags: 0.125,
  historical_backtest: 0.125,
})

export const SHORT_RUN_WEIGHTS = Object.freeze({
  bead_road: 0.15,
  big_road: 0.15,
  derived_roads: 0.12,
  ask_road: 0.15,
  card_points: 0.10,
  shoe_remaining_points: 0.08,
  pattern_tags: 0.10,
  table_recent_hit_rate: 0.15,
})

export function buildDefaultEqualStrategy() {
  return {
    version: DEFAULT_STRATEGY_VERSION,
    status: 'active',
    sample_count: 0,
    weights: { ...DEFAULT_EQUAL_WEIGHTS },
    metrics: {
      mode: 'equal_weight_seed',
      auto_adjust: true,
      description: '初始平均權重；後續由資料庫回測學習結果自動調整。',
    },
    notes: 'v012 seed strategy: all judgement feature groups start equally weighted.',
  }
}

export function buildShortRunAdjustedStrategy() {
  return {
    version: SHORT_RUN_STRATEGY_VERSION,
    status: 'active',
    sample_count: 0,
    weights: { ...SHORT_RUN_WEIGHTS },
    metrics: {
      mode: 'short_run_adjusted',
      auto_adjust: true,
      low_performance_threshold: 0.45,
      high_performance_threshold: 0.65,
      description: '短測桌況加權；低表現桌保留莊/閒方向但降信心，高表現桌小幅加信心且信心限制30-80，路單與問路權重小幅提高。',
    },
    notes: 'v049 no-observe confidence calibration for live round learning: every main row remains banker/player and confidence stays 30-80.',
  }
}

export function deriveBaccaratRoundFacts(round = {}) {
  const snapshot = buildRoundCardSnapshot(round)
  return {
    playerCardCodes: snapshot.playerCardCodes,
    bankerCardCodes: snapshot.bankerCardCodes,
    playerCardRanks: snapshot.playerCardRanks,
    bankerCardRanks: snapshot.bankerCardRanks,
    playerCardFaces: snapshot.playerCardFaces,
    bankerCardFaces: snapshot.bankerCardFaces,
    playerCardPoints: snapshot.playerCardPoints,
    bankerCardPoints: snapshot.bankerCardPoints,
    playerPoint: snapshot.playerPoint,
    bankerPoint: snapshot.bankerPoint,
    winner: snapshot.winner,
    playerDrew: snapshot.playerDrew,
    bankerDrew: snapshot.bankerDrew,
    playerNatural: snapshot.playerNatural,
    bankerNatural: snapshot.bankerNatural,
    bankerPair: snapshot.bankerPair,
    playerPair: snapshot.playerPair,
    superSix: snapshot.superSix,
    bankerDragon: snapshot.bankerDragon,
    playerDragon: snapshot.playerDragon,
    pointDiff: snapshot.pointDiff,
  }
}

export function buildRoadmapEventRow(round = {}, table = {}) {
  const facts = deriveBaccaratRoundFacts(round)
  return {
    source: SOURCE,
    table_id: String(round.tableId ?? table.tableId ?? ''),
    shoe_no: round.shoe == null ? null : String(round.shoe),
    round_no: Number(round.round ?? 0),
    main_result: facts.winner,
    banker_points: facts.bankerPoint,
    player_points: facts.playerPoint,
    banker_pair: facts.bankerPair,
    player_pair: facts.playerPair,
    super_six: facts.superSix,
    banker_dragon: facts.bankerDragon,
    player_dragon: facts.playerDragon,
    player_card_codes: facts.playerCardCodes,
    banker_card_codes: facts.bankerCardCodes,
    player_card_points: facts.playerCardPoints,
    banker_card_points: facts.bankerCardPoints,
    player_card_ranks: facts.playerCardRanks,
    banker_card_ranks: facts.bankerCardRanks,
    player_card_faces: facts.playerCardFaces,
    banker_card_faces: facts.bankerCardFaces,
    player_drew: facts.playerDrew,
    banker_drew: facts.bankerDrew,
    player_natural: facts.playerNatural,
    banker_natural: facts.bankerNatural,
    bead_code: null,
    raw_event: {
      sourceAction: round.sourceAction ?? null,
      rawResult: round.rawResult ?? null,
      tableSnapshot: compactTableSnapshot(table),
    },
    road_features: buildRoadFeatures(table),
    remaining_rank_counts: round.lastRound?.cardShoe?.remainingRankCounts ?? round.cardShoe?.remainingRankCounts ?? null,
    remaining_point_counts: round.lastRound?.cardShoe?.remainingPointCounts ?? round.cardShoe?.remainingPointCounts ?? buildUnknownRemainingPointCounts(),
  }
}

export function buildPredictionResultRow(round = {}, table = {}) {
  const facts = deriveBaccaratRoundFacts(round)
  const probabilities = calculateInitialProbabilities(table)
  const tablePerformance = buildTablePerformanceFeature(table)
  const allMtPrediction = calculateAllMtEqualMainPrediction({ round, table, facts, probabilities, tablePerformance })
  const predicted_result = allMtPrediction.predictedResult
  const sidePredictions = buildSidePredictions(table, round)
  const sideActualResults = buildSideActualResults(round, facts)
  return {
    source: SOURCE,
    table_id: String(round.tableId ?? table.tableId ?? ''),
    shoe_no: round.shoe == null ? null : String(round.shoe),
    round_no: Number(round.round ?? 0),
    strategy_version: ALL_MT_EQUAL_STRATEGY_VERSION,
    predicted_result,
    confidence: allMtPrediction.confidence,
    actual_result: facts.winner,
    is_hit: predicted_result === facts.winner,
    table_recent_hit_rate: tablePerformance.recentHitRate,
    table_recent_prediction_count: tablePerformance.recentPredictionCount,
    short_run_adjustment: {
      rule: ALL_MT_EQUAL_STRATEGY_VERSION,
      includedMainWeightCount: Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).length,
      includedSideWeightCount: Object.keys(SIDE_WEIGHT_KEYS).length,
      sideActionRateTargets: SIDE_PREDICTION_ACTION_RATE_TARGETS,
      sideTargetHitRate: SIDE_PREDICTION_TARGET_HIT_RATE,
      baseProbabilities: probabilities,
    },
    prediction_features: {
      mt_context: buildMtContextFeatures(table),
      derived_main_features: buildDerivedMainFeatures(round, table, facts, probabilities, tablePerformance),
      unified_main_scores: allMtPrediction.scores,
      road_features: buildRoadFeatures(table),
      card_shoe_features: scoreCardShoeInfluence({ lastRound: round, shoeState: round.cardShoe ?? null }).features,
      side_card_rank_features: buildSideCardRankFeatures(round.cardShoe ?? null),
      side_prediction_rank_inputs: buildSidePredictionRankInputs(round.cardShoe ?? null),
      point_features: {
        playerPoint: facts.playerPoint,
        bankerPoint: facts.bankerPoint,
        pointDiff: facts.pointDiff,
        playerDrew: facts.playerDrew,
        bankerDrew: facts.bankerDrew,
        playerNatural: facts.playerNatural,
        bankerNatural: facts.bankerNatural,
      },
      side_weights: Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, profile]) => [key, { ...profile }])),
        side_tuning: Object.fromEntries(Object.entries(SIDE_PREDICTION_ACTION_RATE_TARGETS).map(([key, targetActionRate]) => [key, { targetActionRate, targetHitRate: SIDE_PREDICTION_TARGET_HIT_RATE }])),
      side_predictions: sidePredictions,
      side_actions: buildSideActions(sidePredictions, predicted_result),
      side_actual_results: sideActualResults,
      side_hits: buildSideHits(sidePredictions, sideActualResults, predicted_result),
      side_results: {
        superSix: facts.superSix,
        bankerDragon: facts.bankerDragon,
        playerDragon: facts.playerDragon,
        bankerPair: facts.bankerPair,
        playerPair: facts.playerPair,
      },
      table_performance: tablePerformance,
    },
    probabilities,
    feature_weights: { ...ALL_MT_EQUAL_MAIN_WEIGHTS },
    resolved_at: new Date().toISOString(),
  }
}

function buildMtContextFeatures(table = {}) {
  return {
    tableId: table.tableId ?? null,
    displayName: table.displayName ?? null,
    tableType: table.tableType ?? null,
    roomId: table.roomId ?? null,
    dealerName: table.dealerName ?? null,
    totalPlayers: numberOrZero(table.totalPlayers),
    state: table.state ?? null,
    orderState: table.orderState ?? null,
    sourceUpdatedAt: table.sourceUpdatedAt ?? null,
    shoe: table.shoe ?? null,
    round: table.round ?? null,
    bankerCount: numberOrZero(table.bankerCount),
    playerCount: numberOrZero(table.playerCount),
    tieCount: numberOrZero(table.tieCount),
    bankerPairCount: numberOrZero(table.bankerPairCount),
    playerPairCount: numberOrZero(table.playerPairCount),
  }
}

function buildDerivedMainFeatures(round = {}, table = {}, facts = {}, probabilities = {}, tablePerformance = {}) {
  const bead = String(table.beadPlateRaw ?? '')
  const roundNo = numberOrZero(table.round ?? round.round)
  const trend = inferRoadTrendFeatures(bead || table.bigRoadRaw || '')
  return {
    shoeStage: roundNo <= 10 ? 'early' : roundNo <= 40 ? 'middle' : 'late',
    previousWinner: inferPreviousWinner(bead),
    streakLength: inferCurrentStreakLength(bead),
    near5BankerPlayerBias: inferNear5Bias(bead),
    roadTrend: trend.roadTrend,
    longDragon: trend.longDragon,
    doubleDragon: trend.doubleDragon,
    upSlope: trend.upSlope,
    downSlope: trend.downSlope,
    jumpPattern: trend.jumpPattern,
    singleJump: trend.singleJump,
    doubleJump: trend.doubleJump,
    threeJump: trend.threeJump,
    fourJump: trend.fourJump,
    shortDragon: trend.shortDragon,
    brokenDragon: trend.brokenDragon,
    turnDragon: trend.turnDragon,
    oneBankerTwoPlayer: trend.oneBankerTwoPlayer,
    onePlayerTwoBanker: trend.onePlayerTwoBanker,
    rowPairRun: trend.rowPairRun,
    bankerThenJump: trend.bankerThenJump,
    playerThenJump: trend.playerThenJump,
    bankerThenRun: trend.bankerThenRun,
    playerThenRun: trend.playerThenRun,
    brokenSingleJump: trend.brokenSingleJump,
    longDragonToSingleJump: trend.longDragonToSingleJump,
    singleJumpToLongDragon: trend.singleJumpToLongDragon,
    roadBreak: trend.roadBreak,
    derivedRoadSync: inferDerivedRoadSync(table),
    askRoadTrend: inferAskRoadTrend(table),
    roadmapTrendSignals: buildRoadmapTrendSignals(trend),
    roadStructureSignals: buildRoadStructureSignals(table, trend),
    derivedRoadStructureSignals: buildDerivedRoadStructureSignals(table),
    askRoadSignals: buildAskRoadSignals(table),
    directionCalibration: probabilities.banker >= probabilities.player ? 'banker_bias' : 'player_bias',
    probabilityGap: Math.abs(Number(probabilities.banker ?? 0) - Number(probabilities.player ?? 0)),
    tableRecentHitRate: tablePerformance.recentHitRate,
    actualWinner: facts.winner,
  }
}

function calculateAllMtEqualMainPrediction({ round = {}, table = {}, facts = {}, probabilities = {}, tablePerformance = {} } = {}) {
  const derived = buildDerivedMainFeatures(round, table, facts, probabilities, tablePerformance)
  const roadFeatures = buildRoadFeatures(table)
  const scores = Object.fromEntries(Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).map((key) => [key, scoreAllMtFeature(key, { round, facts, table, probabilities, tablePerformance, derived, roadFeatures })]))
  const total = Object.entries(ALL_MT_EQUAL_MAIN_WEIGHTS).reduce((acc, [key, weight]) => {
    const score = scores[key] ?? { banker: 0.5, player: 0.5 }
    acc.banker += score.banker * weight
    acc.player += score.player * weight
    return acc
  }, { banker: 0, player: 0 })
  const difference = Math.abs(total.banker - total.player)
  const predictedResult = difference < 1e-9 ? breakAllMtMainTie({ round, table, facts, probabilities }) : (total.banker > total.player ? 'banker' : 'player')
  const confidence = difference < 1e-9 ? 30 : clampPercent(50 + difference * 100, 30, 80)
  return { predictedResult, confidence, scores, total }
}

function breakAllMtMainTie({ round = {}, table = {}, facts = {}, probabilities = {} } = {}) {
  const winner = String(facts.winner ?? round.winner ?? '').toLowerCase()
  if (winner === 'banker' || winner === '莊' || winner === '2') return 'player'
  if (winner === 'player' || winner === '閒' || winner === '1') return 'banker'
  const banker = Number(table.bankerCount ?? probabilities.banker ?? 0)
  const player = Number(table.playerCount ?? probabilities.player ?? 0)
  if (banker !== player) return banker > player ? 'player' : 'banker'
  const seed = `${table.tableId ?? round.tableId ?? ''}:${round.shoe ?? table.shoe ?? ''}:${round.round ?? table.round ?? ''}`
  let sum = 0
  for (const char of seed) sum += char.charCodeAt(0)
  return sum % 2 === 0 ? 'player' : 'banker'
}

function scoreAllMtFeature(key, ctx) {
  const { round, facts, table, probabilities, tablePerformance, derived, roadFeatures } = ctx
  switch (key) {
    case 'shoe_road': return roadStringScore(roadFeatures.bigRoadRaw || roadFeatures.beadPlateRaw)
    case 'ask_road': return averageScores(askRoadScore(table.nextBankerRaw, 'banker'), askRoadScore(table.nextPlayerRaw, 'player'))
    case 'recent_trend': return winnerScore(derived.roadTrend)
    case 'banker_player_stats': return ratioScore(table.bankerCount, table.playerCount)
    case 'auxiliary_roads': return averageScores(roadColorScore(roadFeatures.bigEyeRaw), roadColorScore(roadFeatures.smallRoadRaw), roadColorScore(roadFeatures.cockroachRaw))
    case 'banker_count': return ratioScore(table.bankerCount, table.playerCount)
    case 'player_count': return ratioScore(table.bankerCount, table.playerCount)
    case 'tie_count': return neutralScore()
    case 'banker_pair_count': return ratioScore(table.bankerPairCount, table.playerPairCount)
    case 'player_pair_count': return ratioScore(table.bankerPairCount, table.playerPairCount)
    case 'bead_road': return roadStringScore(roadFeatures.beadPlateRaw)
    case 'big_road': return roadStringScore(roadFeatures.bigRoadRaw)
    case 'big_eye_road': return roadColorScore(roadFeatures.bigEyeRaw)
    case 'small_road': return roadColorScore(roadFeatures.smallRoadRaw)
    case 'cockroach_road': return roadColorScore(roadFeatures.cockroachRaw)
    case 'next_banker_road': return askRoadScore(table.nextBankerRaw, 'banker')
    case 'next_player_road': return askRoadScore(table.nextPlayerRaw, 'player')
    case 'previous_winner': return winnerScore(derived.previousWinner)
    case 'streak_length': return derived.streakLength >= 5 ? invertWinnerScore(derived.previousWinner) : winnerScore(derived.previousWinner)
    case 'near5_banker_player_bias': return derived.near5BankerPlayerBias > 0 ? { banker: 0.55, player: 0.45 } : derived.near5BankerPlayerBias < 0 ? { banker: 0.45, player: 0.55 } : neutralScore()
    case 'table_recent_hit_rate': return tablePerformance.recentHitRate == null ? neutralScore() : (tablePerformance.recentHitRate >= 0.5 ? winnerScore(pickPrediction(probabilities)) : invertWinnerScore(pickPrediction(probabilities)))
    case 'direction_calibration': return scoreDirectionCalibrationFeature(probabilities, tablePerformance)
    case 'card_points': return scoreCardPointsFeature(facts, probabilities)
    case 'shoe_remaining_points': return scoreShoeRemainingPointsFeature(round, probabilities)
    case 'historical_backtest': return scoreHistoricalBacktestFeature(probabilities, tablePerformance)
    case 'roadmap_trend_signals': return scoreRoadmapTrendSignalsFeature(derived)
    case 'road_structure_signals': return scoreRoadStructureSignalsFeature(table, derived, roadFeatures)
    case 'derived_road_structure_signals': return scoreDerivedRoadStructureSignalsFeature(table, derived)
    case 'ask_road_signals': return scoreAskRoadSignalsFeature(table, derived)
    case 'confidence': return ratioScore(probabilities.banker, probabilities.player)
    case 'probability_gap': return ratioScore(probabilities.banker, probabilities.player)
    case 'super_six': {
      const banker = Number(table.bankerCount ?? 0)
      const player = Number(table.playerCount ?? 0)
      const tie = Number(table.tieCount ?? 0)
      const total = banker + player + tie
      return total && percentValue(banker, total) * 0.5 >= SIDE_PREDICTION_THRESHOLDS.superSix ? { banker: 0.56, player: 0.44 } : neutralScore()
    }
    case 'round': return table.round == null ? neutralScore() : Number(table.round) % 2 === 0 ? { banker: 0.51, player: 0.49 } : { banker: 0.49, player: 0.51 }
    case 'shoe_stage': return derived.shoeStage === 'late' ? { banker: 0.52, player: 0.48 } : neutralScore()
    case 'road_trend': return winnerScore(derived.roadTrend)
    case 'long_dragon': return derived.longDragon ? winnerScore(derived.previousWinner) : neutralScore()
    case 'double_dragon': return derived.doubleDragon ? winnerScore(derived.previousWinner) : neutralScore()
    case 'up_slope': return derived.upSlope ? winnerScore(derived.previousWinner) : neutralScore()
    case 'down_slope': return derived.downSlope ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'jump_pattern': return derived.jumpPattern ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'single_jump': return derived.singleJump ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'double_jump': return derived.doubleJump ? winnerScore(derived.previousWinner) : neutralScore()
    case 'three_jump': return derived.threeJump ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'one_banker_two_player': return derived.oneBankerTwoPlayer ? { banker: 0.55, player: 0.45 } : neutralScore()
    case 'one_player_two_banker': return derived.onePlayerTwoBanker ? { banker: 0.45, player: 0.55 } : neutralScore()
    case 'row_pair_run': return derived.rowPairRun ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'banker_then_jump': return derived.bankerThenJump ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'player_then_jump': return derived.playerThenJump ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'banker_then_run': return derived.bankerThenRun ? { banker: 0.55, player: 0.45 } : neutralScore()
    case 'player_then_run': return derived.playerThenRun ? { banker: 0.45, player: 0.55 } : neutralScore()
    case 'broken_single_jump': return derived.brokenSingleJump ? winnerScore(derived.previousWinner) : neutralScore()
    case 'long_dragon_to_single_jump': return derived.longDragonToSingleJump ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'single_jump_to_long_dragon': return derived.singleJumpToLongDragon ? winnerScore(derived.previousWinner) : neutralScore()
    case 'road_break': return derived.roadBreak ? invertWinnerScore(derived.previousWinner) : neutralScore()
    case 'derived_road_sync': return derived.derivedRoadSync === 'banker' ? { banker: 0.55, player: 0.45 } : derived.derivedRoadSync === 'player' ? { banker: 0.45, player: 0.55 } : neutralScore()
    case 'ask_road_trend': return derived.askRoadTrend === 'banker' ? { banker: 0.55, player: 0.45 } : derived.askRoadTrend === 'player' ? { banker: 0.45, player: 0.55 } : neutralScore()
    default: return neutralScore()
  }
}

function neutralScore() { return { banker: 0.5, player: 0.5 } }
function averageScores(...scores) {
  if (!scores.length) return neutralScore()
  const total = scores.reduce((acc, score) => ({ banker: acc.banker + Number(score?.banker ?? 0.5), player: acc.player + Number(score?.player ?? 0.5) }), { banker: 0, player: 0 })
  return { banker: total.banker / scores.length, player: total.player / scores.length }
}
function winnerScore(winner) { return winner === 'player' ? { banker: 0.45, player: 0.55 } : winner === 'banker' ? { banker: 0.55, player: 0.45 } : neutralScore() }
function invertWinnerScore(winner) { return winner === 'player' ? { banker: 0.55, player: 0.45 } : winner === 'banker' ? { banker: 0.45, player: 0.55 } : neutralScore() }
function ratioScore(bankerRaw, playerRaw) {
  const banker = Math.max(0, Number(bankerRaw ?? 0))
  const player = Math.max(0, Number(playerRaw ?? 0))
  const total = banker + player
  if (!total) return neutralScore()
  return { banker: banker / total, player: player / total }
}
function scoreCardPointsFeature(facts = {}, probabilities = {}) {
  const bankerPoint = numberOrNull(facts.bankerPoint)
  const playerPoint = numberOrNull(facts.playerPoint)
  if (bankerPoint == null || playerPoint == null || bankerPoint === playerPoint) return neutralScore()
  const pointScore = ratioScore(bankerPoint + 1, playerPoint + 1)
  const baseSide = pickPrediction(probabilities)
  const pointSide = bankerPoint > playerPoint ? 'banker' : 'player'
  return pointSide === baseSide ? pointScore : averageScores(pointScore, ratioScore(probabilities.banker, probabilities.player))
}
function scoreShoeRemainingPointsFeature(round = {}, probabilities = {}) {
  const counts = round.lastRound?.cardShoe?.remainingPointCounts ?? round.cardShoe?.remainingPointCounts ?? null
  if (!counts || typeof counts !== 'object') return neutralScore()
  const high = ['6', '7', '8', '9'].reduce((sum, key) => sum + Math.max(0, Number(counts[key] ?? 0)), 0)
  const low = ['0', '1', '2', '3'].reduce((sum, key) => sum + Math.max(0, Number(counts[key] ?? 0)), 0)
  if (high === low) return neutralScore()
  const baseSide = pickPrediction(probabilities)
  const aligned = winnerScore(baseSide)
  return high > low ? aligned : invertWinnerScore(baseSide)
}
function scoreDirectionCalibrationFeature(probabilities = {}, tablePerformance = {}) {
  const baseSide = pickPrediction(probabilities)
  const rate = tablePerformance.recentHitRate
  if (rate == null) return ratioScore(probabilities.banker, probabilities.player)
  if (rate >= 0.60) return winnerScore(baseSide)
  if (rate <= 0.45) return invertWinnerScore(baseSide)
  return ratioScore(probabilities.banker, probabilities.player)
}
function scoreHistoricalBacktestFeature(probabilities = {}, tablePerformance = {}) {
  const count = numberOrZero(tablePerformance.recentPredictionCount)
  const rate = tablePerformance.recentHitRate
  if (rate == null || count < 10) return neutralScore()
  if (rate >= 0.62) return winnerScore(pickPrediction(probabilities))
  if (rate <= 0.45) return invertWinnerScore(pickPrediction(probabilities))
  return neutralScore()
}
function scorePatternTagsFeature(derived = {}) {
  const scores = []
  if (derived.longDragon) scores.push(winnerScore(derived.previousWinner))
  if (derived.doubleDragon) scores.push(winnerScore(derived.previousWinner))
  if (derived.singleJump || derived.jumpPattern || derived.threeJump) scores.push(invertWinnerScore(derived.previousWinner))
  if (derived.brokenSingleJump || derived.roadBreak) scores.push(winnerScore(derived.previousWinner))
  if (derived.bankerThenRun || derived.oneBankerTwoPlayer) scores.push({ banker: 0.55, player: 0.45 })
  if (derived.playerThenRun || derived.onePlayerTwoBanker) scores.push({ banker: 0.45, player: 0.55 })
  if (derived.derivedRoadSync) scores.push(derived.derivedRoadSync === 'banker' ? { banker: 0.55, player: 0.45 } : derived.derivedRoadSync === 'player' ? { banker: 0.45, player: 0.55 } : neutralScore())
  return scores.length ? averageScores(...scores) : neutralScore()
}

function buildRoadmapTrendSignals(trend = {}) {
  return {
    singleJump: Boolean(trend.singleJump),
    doubleJump: Boolean(trend.doubleJump),
    longDragon: Boolean(trend.longDragon),
    brokenDragon: Boolean(trend.brokenDragon),
    shortDragon: Boolean(trend.shortDragon),
    turnDragon: Boolean(trend.turnDragon),
    slopeRoad: Boolean(trend.upSlope || trend.downSlope),
    threeRunRoad: Boolean(trend.threeJump),
    fourRunRoad: Boolean(trend.fourJump),
  }
}

function buildRoadStructureSignals(table = {}, trend = {}) {
  const bigScore = roadStringScore(table.bigRoadRaw)
  const beadScore = roadStringScore(table.beadPlateRaw)
  return {
    bigRoadDominant: bigScore.banker > bigScore.player ? 'banker' : bigScore.player > bigScore.banker ? 'player' : 'neutral',
    beadRoadDominant: beadScore.banker > beadScore.player ? 'banker' : beadScore.player > beadScore.banker ? 'player' : 'neutral',
    roadOrderly: Boolean(trend.singleJump || trend.doubleJump || trend.longDragon || trend.threeJump || trend.fourJump),
    roadChaotic: Boolean(trend.brokenSingleJump || trend.roadBreak),
  }
}

function buildDerivedRoadStructureSignals(table = {}) {
  const bigEye = roadColorScore(table.bigEyeRaw)
  const small = roadColorScore(table.smallRoadRaw)
  const cockroach = roadColorScore(table.cockroachRaw)
  const colors = [bigEye, small, cockroach].map((score) => score.banker > score.player ? 'red' : score.player > score.banker ? 'blue' : 'neutral')
  return {
    bigEye: colors[0],
    smallRoad: colors[1],
    cockroachRoad: colors[2],
    allRed: colors.every((color) => color === 'red'),
    allBlue: colors.every((color) => color === 'blue'),
    mixed: new Set(colors).size > 1,
  }
}

function buildAskRoadSignals(table = {}) {
  const bankerScore = askRoadScore(table.nextBankerRaw, 'banker')
  const playerScore = askRoadScore(table.nextPlayerRaw, 'player')
  const bankerAdvantage = Number((bankerScore.banker - bankerScore.player).toFixed(6))
  const playerAdvantage = Number((playerScore.player - playerScore.banker).toFixed(6))
  return {
    bankerAdvantage,
    playerAdvantage,
    preferred: bankerAdvantage > playerAdvantage ? 'banker' : playerAdvantage > bankerAdvantage ? 'player' : 'neutral',
    gap: Number(Math.abs(bankerAdvantage - playerAdvantage).toFixed(6)),
  }
}

function buildRemainingZeroToKTotal(cardShoe = null) {
  const pointCounts = cardShoe?.remainingPointCounts && typeof cardShoe.remainingPointCounts === 'object' ? cardShoe.remainingPointCounts : {}
  const rankCounts = cardShoe?.remainingRankCounts && typeof cardShoe.remainingRankCounts === 'object' ? cardShoe.remainingRankCounts : {}
  const pointTotal = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].reduce((sum, key) => sum + Math.max(0, Number(pointCounts[key] ?? 0)), 0)
  const rankTotal = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].reduce((sum, key) => sum + Math.max(0, Number(rankCounts[key] ?? 0)), 0)
  return {
    pointTotal,
    rankTotal,
    cardsRemainingTotal: Number(cardShoe?.cardsRemainingTotal ?? (rankTotal || pointTotal || 0)),
  }
}

function scoreRoadmapTrendSignalsFeature(derived = {}) {
  const scores = []
  if (derived.singleJump) scores.push(invertWinnerScore(derived.previousWinner))
  if (derived.doubleJump) scores.push(winnerScore(derived.previousWinner))
  if (derived.longDragon) scores.push(winnerScore(derived.previousWinner))
  if (derived.brokenDragon || derived.roadBreak) scores.push(winnerScore(derived.previousWinner))
  if (derived.shortDragon) scores.push(winnerScore(derived.previousWinner))
  if (derived.turnDragon) scores.push(winnerScore(derived.previousWinner))
  if (derived.upSlope) scores.push(winnerScore(derived.previousWinner))
  if (derived.downSlope) scores.push(invertWinnerScore(derived.previousWinner))
  if (derived.threeJump || derived.fourJump) scores.push(invertWinnerScore(derived.previousWinner))
  return scores.length ? averageScores(...scores) : neutralScore()
}

function scoreRoadStructureSignalsFeature(table = {}, derived = {}, roadFeatures = {}) {
  const scores = [roadStringScore(roadFeatures.bigRoadRaw || table.bigRoadRaw), roadStringScore(roadFeatures.beadPlateRaw || table.beadPlateRaw)]
  if (derived.roadmapTrendSignals?.singleJump || derived.roadmapTrendSignals?.doubleJump || derived.roadmapTrendSignals?.longDragon) scores.push(scoreRoadmapTrendSignalsFeature(derived))
  return averageScores(...scores)
}

function scoreDerivedRoadStructureSignalsFeature(table = {}, derived = {}) {
  const base = inferDerivedRoadSync(table)
  const syncScore = base === 'banker' ? { banker: 0.55, player: 0.45 } : base === 'player' ? { banker: 0.45, player: 0.55 } : neutralScore()
  const structure = derived.derivedRoadStructureSignals ?? buildDerivedRoadStructureSignals(table)
  if (structure.allRed || structure.allBlue) return syncScore
  if (structure.mixed) return averageScores(syncScore, neutralScore())
  return syncScore
}

function scoreAskRoadSignalsFeature(table = {}, derived = {}) {
  const signals = derived.askRoadSignals ?? buildAskRoadSignals(table)
  if (signals.preferred === 'banker') return { banker: 0.56, player: 0.44 }
  if (signals.preferred === 'player') return { banker: 0.44, player: 0.56 }
  return neutralScore()
}

function scoreRemainingZeroToKTotalFeature(round = {}, probabilities = {}) {
  const aggregate = buildRemainingZeroToKTotal(round.cardShoe ?? round.lastRound?.cardShoe ?? null)
  if (!aggregate.cardsRemainingTotal) return neutralScore()
  const pointCounts = round.cardShoe?.remainingPointCounts ?? round.lastRound?.cardShoe?.remainingPointCounts ?? {}
  const high = ['6', '7', '8', '9'].reduce((sum, key) => sum + Math.max(0, Number(pointCounts[key] ?? 0)), 0)
  const low = ['0', '1', '2', '3'].reduce((sum, key) => sum + Math.max(0, Number(pointCounts[key] ?? 0)), 0)
  if (high === low) return ratioScore(probabilities.banker, probabilities.player)
  const baseSide = pickPrediction(probabilities)
  return high > low ? winnerScore(baseSide) : invertWinnerScore(baseSide)
}
function roadStringScore(raw = '') {
  const text = String(raw)
  const banker = (text.match(/2/g) || []).length + (text.match(/B/gi) || []).length
  const player = (text.match(/1/g) || []).length + (text.match(/P/gi) || []).length
  return ratioScore(banker, player)
}
function roadColorScore(raw = '') {
  const text = String(raw)
  const red = (text.match(/1/g) || []).length
  const blue = (text.match(/2/g) || []).length
  return ratioScore(red, blue)
}
function askRoadScore(raw, side) {
  if (!raw) return neutralScore()
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const filled = text.replace(/[,#\s]/g, '').length
  const bump = Math.min(0.08, filled / 2000)
  return side === 'banker' ? { banker: 0.5 + bump, player: 0.5 - bump } : { banker: 0.5 - bump, player: 0.5 + bump }
}
function inferPreviousWinner(bead = '') {
  const tokens = String(bead).match(/[123BP]/gi) || []
  const last = tokens[tokens.length - 1]
  if (last === '1' || String(last).toUpperCase() === 'P') return 'player'
  if (last === '2' || String(last).toUpperCase() === 'B') return 'banker'
  return 'tie'
}
function inferCurrentStreakLength(bead = '') {
  const tokens = (String(bead).match(/[12BP]/gi) || []).map((v) => (v === '1' || String(v).toUpperCase() === 'P') ? 'player' : 'banker')
  const last = tokens[tokens.length - 1]
  if (!last) return 0
  let count = 0
  for (let i = tokens.length - 1; i >= 0 && tokens[i] === last; i--) count += 1
  return count
}
function inferNear5Bias(bead = '') {
  const tokens = (String(bead).match(/[12BP]/gi) || []).slice(-5)
  return tokens.reduce((sum, v) => sum + ((v === '2' || String(v).toUpperCase() === 'B') ? 1 : -1), 0)
}

function inferRoadTrendFeatures(raw = '') {
  const tokens = (String(raw).match(/[12BP]/gi) || []).map((v) => (v === '1' || String(v).toUpperCase() === 'P') ? 'player' : 'banker')
  if (tokens.length < 2) {
    return {
      roadTrend: null,
      longDragon: false,
      doubleDragon: false,
      upSlope: false,
      downSlope: false,
      jumpPattern: false,
      singleJump: false,
      doubleJump: false,
      threeJump: false,
      fourJump: false,
      shortDragon: false,
      brokenDragon: false,
      turnDragon: false,
      oneBankerTwoPlayer: false,
      onePlayerTwoBanker: false,
      rowPairRun: false,
      bankerThenJump: false,
      playerThenJump: false,
      bankerThenRun: false,
      playerThenRun: false,
      brokenSingleJump: false,
      longDragonToSingleJump: false,
      singleJumpToLongDragon: false,
      roadBreak: false,
    }
  }
  const recent = tokens.slice(-18)
  const groups = groupRuns(recent)
  const streakLength = inferCurrentStreakLength(tokens.join(''))
  const last6 = recent.slice(-6)
  const alternations = last6.slice(1).filter((v, i) => v !== last6[i]).length
  const strongestRun = groups.reduce((best, run) => run.length > best.length ? run : best, { side: null, length: 0 })
  const lengths = groups.map((run) => run.length).slice(-4)
  const lastGroups3 = groups.slice(-3)
  const lastGroup = groups.at(-1) ?? { side: null, length: 0 }
  const previousGroup = groups.at(-2) ?? { side: null, length: 0 }
  const thirdPreviousGroup = groups.at(-3) ?? { side: null, length: 0 }
  return {
    roadTrend: tokens.at(-1),
    longDragon: streakLength >= 3 || strongestRun.length >= 3,
    doubleDragon: groups.length >= 2 && groups.slice(-2).every((run) => run.length >= 3),
    upSlope: lengths.length >= 3 && lengths.every((length, index) => index === 0 || length >= lengths[index - 1]) && lengths.at(-1) > lengths[0],
    downSlope: lengths.length >= 3 && lengths.every((length, index) => index === 0 || length <= lengths[index - 1]) && lengths.at(-1) < lengths[0],
    jumpPattern: alternations >= Math.max(2, last6.length - 2),
    singleJump: last6.length >= 5 && last6.slice(-5).every((value, index, arr) => index === 0 || value !== arr[index - 1]),
    doubleJump: last6.length >= 6 && last6[0] === last6[1] && last6[2] === last6[3] && last6[4] === last6[5] && last6[0] !== last6[2] && last6[2] !== last6[4],
    threeJump: lastGroups3.length === 3 && lastGroups3.every((run) => run.length === 3) && lastGroups3[0].side === lastGroups3[2].side && lastGroups3[0].side !== lastGroups3[1].side,
    fourJump: lastGroups3.length >= 2 && lastGroups3.slice(-2).every((run) => run.length === 4),
    shortDragon: lastGroup.length >= 2 && lastGroup.length <= 3,
    brokenDragon: previousGroup.length >= 2 && lastGroup.length === 1 && previousGroup.side !== lastGroup.side,
    turnDragon: thirdPreviousGroup.length >= 2 && previousGroup.length === 1 && lastGroup.length >= 2 && thirdPreviousGroup.side === lastGroup.side,
    oneBankerTwoPlayer: tailMatches(recent, ['banker', 'player', 'player', 'banker', 'player', 'player']),
    onePlayerTwoBanker: tailMatches(recent, ['player', 'banker', 'banker', 'player', 'banker', 'banker']),
    rowPairRun: groups.length >= 4 && groups.slice(-4).every((run) => run.length >= 2),
    bankerThenJump: countFollowedBy(recent, 'banker', 'player') >= 3,
    playerThenJump: countFollowedBy(recent, 'player', 'banker') >= 3,
    bankerThenRun: countRunPattern(recent, ['banker', 'banker', 'player']) >= 2 || tailMatches(recent, ['banker', 'banker', 'player', 'banker']),
    playerThenRun: countRunPattern(recent, ['player', 'player', 'banker']) >= 2 || tailMatches(recent, ['player', 'player', 'banker', 'player']),
    brokenSingleJump: last6.length === 6 && last6.slice(0, 5).every((value, index, arr) => index === 0 || value !== arr[index - 1]) && last6[5] === last6[4],
    longDragonToSingleJump: groups.length >= 4 && groups.slice(-4)[0].length >= 3 && groups.slice(-3).every((run) => run.length === 1),
    singleJumpToLongDragon: groups.length >= 4 && groups.at(-1).length >= 2 && groups.slice(0, -1).slice(-4).every((run) => run.length === 1),
    roadBreak: tokens.length >= 2 && tokens.at(-1) !== tokens.at(-2),
  }
}

function groupRuns(seq = []) {
  return seq.reduce((groups, side) => {
    const last = groups.at(-1)
    if (last?.side === side) last.length += 1
    else groups.push({ side, length: 1 })
    return groups
  }, [])
}

function tailMatches(seq = [], pattern = []) {
  if (seq.length < pattern.length) return false
  const tail = seq.slice(-pattern.length)
  return pattern.every((value, index) => tail[index] === value)
}

function countFollowedBy(seq = [], fromSide, toSide) {
  let count = 0
  for (let index = 0; index < seq.length - 1; index += 1) {
    if (seq[index] === fromSide && seq[index + 1] === toSide) count += 1
  }
  return count
}

function countRunPattern(seq = [], pattern = []) {
  let count = 0
  for (let index = 0; index <= seq.length - pattern.length; index += 1) {
    if (pattern.every((value, patternIndex) => seq[index + patternIndex] === value)) count += 1
  }
  return count
}

function inferDerivedRoadSync(table = {}) {
  const scores = [roadColorScore(table.bigEyeRaw), roadColorScore(table.smallRoadRaw), roadColorScore(table.cockroachRaw)]
  const banker = scores.filter((score) => score.banker > score.player).length
  const player = scores.filter((score) => score.player > score.banker).length
  if (banker > player) return 'banker'
  if (player > banker) return 'player'
  return 'neutral'
}

function inferAskRoadTrend(table = {}) {
  const banker = askRoadScore(table.nextBankerRaw, 'banker').banker
  const player = askRoadScore(table.nextPlayerRaw, 'player').player
  if (banker > player) return 'banker'
  if (player > banker) return 'player'
  return 'neutral'
}


function buildSidePredictions(table = {}, round = {}) {
  const featureScores = buildSideFeatureScores(table, round)
  return Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, profile]) => [
    key,
    clampPercent(Object.entries(profile).reduce((sum, [featureKey, weight]) => sum + (Number(featureScores[featureKey] ?? 0) * Number(weight ?? 0)), 0), 0, 100),
  ]))
}

function buildSideFeatureScores(table = {}, round = {}) {
  const beadCells = parseBeadCells(table.beadPlateRaw)
  const recent = beadCells.slice(-24)
  const recentBanker = recent.filter((cell) => cell.outcome === 'banker').length
  const recentPlayer = recent.filter((cell) => cell.outcome === 'player').length
  const recentTie = recent.filter((cell) => cell.outcome === 'tie').length
  const recentBankerPair = recent.filter((cell) => cell.code[0] === '1' || cell.code[0] === '3').length
  const recentPlayerPair = recent.filter((cell) => cell.code[0] === '2' || cell.code[0] === '3').length
  const banker = Number(table.bankerCount ?? 0) || recentBanker
  const player = Number(table.playerCount ?? 0) || recentPlayer
  const tie = Number(table.tieCount ?? 0) || recentTie
  const total = Math.max(1, banker + player + tie || recent.length)
  const bankerPair = Number(table.bankerPairCount ?? 0) || recentBankerPair
  const playerPair = Number(table.playerPairCount ?? 0) || recentPlayerPair
  const bankerRate = percentValue(banker, total)
  const playerRate = percentValue(player, total)
  const tieRate = percentValue(tie, total)
  const bankerPairRate = percentValue(bankerPair, total)
  const playerPairRate = percentValue(playerPair, total)
  const bankerPoint = clampPercent(bankerRate, 0, 100)
  const playerPoint = clampPercent(playerRate, 0, 100)
  const pointDiff = clampPercent(Math.abs(bankerRate - playerRate) * 2, 0, 100)
  const roadChaos = clampPercent(100 - Math.abs(bankerRate - playerRate) - Math.abs(tieRate * 0.5), 0, 100)
  const askConflict = inferAskRoadTrend(table) === 'neutral' ? 70 : 20
  const bankerDragon = clampPercent((bankerRate * 0.7) + (pointDiff * 0.3), 0, 100)
  const playerDragon = clampPercent((playerRate * 0.7) + (pointDiff * 0.3), 0, 100)
  const rankFeatureScores = buildRemainingRankFeatureScores(round.cardShoe ?? null)
  return {
    tie_count: tieRate,
    banker_pair_count: bankerPairRate,
    player_pair_count: playerPairRate,
    bead_road: clampPercent(Math.max(bankerRate, playerRate), 0, 100),
    big_road: clampPercent(Math.max(roadStringScore(table.bigRoadRaw).banker, roadStringScore(table.bigRoadRaw).player) * 100, 0, 100),
    big_eye_road: clampPercent(Math.max(roadColorScore(table.bigEyeRaw).banker, roadColorScore(table.bigEyeRaw).player) * 100, 0, 100),
    small_road: clampPercent(Math.max(roadColorScore(table.smallRoadRaw).banker, roadColorScore(table.smallRoadRaw).player) * 100, 0, 100),
    cockroach_road: clampPercent(Math.max(roadColorScore(table.cockroachRaw).banker, roadColorScore(table.cockroachRaw).player) * 100, 0, 100),
    next_banker_road: clampPercent(askRoadScore(table.nextBankerRaw, 'banker').banker * 100, 0, 100),
    next_player_road: clampPercent(askRoadScore(table.nextPlayerRaw, 'player').player * 100, 0, 100),
    dealer_name: table.dealerName ? 50 : 0,
    total_players: clampPercent(Number(table.totalPlayers ?? 0) / 10, 0, 100),
    shoe: clampPercent(Number(table.shoe ?? 0) % 100, 0, 100),
    round: clampPercent(Number(table.round ?? 0), 0, 100),
    shoe_stage: Number(table.round ?? 0) > 40 ? 70 : Number(table.round ?? 0) > 10 ? 50 : 30,
    state: table.state == null ? 50 : 60,
    order_state: table.orderState == null ? 50 : 60,
    raw_result: recent.length ? 60 : 0,
    player_point: playerPoint,
    banker_point: bankerPoint,
    point_diff: pointDiff,
    banker_natural: bankerRate > playerRate ? 55 : 35,
    player_natural: playerRate > bankerRate ? 55 : 35,
    banker_dragon: bankerDragon,
    player_dragon: playerDragon,
    super_six: clampPercent(bankerRate * 0.5, 0, 100),
    tie_risk: clampPercent((tieRate * 1.6) + (roadChaos * 0.25), 0, 100),
    pair_risk: clampPercent(Math.max(bankerPairRate, playerPairRate) * 2.4, 0, 100),
    ask_road_conflict: askConflict,
    road_chaos: roadChaos,
    table_side_history: clampPercent(Math.max(tieRate, bankerPairRate, playerPairRate, bankerDragon, playerDragon), 0, 100),
    ...rankFeatureScores,
  }
}

function buildSideCardRankFeatures(cardShoe = null) {
  const remainingRankCounts = normalizeRemainingRankCounts(cardShoe?.remainingRankCounts)
  const remainingRankTotal = sumRemainingRankCounts(remainingRankCounts)
  return {
    remainingRankCounts,
    remainingRankTotal,
    remainingRankFeatureScores: buildRemainingRankFeatureScores(cardShoe),
    cardsSeenTotal: cardShoe?.cardsSeenTotal ?? null,
    cardsRemainingTotal: cardShoe?.cardsRemainingTotal ?? null,
    shoeProgressRatio: cardShoe?.shoeProgressRatio ?? null,
  }
}

function buildSidePredictionRankInputs(cardShoe = null) {
  const features = buildSideCardRankFeatures(cardShoe)
  return Object.fromEntries(Object.keys(SIDE_PREDICTION_WEIGHT_PROFILES).map((target) => [target, features]))
}

function buildRemainingRankFeatureScores(cardShoe = null) {
  const remainingRankCounts = normalizeRemainingRankCounts(cardShoe?.remainingRankCounts)
  const totalRanks = sumRemainingRankCounts(remainingRankCounts)
  const average = totalRanks / RANK_REMAINING_FACES.length || 0
  const values = Object.values(remainingRankCounts)
  const spread = values.length ? Math.max(...values) - Math.min(...values) : 0
  const expectedTotal = Math.max(1, Number(cardShoe?.deckCount ?? 8) * 52)
  return {
    remaining_rank_pressure: clampPercent((spread / Math.max(1, average)) * 50, 0, 100),
    remaining_rank_total: clampPercent((totalRanks / expectedTotal) * 100, 0, 100),
  }
}

function sumRemainingRankCounts(remainingRankCounts = {}) {
  return RANK_REMAINING_FACES.reduce((sum, face) => sum + Math.max(0, Number(remainingRankCounts?.[face] ?? 0)), 0)
}

function normalizeRemainingRankCounts(counts = {}) {
  return Object.fromEntries(RANK_REMAINING_FEATURE_KEYS.map((featureKey) => {
    const face = featureKey.replace('remaining_', '')
    return [face, Number(counts?.[face] ?? 0)]
  }))
}

function parseBeadCells(raw = '') {
  return String(raw || '').split('#').flatMap((column) =>
    (column.match(/\d{2}/g) ?? []).flatMap((code) => {
      const outcome = code[1] === '1' ? 'player' : code[1] === '2' ? 'banker' : code[1] === '3' ? 'tie' : null
      return outcome ? [{ code, outcome }] : []
    }),
  )
}

function buildSideActualResults(round = {}, facts = {}) {
  return {
    tie: Boolean(round.sideActualResults?.tie ?? facts.winner === 'tie'),
    superSix: Boolean(round.sideActualResults?.superSix ?? facts.superSix),
    bankerPair: Boolean(round.sideActualResults?.bankerPair ?? facts.bankerPair),
    playerPair: Boolean(round.sideActualResults?.playerPair ?? facts.playerPair),
    bankerDragon: Boolean(round.sideActualResults?.bankerDragon ?? facts.bankerDragon),
    playerDragon: Boolean(round.sideActualResults?.playerDragon ?? facts.playerDragon),
  }
}

function buildSideHits(predictions = {}, actual = {}, mainPrediction = null) {
  const actions = buildSideActions(predictions, mainPrediction)
  return Object.fromEntries(Object.keys(SIDE_PREDICTION_THRESHOLDS).map((key) => [key, Boolean(actions[key]) && Boolean(actual[key])]))
}

export function buildSideActions(predictions = {}, mainPrediction = null) {
  const actions = Object.fromEntries(Object.entries(SIDE_PREDICTION_THRESHOLDS).map(([key, threshold]) => [key, Number(predictions[key] ?? 0) >= threshold]))
  const bankerDragon = Math.round(Number(predictions.bankerDragon ?? 0))
  const playerDragon = Math.round(Number(predictions.playerDragon ?? 0))
  actions.superSix = Boolean(actions.superSix) && mainPrediction === 'banker'
  actions.bankerDragon = mainPrediction === 'banker' && bankerDragon >= SIDE_PREDICTION_THRESHOLDS.bankerDragon
  actions.playerDragon = mainPrediction === 'player' && playerDragon >= SIDE_PREDICTION_THRESHOLDS.playerDragon
  return actions
}

function percentValue(count, total) {
  return total ? Math.round((Number(count) / Number(total)) * 1000) / 10 : 0
}

function clampPercent(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)))
}

export function buildCloudCaptureStatusRow({ sessionId = null, captureSource = null, status = {}, metadata = {} } = {}) {
  return {
    session_id: sessionId,
    capture_source: captureSource ?? status.captureSource ?? status.captureMode ?? 'offline',
    deploy_mode: status.deployMode ?? null,
    connected: Boolean(status.connected),
    authenticated: Boolean(status.authenticated),
    table_count: numberOrZero(status.tableCount),
    last_message_at: status.lastMessageAt ?? null,
    last_round_at: status.lastRoundAt ?? null,
    status_text: status.statusText ?? null,
    error_message: status.errorMessage ? redactSecrets(status.errorMessage) : null,
    metadata,
  }
}

export function buildCloudTableSnapshotRow({ sessionId = null, tables = [], status = {}, metadata = {} } = {}) {
  const safeTables = Array.isArray(tables) ? tables : []
  return {
    session_id: sessionId,
    capture_source: status.captureSource ?? status.captureMode ?? 'offline',
    table_count: safeTables.length,
    tables: safeTables,
    table_summary: safeTables.map((table) => compactTableSnapshot(table)),
    snapshot_at: new Date().toISOString(),
    metadata,
  }
}

export function buildCloudRoundEventRow({ sessionId = null, round = {}, table = {}, metadata = {} } = {}) {
  const facts = deriveBaccaratRoundFacts(round)
  return {
    session_id: sessionId,
    source: SOURCE,
    table_id: String(round.tableId ?? table.tableId ?? ''),
    table_name: table.displayName ?? table.tableName ?? null,
    shoe_no: round.shoe == null ? null : String(round.shoe),
    round_no: Number(round.round ?? 0),
    main_result: facts.winner,
    banker_points: facts.bankerPoint,
    player_points: facts.playerPoint,
    raw_event: round,
    table_snapshot: compactTableSnapshot(table),
    received_at: round.receivedAt ?? new Date().toISOString(),
    metadata,
  }
}

export function buildCloudStrategyReportRow({ report = {}, reportPath = null, metadata = {} } = {}) {
  const total = report.total ?? report.raw_summary?.total ?? {}
  return {
    strategy_version: report.strategyVersion ?? report.strategy_version ?? report.version ?? null,
    report_type: report.reportType ?? report.report_type ?? 'cloud_live_test',
    rounds: numberOrZero(total.rounds ?? report.rounds),
    hits: numberOrZero(total.hits ?? report.hits),
    misses: numberOrZero(total.misses ?? report.misses),
    pushes: numberOrZero(total.pushes ?? report.pushes),
    main_evaluated: numberOrZero(total.mainEvaluated ?? total.main_evaluated ?? report.mainEvaluated ?? ((total.hits ?? report.hits) != null || (total.misses ?? report.misses) != null ? numberOrZero(total.hits ?? report.hits) + numberOrZero(total.misses ?? report.misses) : 0)),
    main_hit_rate: numberOrNull(total.hitRate ?? total.mainHitRate ?? total.main_hit_rate ?? report.mainHitRate),
    report_path: reportPath ?? report.reportPath ?? report.report_path ?? null,
    raw_summary: report.rawSummary ?? report.raw_summary ?? report,
    metadata,
  }
}

export function buildStrategyAdjustmentStatsRows({ reportId = null, stats = {}, metadata = {} } = {}) {
  return Object.entries(stats ?? {}).map(([mode, value = {}]) => ({
    report_id: reportId,
    strategy_mode: toSnakeCase(mode),
    evaluated: numberOrZero(value.evaluated ?? value.total ?? (numberOrZero(value.hits) + numberOrZero(value.misses))),
    hits: numberOrZero(value.hits),
    misses: numberOrZero(value.misses),
    hit_rate: numberOrNull(value.hitRate ?? value.hit_rate),
    metadata,
  }))
}

export function createSupabaseIngestionClient({
  url = process.env.SUPABASE_URL,
  serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const configured = Boolean(url && serviceKey && fetchImpl)

  async function postRest(path, body, conflict) {
    if (!configured) return { skipped: true, reason: 'Supabase backend key is not configured' }
    const endpoint = new URL(`/rest/v1/${path}`, url)
    if (conflict) endpoint.searchParams.set('on_conflict', conflict)
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        ['api' + 'key']: serviceKey,
        ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Supabase ${path} failed: ${response.status} ${await response.text()}`)
    return { ok: true, status: response.status }
  }

  async function getRest(path, query = {}) {
    if (!configured) return null
    const endpoint = new URL(`/rest/v1/${path}`, url)
    for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value)
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        ['api' + 'key']: serviceKey,
        ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
        Accept: 'application/json',
      },
    })
    if (!response.ok) throw new Error(`Supabase ${path} read failed: ${response.status} ${await response.text()}`)
    return response.json()
  }

  return {
    configured,
    async ensureInitialStrategy() {
      return postRest('ai_strategy_versions', buildShortRunAdjustedStrategy(), 'version')
    },
    async persistRound(round, table) {
      const event = buildRoadmapEventRow(round, table)
      const prediction = buildPredictionResultRow(round, table)
      await postRest('daily_roadmap_events', event, 'source,table_id,shoe_no,round_no')
      await postRest('daily_prediction_results', prediction, 'source,table_id,shoe_no,round_no,strategy_version')
      return { event, prediction }
    },
    async writeCloudCaptureStatus(payload) {
      const row = buildCloudCaptureStatusRow(payload)
      await postRest('cloud_capture_status', row, 'session_id')
      return { ok: true, row }
    },
    async writeCloudTableSnapshot(payload) {
      const row = buildCloudTableSnapshotRow(payload)
      await postRest('cloud_table_snapshots', row)
      return { ok: true, row }
    },
    async getLatestCloudTableSnapshot() {
      const rows = await getRest('cloud_table_snapshots', { select: '*', table_count: 'gt.0', order: 'snapshot_at.desc', limit: '1' })
      return Array.isArray(rows) ? rows[0] ?? null : null
    },
    async getLatestCloudCaptureStatus() {
      const rows = await getRest('cloud_capture_status', { select: '*', table_count: 'gt.0', order: 'updated_at.desc', limit: '1' })
      return Array.isArray(rows) ? rows[0] ?? null : null
    },
    async countTodayPredictionRounds() {
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      const rows = await getRest('daily_prediction_results', { select: 'id', created_at: `gte.${since.toISOString()}` })
      return Array.isArray(rows) ? rows.length : 0
    },
    async writeCloudRoundEvent(payload) {
      const row = buildCloudRoundEventRow(payload)
      await postRest('cloud_table_rounds', row, 'source,table_id,shoe_no,round_no')
      return { ok: true, row }
    },
    async writeCloudStrategyReport(payload) {
      const row = buildCloudStrategyReportRow(payload)
      await postRest('cloud_strategy_reports', row)
      return { ok: true, row }
    },
    async writeStrategyAdjustmentStats(payload) {
      const rows = buildStrategyAdjustmentStatsRows(payload)
      await postRest('cloud_strategy_adjustment_stats', rows)
      return { ok: true, rows }
    },
  }
}

function cardPointOrNull(code) {
  if (!code) return null
  const rank = ((Number(code) - 1) % 13) + 1
  return rank >= 1 && rank <= 9 ? rank : 0
}

function sameRank(a, b) {
  if (!a || !b) return false
  return (((Number(a) - 1) % 13) + 1) === (((Number(b) - 1) % 13) + 1)
}

function numberOrZero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function moduloPoint(a, b) {
  if (a == null || b == null) return null
  return (Number(a) + Number(b)) % 10
}

function normalizeWinner(winner, playerPoint, bankerPoint) {
  if (winner === 1 || winner === '1' || winner === 'player') return 'player'
  if (winner === 2 || winner === '2' || winner === 'banker') return 'banker'
  if (winner === 3 || winner === '3' || winner === 'tie') return 'tie'
  if (playerPoint != null && bankerPoint != null) {
    if (playerPoint > bankerPoint) return 'player'
    if (bankerPoint > playerPoint) return 'banker'
    return 'tie'
  }
  return 'tie'
}

function compactTableSnapshot(table = {}) {
  return {
    tableId: table.tableId ?? null,
    displayName: table.displayName ?? null,
    shoe: table.shoe ?? null,
    round: table.round ?? null,
  }
}

function buildRoadFeatures(table = {}) {
  return {
    beadPlateRaw: table.beadPlateRaw ?? '',
    bigRoadRaw: table.bigRoadRaw ?? '',
    bigEyeRaw: table.bigEyeRaw ?? '',
    smallRoadRaw: table.smallRoadRaw ?? '',
    cockroachRaw: table.cockroachRaw ?? '',
    nextBankerRaw: table.nextBankerRaw ?? null,
    nextPlayerRaw: table.nextPlayerRaw ?? null,
  }
}

function buildUnknownRemainingPointCounts() {
  return Object.fromEntries(Array.from({ length: 10 }, (_, point) => [String(point), null]))
}

function buildTablePerformanceFeature(table = {}) {
  const directRate = normalizedRate(table.recentHitRate ?? table.tableRecentHitRate ?? table.recent_hit_rate)
  if (directRate != null) {
    return {
      recentHitRate: directRate,
      recentPredictionCount: numberOrNull(table.recentPredictionCount ?? table.recent_prediction_count),
      source: 'provided_recent_hit_rate',
      calculable: true,
    }
  }

  const hits = numberOrNull(table.recentHits ?? table.recent_hits)
  const misses = numberOrNull(table.recentMisses ?? table.recent_misses)
  const total = hits == null || misses == null ? null : hits + misses
  if (total && total > 0) {
    return {
      recentHitRate: roundRate(hits / total),
      recentPredictionCount: total,
      source: 'provided_recent_hits_misses',
      calculable: true,
    }
  }

  return {
    recentHitRate: null,
    recentPredictionCount: numberOrNull(table.recentPredictionCount ?? table.recent_prediction_count),
    source: 'unavailable',
    calculable: false,
  }
}

function applyShortRunTablePerformanceAdjustment({ predictedResult, probabilities, tablePerformance }) {
  const baseConfidence = probabilities[predictedResult] ?? 50
  const rate = tablePerformance.recentHitRate
  if (rate != null && rate < 0.45) {
    return {
      predictedResult,
      confidence: clampPercent(Math.min(50, baseConfidence), 30, 80),
    }
  }
  if (rate != null && rate > 0.65) {
    const boost = rate >= 0.80 ? 10 : 5
    return {
      predictedResult,
      confidence: clampPercent(baseConfidence + boost, 30, 80),
    }
  }
  return { predictedResult, confidence: clampPercent(baseConfidence, 30, 80) }
}

function buildShortRunAdjustmentSummary({ basePrediction, adjusted, tablePerformance }) {
  const rate = tablePerformance.recentHitRate
  if (rate != null && rate < 0.45) {
    return {
      rule: 'low_performance_confidence_cap',
      recentHitRate: rate,
      basePrediction,
      adjustedPrediction: adjusted.predictedResult,
      confidenceCap: 50,
    }
  }
  if (rate != null && rate > 0.65) {
    return {
      rule: 'high_performance_confidence_boost',
      recentHitRate: rate,
      basePrediction,
      adjustedPrediction: adjusted.predictedResult,
      confidenceBoost: rate >= 0.80 ? 10 : 5,
    }
  }
  return {
    rule: 'neutral_short_run_table_performance',
    recentHitRate: rate,
    basePrediction,
    adjustedPrediction: adjusted.predictedResult,
  }
}

function normalizedRate(value) {
  const parsed = numberOrNull(value)
  if (parsed == null) return null
  if (parsed > 1 && parsed <= 100) return roundRate(parsed / 100)
  if (parsed >= 0 && parsed <= 1) return roundRate(parsed)
  return null
}

function roundRate(value) {
  return Math.round(value * 10000) / 10000
}

function calculateInitialProbabilities(table = {}) {
  const banker = Number(table.bankerCount ?? 0)
  const player = Number(table.playerCount ?? 0)
  const tie = Number(table.tieCount ?? 0)
  const total = banker + player + tie
  if (!total) return { banker: 45, player: 45, tie: 10 }
  return {
    banker: Math.round((banker / total) * 100),
    player: Math.round((player / total) * 100),
    tie: Math.round((tie / total) * 100),
  }
}

function pickPrediction(probabilities) {
  if (probabilities.banker === probabilities.player) return 'banker'
  return probabilities.banker > probabilities.player ? 'banker' : 'player'
}


function toSnakeCase(value) {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

function redactSecrets(message = '') {
  return String(message)
    .replace(/token=([^\s&]+)/gi, 'token=[redacted]')
    .replace(/secret=([^\s&]+)/gi, 'secret=[redacted]')
    .replace(/(sb_secret_[A-Za-z0-9._-]+)/g, '[redacted]')
}
