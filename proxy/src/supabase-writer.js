import { buildRoundCardSnapshot, scoreCardShoeInfluence } from './card-shoe.js'
import { BUILD_VERSION } from './build-version.js'
import { isVerifiedFinalRoundAction, normalizeExactRealCardEvent } from '../../shared/real-card-validator.js'

const SOURCE = 'ofalive99'
const DEFAULT_STRATEGY_VERSION = 'v012_equal_weight_seed'
export const SHORT_RUN_STRATEGY_VERSION = 'v094_no_observe_confidence_30_70'
export const ALL_MT_EQUAL_STRATEGY_VERSION = 'v98'
export const V99_MAIN_SIGNAL_DEDUP_VERSION = 'v99_主預測靴內偏移去重版'
export const V100_SIDE_DEDUP_VERSION = 'v100_主副訊號去重與8副牌階完整性版'
const COMPATIBLE_PREDECESSOR_STRATEGY_VERSION = 'v098.20_六階段權重門檻整合版'

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
  'recent_practical_calibration', 'shoe_banker_player_bias',
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
  ask_road_signals: 0.25,
  roadmap_trend_signals: 0.45,
  recent_practical_calibration: 0.20,
  shoe_banker_player_bias: 0.10,
})

export const V99_MAIN_SIGNAL_DEDUP_WEIGHTS = ALL_MT_EQUAL_MAIN_WEIGHTS

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
    tie_risk: 0.45, tie_count: 0.10, shoe_stage: 0.10, road_chaos: 0.15, remaining_rank_total: 0.20,
  }),
  superSix: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    banker_point: 0.35, remaining_rank_total: 0.20, table_side_history: 0.35, shoe_stage: 0.10,
  }),
  bankerPair: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    remaining_rank_pressure: 0.15, table_side_history: 0.10, banker_pair_count: 0.20, shoe_stage: 0.20, pair_risk: 0.35,
  }),
  playerPair: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    remaining_rank_pressure: 0.20, table_side_history: 0.20, player_pair_count: 0.20, shoe_stage: 0.15, pair_risk: 0.25,
  }),
  bankerDragon: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    point_diff: 0.15, banker_natural: 0.10, banker_point: 0.35, remaining_rank_total: 0.30, big_road: 0.10,
  }),
  playerDragon: buildWeightedProfile(SIDE_WEIGHT_KEYS, {
    point_diff: 0.15, player_natural: 0.10, player_point: 0.35, remaining_rank_total: 0.30, big_road: 0.10,
  }),
})

export const ALL_MT_EQUAL_SIDE_WEIGHTS = SIDE_PREDICTION_WEIGHT_PROFILES.bankerPair

export const SIDE_PREDICTION_THRESHOLDS = {
  tie: 25,
  superSix: 45,
  bankerPair: 43,
  playerPair: 43,
  bankerDragon: 30,
  playerDragon: 30,
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
    status: 'archived',
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
    status: 'archived',
    sample_count: 0,
    weights: { ...SHORT_RUN_WEIGHTS },
    metrics: {
      mode: 'short_run_adjusted',
      auto_adjust: true,
      low_performance_threshold: 0.45,
      high_performance_threshold: 0.65,
      description: '短測桌況加權；低表現桌保留莊/閒方向但降信心，高表現桌小幅加信心且信心限制30-70，路單與問路權重小幅提高。',
    },
    notes: 'v049 no-observe confidence calibration for live round learning: every main row remains banker/player and confidence stays 30-70.',
  }
}

export function buildFormalActiveStrategy() {
  return {
    version: ALL_MT_EQUAL_STRATEGY_VERSION,
    status: 'active',
    sample_count: 0,
    weights: { ...SHORT_RUN_WEIGHTS },
    metrics: {
      mode: 'formal_live_prediction',
      auto_adjust: false,
      main_weights: { ...ALL_MT_EQUAL_MAIN_WEIGHTS },
      side_weights: Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, profile]) => [key, { ...profile }])),
      side_thresholds: { ...SIDE_PREDICTION_THRESHOLDS },
      description: 'v98 正式主副預測；主權重25/45/20/10，副門檻25/45/43/43/30/30，舊策略僅保留歷史。',
    },
    notes: 'Only active runtime strategy for formal release v98.',
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
    remaining_rank_counts: round.lastRound?.cardShoe?.remainingRankCounts ?? round.cardShoe?.remainingRankCounts ?? {},
    remaining_point_counts: round.lastRound?.cardShoe?.remainingPointCounts ?? round.cardShoe?.remainingPointCounts ?? buildUnknownRemainingPointCounts(),
  }
}

export function buildPredictionResultRow(round = {}, table = {}, precomputedPrediction = null) {
  const target = validatePredictionTarget(precomputedPrediction, round)
  if (!target) return null
  const facts = deriveBaccaratRoundFacts(round)
  const predicted_result = precomputedPrediction.predictedResult
  const sideActions = structuredClone(precomputedPrediction.sideActions)
  const sideActualResults = buildSideActualResults(round, facts)
  const predictionFeatures = structuredClone(precomputedPrediction.predictionFeatures)
  return {
    source: SOURCE,
    table_id: target.tableId,
    shoe_no: target.shoe,
    round_no: target.round,
    strategy_version: precomputedPrediction.strategyVersion,
    predicted_result,
    confidence: precomputedPrediction.confidence,
    actual_result: facts.winner,
    is_hit: predicted_result === facts.winner,
    table_recent_hit_rate: precomputedPrediction.tableRecentHitRate,
    table_recent_prediction_count: precomputedPrediction.tableRecentPredictionCount,
    short_run_adjustment: structuredClone(precomputedPrediction.shortRunAdjustment),
    prediction_features: {
      ...predictionFeatures,
      settlement_final: isVerifiedFinalRoundAction(round.sourceAction),
      settlement_source_action: round.sourceAction ?? null,
      side_actual_results: sideActualResults,
      side_hits: buildSideHitsFromActions(sideActions, sideActualResults),
    },
    probabilities: structuredClone(precomputedPrediction.probabilities),
    feature_weights: structuredClone(precomputedPrediction.featureWeights),
    resolved_at: new Date().toISOString(),
  }
}

export function buildCompactRoadmapEventDbRow(row = {}) {
  const raw = row.raw_event && typeof row.raw_event === 'object' ? row.raw_event : {}
  return {
    source: row.source,
    table_id: row.table_id,
    shoe_no: row.shoe_no,
    round_no: row.round_no,
    main_result: row.main_result,
    banker_points: row.banker_points,
    player_points: row.player_points,
    banker_pair: row.banker_pair,
    player_pair: row.player_pair,
    super_six: row.super_six,
    banker_dragon: row.banker_dragon,
    player_dragon: row.player_dragon,
    player_card_codes: row.player_card_codes,
    banker_card_codes: row.banker_card_codes,
    player_card_points: row.player_card_points,
    banker_card_points: row.banker_card_points,
    player_card_ranks: row.player_card_ranks,
    banker_card_ranks: row.banker_card_ranks,
    player_card_faces: row.player_card_faces,
    banker_card_faces: row.banker_card_faces,
    player_drew: row.player_drew,
    banker_drew: row.banker_drew,
    player_natural: row.player_natural,
    banker_natural: row.banker_natural,
    bead_code: row.bead_code,
    raw_event: {
      sourceAction: raw.sourceAction ?? null,
      rawResult: raw.rawResult ?? null,
    },
    remaining_rank_counts: row.remaining_rank_counts ?? {},
    remaining_point_counts: row.remaining_point_counts ?? null,
  }
}

export function buildCompactPredictionResultDbRow(row = {}) {
  const features = row.prediction_features && typeof row.prediction_features === 'object' ? row.prediction_features : {}
  return {
    source: row.source,
    table_id: row.table_id,
    shoe_no: row.shoe_no,
    round_no: row.round_no,
    strategy_version: row.strategy_version,
    predicted_result: row.predicted_result,
    confidence: row.confidence,
    actual_result: row.actual_result,
    is_hit: row.is_hit,
    table_recent_hit_rate: row.table_recent_hit_rate,
    table_recent_prediction_count: row.table_recent_prediction_count,
    short_run_adjustment: {
      rule: row.short_run_adjustment?.rule ?? null,
      includedMainWeightCount: row.short_run_adjustment?.includedMainWeightCount ?? null,
      includedSideWeightCount: row.short_run_adjustment?.includedSideWeightCount ?? null,
      sideActionRateTargets: row.short_run_adjustment?.sideActionRateTargets ?? null,
      sideTargetHitRate: row.short_run_adjustment?.sideTargetHitRate ?? null,
      baseProbabilities: row.short_run_adjustment?.baseProbabilities ?? row.probabilities ?? null,
    },
    prediction_features: structuredClone(features),
    probabilities: row.probabilities,
    resolved_at: row.resolved_at,
  }
}

export function buildPredictionIssuanceDbRow(prediction = {}) {
  return {
    source: SOURCE,
    table_id: String(prediction.targetTableId ?? ''),
    shoe_no: prediction.targetShoe == null ? null : String(prediction.targetShoe),
    round_no: Number(prediction.targetRound ?? 0),
    strategy_version: prediction.strategyVersion,
    predicted_result: prediction.predictedResult,
    confidence: prediction.confidence,
    actual_result: null,
    is_hit: null,
    table_recent_hit_rate: prediction.tableRecentHitRate ?? null,
    table_recent_prediction_count: prediction.tableRecentPredictionCount ?? null,
    short_run_adjustment: structuredClone(prediction.shortRunAdjustment ?? {}),
    prediction_features: structuredClone(prediction.predictionFeatures ?? {}),
    probabilities: structuredClone(prediction.probabilities ?? {}),
    resolved_at: null,
    issued_prediction_payload: structuredClone(prediction),
  }
}

function compactPredictionFeatureSummary({ row = {}, derived = {}, mt = {} } = {}) {
  return {
    table: {
      tableId: mt.tableId ?? row.table_id ?? null,
      tableType: mt.tableType ?? null,
      shoe: mt.shoe ?? row.shoe_no ?? null,
      round: mt.round ?? row.round_no ?? null,
      bankerCount: mt.bankerCount ?? null,
      playerCount: mt.playerCount ?? null,
      tieCount: mt.tieCount ?? null,
      bankerPairCount: mt.bankerPairCount ?? null,
      playerPairCount: mt.playerPairCount ?? null,
    },
    main: {
      predictedResult: row.predicted_result ?? null,
      actualResult: row.actual_result ?? null,
      confidence: row.confidence ?? null,
      isHit: row.is_hit ?? null,
      directionCalibration: derived.directionCalibration ?? null,
      probabilityGap: derived.probabilityGap ?? null,
    },
    road: {
      shoeStage: derived.shoeStage ?? null,
      previousWinner: derived.previousWinner ?? null,
      streakLength: derived.streakLength ?? null,
      near5BankerPlayerBias: derived.near5BankerPlayerBias ?? null,
      roadTrend: derived.roadTrend ?? null,
      roadmapTrendSignals: derived.roadmapTrendSignals ?? null,
      roadStructureSignals: derived.roadStructureSignals ?? null,
      derivedRoadStructureSignals: derived.derivedRoadStructureSignals ?? null,
      askRoadSignals: derived.askRoadSignals ?? null,
    },
    calibration: {
      tableRecentHitRate: derived.tableRecentHitRate ?? row.table_recent_hit_rate ?? null,
      recentPracticalCalibration: derived.recentPracticalCalibration ?? null,
      shoeBankerPlayerBias: derived.shoeBankerPlayerBias ?? null,
    },
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
    recentPracticalCalibration: buildRecentPracticalCalibration(tablePerformance, probabilities),
    shoeBankerPlayerBias: buildShoeBankerPlayerBias(table),
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
  const rawSignalConfidence = difference < 1e-9 ? 30 : calculateConservativeMainConfidence(scores, ALL_MT_EQUAL_MAIN_WEIGHTS)
  const confidenceCalibration = calibrateMainConfidenceByHitRate(rawSignalConfidence, tablePerformance)
  return { predictedResult, confidence: confidenceCalibration.finalConfidence, confidenceCalibration, scores, total }
}

export function calculateV99MainPredictionShadow({ round = {}, table = {}, facts = {}, probabilities = {}, tablePerformance = {} } = {}) {
  const prepared = prepareV99SignalInputs(table)
  const safeTable = prepared.table
  const derived = buildDerivedMainFeatures(round, safeTable, facts, probabilities, tablePerformance)
  const roadFeatures = buildRoadFeatures(safeTable)
  const scores = Object.fromEntries(Object.keys(V99_MAIN_SIGNAL_DEDUP_WEIGHTS).map((key) => [key, scoreAllMtFeature(key, { round, facts, table: safeTable, probabilities, tablePerformance, derived, roadFeatures })]))
  const originalShoeScore = scores.shoe_banker_player_bias
  const askRoadScore = scores.ask_road_signals
  const adjustment = deduplicateShoeBankerPlayerBias(
    prepared.askRoadValid ? askRoadScore : { banker: Number.NaN, player: Number.NaN },
    prepared.shoeBiasValid ? originalShoeScore : { banker: Number.NaN, player: Number.NaN },
  )
  scores.shoe_banker_player_bias = adjustment.adjustedScore
  const total = Object.entries(V99_MAIN_SIGNAL_DEDUP_WEIGHTS).reduce((acc, [key, weight]) => {
    const score = scores[key] ?? neutralScore()
    acc.banker += score.banker * weight
    acc.player += score.player * weight
    return acc
  }, { banker: 0, player: 0 })
  const difference = Math.abs(total.banker - total.player)
  const predictedResult = difference < 1e-9 ? breakAllMtMainTie({ round, table: safeTable, facts, probabilities }) : (total.banker > total.player ? 'banker' : 'player')
  const rawSignalConfidence = difference < 1e-9 ? 30 : calculateConservativeMainConfidence(scores, V99_MAIN_SIGNAL_DEDUP_WEIGHTS)
  const confidenceCalibration = calibrateMainConfidenceByHitRate(rawSignalConfidence, tablePerformance)
  return {
    strategyVersion: V99_MAIN_SIGNAL_DEDUP_VERSION,
    predictedResult,
    confidence: confidenceCalibration.finalConfidence,
    confidenceCalibration,
    scores,
    total,
    featureWeights: { ...V99_MAIN_SIGNAL_DEDUP_WEIGHTS },
    diagnostics: {
      shoeBankerPlayerBias: {
        originalScore: { ...originalShoeScore },
        adjustedScore: { ...adjustment.adjustedScore },
        askRoadMargin: adjustment.askRoadMargin,
        originalShoeMargin: adjustment.originalShoeMargin,
        sharedComponentMargin: adjustment.sharedComponentMargin,
        residualMargin: adjustment.residualMargin,
        deduplicated: adjustment.deduplicated,
      },
    },
  }
}

function prepareV99SignalInputs(table) {
  const tableIsObject = Boolean(table) && typeof table === 'object' && !Array.isArray(table)
  const safeTable = tableIsObject ? { ...table } : {}
  const askRoadValid = tableIsObject
    && isValidV99AskRoadInput(safeTable.nextBankerRaw)
    && isValidV99AskRoadInput(safeTable.nextPlayerRaw)
  const shoeBiasValid = tableIsObject
    && isValidV99Count(safeTable.bankerCount)
    && isValidV99Count(safeTable.playerCount)
  if (!askRoadValid) {
    safeTable.nextBankerRaw = null
    safeTable.nextPlayerRaw = null
  }
  if (!shoeBiasValid) {
    safeTable.bankerCount = 0
    safeTable.playerCount = 0
  }
  return { table: safeTable, askRoadValid, shoeBiasValid }
}

function isValidV99AskRoadInput(value) {
  if (value == null || value === '') return true
  if (typeof value === 'string') return true
  if (typeof value !== 'object') return false
  try {
    return typeof JSON.stringify(value) === 'string'
  } catch {
    return false
  }
}

function isValidV99Count(value) {
  if (value == null || value === '') return true
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

function deduplicateShoeBankerPlayerBias(askRoadScore = {}, shoeScore = {}) {
  const askRoadMargin = signedScoreMargin(askRoadScore)
  const originalShoeMargin = signedScoreMargin(shoeScore)
  if (askRoadMargin == null || originalShoeMargin == null) {
    return {
      adjustedScore: neutralScore(),
      askRoadMargin: askRoadMargin ?? 0,
      originalShoeMargin: originalShoeMargin ?? 0,
      sharedComponentMargin: 0,
      residualMargin: 0,
      deduplicated: false,
    }
  }
  const sameDirection = Math.sign(askRoadMargin) !== 0 && Math.sign(askRoadMargin) === Math.sign(originalShoeMargin)
  const sharedComponentMargin = sameDirection
    ? roundSignalMargin(Math.sign(originalShoeMargin) * Math.min(Math.abs(originalShoeMargin), Math.abs(askRoadMargin)))
    : 0
  const residualMargin = roundSignalMargin(Math.max(-0.10, Math.min(0.10, sameDirection
    ? Math.sign(originalShoeMargin) * Math.max(Math.abs(originalShoeMargin) - Math.abs(askRoadMargin), 0)
    : originalShoeMargin)))
  return {
    adjustedScore: {
      banker: roundSignalMargin((1 + residualMargin) / 2),
      player: roundSignalMargin((1 - residualMargin) / 2),
    },
    askRoadMargin,
    originalShoeMargin,
    sharedComponentMargin,
    residualMargin,
    deduplicated: sameDirection,
  }
}

function signedScoreMargin(score = {}) {
  const banker = Number(score?.banker)
  const player = Number(score?.player)
  if (!Number.isFinite(banker) || !Number.isFinite(player)) return null
  return roundSignalMargin(banker - player)
}

function roundSignalMargin(value) {
  return Number(Number(value).toFixed(12))
}

export function buildLivePrediction(table = {}) {
  const probabilities = calculateInitialProbabilities(table)
  const tablePerformance = buildTablePerformanceFeature(table)
  const nextRound = {
    tableId: table.tableId,
    shoe: table.shoe,
    round: Number(table.round ?? 0) + 1,
    lastRound: table.lastRound ?? null,
    cardShoe: table.cardShoe ?? null,
  }
  const prediction = calculateAllMtEqualMainPrediction({
    round: nextRound,
    table,
    facts: {},
    probabilities,
    tablePerformance,
  })
  const sidePredictions = buildSidePredictions(table, nextRound)
  const sideActions = buildSideActions(sidePredictions, prediction.predictedResult)
  const preResultFacts = deriveBaccaratRoundFacts(table.lastRound ?? {})
  const predictionFeatures = {
    prediction_timing: 'pre_result_context',
    mt_context: buildMtContextFeatures(table),
    derived_main_features: buildDerivedMainFeatures(nextRound, table, preResultFacts, probabilities, tablePerformance),
    unified_main_scores: structuredClone(prediction.scores),
    road_features: buildRoadFeatures(table),
    card_shoe_features: scoreCardShoeInfluence({ lastRound: table.lastRound ?? {}, shoeState: table.cardShoe ?? null }).features,
    side_card_rank_features: buildSideCardRankFeatures(table.cardShoe ?? null),
    side_prediction_rank_inputs: buildSidePredictionRankInputs(table.cardShoe ?? null),
    point_features: {
      playerPoint: preResultFacts.playerPoint,
      bankerPoint: preResultFacts.bankerPoint,
      pointDiff: preResultFacts.pointDiff,
      playerDrew: preResultFacts.playerDrew,
      bankerDrew: preResultFacts.bankerDrew,
      playerNatural: preResultFacts.playerNatural,
      bankerNatural: preResultFacts.bankerNatural,
    },
    side_weights: Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, profile]) => [key, { ...profile }])),
    side_tuning: Object.fromEntries(Object.entries(SIDE_PREDICTION_ACTION_RATE_TARGETS).map(([key, targetActionRate]) => [key, { targetActionRate, targetHitRate: SIDE_PREDICTION_TARGET_HIT_RATE }])),
    side_predictions: structuredClone(sidePredictions),
    side_actions: structuredClone(sideActions),
    side_results: { superSix: false, bankerDragon: false, playerDragon: false, bankerPair: false, playerPair: false },
    table_performance: structuredClone(tablePerformance),
    confidence_calibration: structuredClone(prediction.confidenceCalibration),
  }
  return {
    source: 'backend',
    buildVersion: BUILD_VERSION,
    strategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION,
    targetTableId: String(table.tableId ?? ''),
    targetShoe: table.shoe == null ? null : String(table.shoe),
    targetRound: nextRound.round,
    predictedResult: prediction.predictedResult,
    confidence: prediction.confidence,
    probabilities,
    scoreTotals: prediction.total,
    scoreSources: prediction.scores,
    sidePredictions,
    sideActions,
    tableRecentHitRate: tablePerformance.recentHitRate,
    tableRecentPredictionCount: tablePerformance.recentPredictionCount,
    shortRunAdjustment: {
      rule: ALL_MT_EQUAL_STRATEGY_VERSION,
      includedMainWeightCount: Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).length,
      includedSideWeightCount: Object.keys(SIDE_WEIGHT_KEYS).length,
      sideActionRateTargets: structuredClone(SIDE_PREDICTION_ACTION_RATE_TARGETS),
      sideTargetHitRate: SIDE_PREDICTION_TARGET_HIT_RATE,
      baseProbabilities: structuredClone(probabilities),
    },
    predictionFeatures,
    featureWeights: { ...ALL_MT_EQUAL_MAIN_WEIGHTS },
  }
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

function calculateConservativeMainConfidence(scores = {}, weights = {}) {
  let activeWeight = 0
  let agreementSum = 0
  let strengthSum = 0
  for (const [key, rawWeight] of Object.entries(weights)) {
    const weight = Math.max(0, Number(rawWeight ?? 0))
    if (!weight) continue
    const score = scores[key] ?? neutralScore()
    const banker = Math.max(0, Number(score.banker ?? 0.5))
    const player = Math.max(0, Number(score.player ?? 0.5))
    const total = banker + player
    const share = total > 0 ? banker / total : 0.5
    const edge = Math.abs(share - 0.5) * 2
    const signedEdge = share >= 0.5 ? edge : -edge
    activeWeight += weight
    agreementSum += weight * signedEdge
    strengthSum += weight * edge
  }
  if (!activeWeight) return 30
  const agreement = Math.abs(agreementSum) / activeWeight
  const strength = strengthSum / activeWeight
  const combined = clampPercent((agreement * 0.7 + strength * 0.3) * 100, 0, 100) / 100
  return 30 + 40 * combined
}

export function calibrateMainConfidenceByHitRate(rawSignalConfidence, tablePerformance = {}) {
  const signal = clampPercent(Number(rawSignalConfidence), 30, 70)
  const recentHitRate = normalizedRate(tablePerformance.recentHitRate ?? tablePerformance.recent_hit_rate)
  const recentPredictionCount = numberOrNull(tablePerformance.recentPredictionCount ?? tablePerformance.recent_prediction_count)
  const signalAdjustment = (signal - 50) * 0.2
  if (recentHitRate == null || recentPredictionCount == null || recentPredictionCount < 6) {
    return {
      rawSignalConfidence: signal,
      finalConfidence: Math.round(clampPercent(50 + signalAdjustment, 30, 70)),
      reason: 'learning-neutral-shrinkage',
      recentHitRate,
      recentPredictionCount,
      reliability: 0,
    }
  }
  const reliability = Math.min(1, Math.max(0, recentPredictionCount / 18))
  const empiricalCenter = 50 + (recentHitRate * 100 - 50) * reliability
  return {
    rawSignalConfidence: signal,
    finalConfidence: Math.round(clampPercent(empiricalCenter + signalAdjustment, 30, 70)),
    reason: 'settled-hit-rate-calibration',
    recentHitRate,
    recentPredictionCount,
    reliability: Math.round(reliability * 1000) / 1000,
  }
}

export function calibrateMainConfidenceV096(rawConfidence) {
  return Math.round(clampPercent(45 + 2 * (Number(rawConfidence) - 32.03), 30, 70))
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
    case 'recent_practical_calibration': return scoreRecentPracticalCalibrationFeature(probabilities, tablePerformance)
    case 'shoe_banker_player_bias': return scoreShoeBankerPlayerBiasFeature(table)
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

function buildRecentPracticalCalibration(tablePerformance = {}, probabilities = {}) {
  const score = scoreRecentPracticalCalibrationFeature(probabilities, tablePerformance)
  return {
    recentHitRate: tablePerformance.recentHitRate ?? null,
    recentPredictionCount: tablePerformance.recentPredictionCount ?? null,
    source: tablePerformance.source ?? 'unavailable',
    preferred: score.banker > score.player ? 'banker' : score.player > score.banker ? 'player' : 'neutral',
    banker: score.banker,
    player: score.player,
  }
}

function scoreRecentPracticalCalibrationFeature(probabilities = {}, tablePerformance = {}) {
  const count = numberOrZero(tablePerformance.recentPredictionCount)
  const rate = tablePerformance.recentHitRate
  if (rate == null || count < 6) return neutralScore()
  const baseSide = pickPrediction(probabilities)
  if (rate >= 0.58) return winnerScore(baseSide)
  if (rate <= 0.45) return invertWinnerScore(baseSide)
  return averageScores(winnerScore(baseSide), neutralScore())
}

function buildShoeBankerPlayerBias(table = {}) {
  const score = scoreShoeBankerPlayerBiasFeature(table)
  const banker = numberOrZero(table.bankerCount)
  const player = numberOrZero(table.playerCount)
  return {
    bankerCount: banker,
    playerCount: player,
    gap: banker - player,
    preferred: score.banker > score.player ? 'banker' : score.player > score.banker ? 'player' : 'neutral',
    banker: score.banker,
    player: score.player,
  }
}

function scoreShoeBankerPlayerBiasFeature(table = {}) {
  const banker = numberOrZero(table.bankerCount)
  const player = numberOrZero(table.playerCount)
  const total = banker + player
  if (total < 8 || banker === player) return neutralScore()
  const gap = Math.abs(banker - player) / total
  if (gap < 0.08) return neutralScore()
  const bump = Math.min(0.08, gap * 0.5)
  return banker > player ? { banker: 0.5 + bump, player: 0.5 - bump } : { banker: 0.5 - bump, player: 0.5 + bump }
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
  const parsed = scoreFiveRoadPayload(raw)
  if (parsed) return parsed
  if (!raw) return neutralScore()
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const filled = text.replace(/[,#\s]/g, '').length
  const bump = Math.min(0.08, filled / 2000)
  return side === 'banker' ? { banker: 0.5 + bump, player: 0.5 - bump } : { banker: 0.5 - bump, player: 0.5 + bump }
}

function scoreFiveRoadPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const roadValue = (...keys) => keys.map((key) => raw[key]).find((value) => value != null && value !== '')
  const scores = []
  const bead = roadValue('bead_plate', 'beadPlateRaw', 'beadPlate', 'bead')
  const big = roadValue('big', 'bigRoadRaw', 'bigRoad')
  const bigEye = roadValue('big_eye', 'bigEyeRaw', 'bigEye')
  const small = roadValue('small', 'smallRoadRaw', 'smallRoad')
  const cockroach = roadValue('cockroach', 'cockroachRaw', 'cockroachRoad')
  if (bead) scores.push(roadStringScore(bead))
  if (big) scores.push(roadStringScore(big))
  if (bigEye) scores.push(roadColorScore(bigEye))
  if (small) scores.push(roadColorScore(small))
  if (cockroach) scores.push(roadColorScore(cockroach))
  return scores.length ? averageScores(...scores) : null
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

export function calculateV100SidePredictionShadow({
  table = {},
  round = {},
  primitives: primitiveOverrides = null,
  rankAvailable: rankAvailableOverride,
  rankFallback,
  mainPrediction = null,
  v98SidePredictions: v98Overrides = null,
} = {}) {
  const featureScores = primitiveOverrides == null ? buildSideFeatureScores(table, round) : null
  const sourcePrimitives = primitiveOverrides ?? {
    T: featureScores.tie_count,
    B: featureScores.banker_point,
    P: featureScores.player_point,
    R: featureScores.remaining_rank_total,
    S: featureScores.shoe_stage,
    Q: featureScores.remaining_rank_pressure,
    XB: featureScores.banker_pair_count,
    XP: featureScores.player_pair_count,
    DB: featureScores.banker_dragon,
    DP: featureScores.player_dragon,
  }
  const inferredRankAvailable = primitiveOverrides == null
    ? hasCompleteRemainingRankCounts(round.cardShoe?.remainingRankCounts)
    : isAvailableRankValue(sourcePrimitives.Q) && isAvailableRankValue(sourcePrimitives.R)
  const rankAvailable = rankAvailableOverride == null ? inferredRankAvailable : Boolean(rankAvailableOverride)
  if (!rankAvailable && !['neutral', 'renormalize'].includes(rankFallback)) {
    throw new TypeError("rankFallback must be 'neutral' or 'renormalize' when rank is unavailable")
  }
  if (rankAvailable && rankFallback != null && !['neutral', 'renormalize'].includes(rankFallback)) {
    throw new TypeError("rankFallback must be 'neutral' or 'renormalize'")
  }

  const primitives = Object.fromEntries(['T', 'B', 'P', 'R', 'S', 'Q', 'XB', 'XP', 'DB', 'DP']
    .map((key) => [key, rankAvailable || !['Q', 'R'].includes(key) ? clampSideScore(sourcePrimitives[key]) : 50]))
  primitives.A = clampSideScore(100 - Math.abs(primitives.B - primitives.P))
  primitives.Hpair = clampSideScore(Math.max(primitives.T, primitives.DB, primitives.DP))
  const bankerPairResidual = clampSideScore(Math.max(0, clampSideScore(2.4 * primitives.XP) - clampSideScore(2.4 * primitives.XB)))
  const playerPairResidual = clampSideScore(Math.max(0, clampSideScore(2.4 * primitives.XB) - clampSideScore(2.4 * primitives.XP)))
  const bankerDragonShared = clampSideScore(Math.min(primitives.DB, 0.7 * primitives.B))
  const bankerDragonResidual = clampSideScore(Math.max(0, primitives.DB - bankerDragonShared))
  primitives.H6 = clampSideScore(Math.max(primitives.T, primitives.XB, primitives.XP, bankerDragonResidual, primitives.DP))

  const omitRank = !rankAvailable && rankFallback === 'renormalize'
  const tie = weightedShadowScore({ T: primitives.T, A: primitives.A, S: primitives.S, R: primitives.R }, {
    T: 0.5068331143232588, A: 0.1931668856767411, S: 0.10, R: 0.20,
  }, omitRank ? ['R'] : [])
  const bankerPair = weightedShadowScore({ Q: primitives.Q, S: primitives.S, XB: primitives.XB, RB: bankerPairResidual, Hpair: primitives.Hpair }, {
    Q: 0.15, S: 0.20, XB: 0.20, RB: 0.35, Hpair: 0.10,
  }, omitRank ? ['Q'] : [])
  const playerPair = weightedShadowScore({ Q: primitives.Q, S: primitives.S, XP: primitives.XP, RP: playerPairResidual, Hpair: primitives.Hpair }, {
    Q: 0.20, S: 0.15, XP: 0.20, RP: 0.25, Hpair: 0.20,
  }, omitRank ? ['Q'] : [])
  const superSix = weightedShadowScore({ B: primitives.B, H6: primitives.H6, R: primitives.R, S: primitives.S }, {
    B: 0.35, H6: 0.35, R: 0.20, S: 0.10,
  }, omitRank ? ['R'] : [])
  const v98SidePredictions = v98Overrides ?? buildSidePredictions(table, round)
  const predictions = {
    tie: tie.score,
    superSix: superSix.score,
    bankerPair: bankerPair.score,
    playerPair: playerPair.score,
    bankerDragon: clampSideScore(v98SidePredictions.bankerDragon),
    playerDragon: clampSideScore(v98SidePredictions.playerDragon),
  }
  return {
    strategyVersion: V100_SIDE_DEDUP_VERSION,
    predictions,
    actions: buildV100SideShadowActions(predictions, mainPrediction),
    diagnostics: {
      primitives,
      residuals: {
        bankerPair: bankerPairResidual,
        playerPair: playerPairResidual,
        bankerDragonShared,
        bankerDragonResidual,
      },
      rank: {
        available: rankAvailable,
        fallback: rankAvailable ? null : rankFallback,
        substituted: rankAvailable ? null : { Q: 50, R: 50 },
      },
      effectiveCoefficients: {
        tie: tie.effectiveCoefficients,
        bankerPair: bankerPair.effectiveCoefficients,
        playerPair: playerPair.effectiveCoefficients,
        superSix: superSix.effectiveCoefficients,
        bankerDragon: { ...SIDE_PREDICTION_WEIGHT_PROFILES.bankerDragon },
        playerDragon: { ...SIDE_PREDICTION_WEIGHT_PROFILES.playerDragon },
      },
    },
  }
}

export function buildV100SideShadowActions(predictions = {}, mainPrediction = null) {
  return buildSideActions(predictions, mainPrediction)
}

function weightedShadowScore(values, coefficients, omittedKeys = []) {
  const omitted = new Set(omittedKeys)
  const activeWeight = Object.entries(coefficients).reduce((sum, [key, weight]) => sum + (omitted.has(key) ? 0 : weight), 0)
  const effectiveCoefficients = Object.fromEntries(Object.entries(coefficients).map(([key, weight]) => [
    key,
    omitted.has(key) || !activeWeight ? 0 : weight / activeWeight,
  ]))
  const score = Object.entries(effectiveCoefficients)
    .reduce((sum, [key, weight]) => sum + clampSideScore(values[key]) * weight, 0)
  return { score: clampSideScore(score), effectiveCoefficients }
}

function clampSideScore(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0
}

function hasCompleteRemainingRankCounts(counts) {
  return Boolean(counts) && typeof counts === 'object' && !Array.isArray(counts)
    && RANK_REMAINING_FACES.every((face) => isAvailableRankValue(counts[face]) && Number(counts[face]) >= 0)
}

function isAvailableRankValue(value) {
  return value != null && value !== '' && Number.isFinite(Number(value))
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
    tie: facts.winner === 'tie',
    superSix: Boolean(facts.superSix),
    bankerPair: Boolean(facts.bankerPair),
    playerPair: Boolean(facts.playerPair),
    bankerDragon: Boolean(facts.bankerDragon),
    playerDragon: Boolean(facts.playerDragon),
  }
}

function buildSideHits(predictions = {}, actual = {}, mainPrediction = null) {
  const actions = buildSideActions(predictions, mainPrediction)
  return buildSideHitsFromActions(actions, actual)
}

function buildSideHitsFromActions(actions = {}, actual = {}) {
  return Object.fromEntries(Object.keys(SIDE_PREDICTION_THRESHOLDS).map((key) => [key, Boolean(actions[key]) && Boolean(actual[key])]))
}

export function buildSideActions(predictions = {}, mainPrediction = null) {
  const actions = Object.fromEntries(Object.entries(SIDE_PREDICTION_THRESHOLDS).map(([key, threshold]) => [key, Number(predictions[key] ?? 0) >= threshold]))
  const bankerDragon = Number(predictions.bankerDragon ?? 0)
  const playerDragon = Number(predictions.playerDragon ?? 0)
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

export function buildOperationalEventRow({
  eventLayer = null,
  eventSeverity = 'info',
  eventComponent = null,
  eventKind = null,
  eventStatusCode = null,
  eventMessage = '',
  eventAt = new Date().toISOString(),
  eventMetadata = {},
} = {}) {
  return {
    event_layer: eventLayer,
    severity: eventSeverity,
    component: eventComponent,
    event_kind: eventKind,
    status_code: eventStatusCode == null ? null : Number(eventStatusCode),
    message: redactSecrets(eventMessage),
    occurred_at: eventAt,
    metadata: eventMetadata,
  }
}

export function buildCloudTableSnapshotRow({ sessionId = null, tables = [], status = {}, metadata = {} } = {}) {
  const safeTables = Array.isArray(tables) ? tables.map(enrichTableWithLivePrediction) : []
  return {
    session_id: sessionId,
    capture_source: status.captureSource ?? status.captureMode ?? 'offline',
    table_count: safeTables.length,
    tables: safeTables,
    table_summary: [],
    snapshot_at: new Date().toISOString(),
    metadata: {
      ...metadata,
      connectionState: {
        connected: status.connected === true,
        authenticated: status.authenticated === true,
      },
    },
  }
}

function enrichTableWithLivePrediction(table = {}) {
  if (table.prediction?.source === 'backend' && Number.isFinite(Number(table.prediction.confidence))) {
    return { ...table, buildVersion: BUILD_VERSION, prediction: { ...table.prediction, buildVersion: BUILD_VERSION } }
  }
  try {
    return { ...table, buildVersion: BUILD_VERSION, prediction: buildLivePrediction(table) }
  } catch {
    return { ...table, buildVersion: BUILD_VERSION }
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
    raw_summary: buildCompactStrategyReportSummary(report),
    metadata: compactReportMetadata(metadata),
  }
}

function buildCompactStrategyReportSummary(report = {}) {
  const raw = report.rawSummary ?? report.raw_summary ?? {}
  const total = report.total ?? raw.total ?? {}
  const tables = Array.isArray(report.tables) ? report.tables : Array.isArray(raw.tables) ? raw.tables : []
  return pruneEmpty({
    title: report.title ?? raw.title ?? null,
    reportType: report.reportType ?? report.report_type ?? raw.reportType ?? raw.report_type ?? null,
    strategyVersion: report.strategyVersion ?? report.strategy_version ?? report.version ?? raw.strategyVersion ?? raw.strategy_version ?? null,
    startedAt: report.startedAt ?? report.started_at ?? raw.startedAt ?? raw.started_at ?? null,
    endedAt: report.endedAt ?? report.ended_at ?? raw.endedAt ?? raw.ended_at ?? null,
    generatedAt: report.generatedAt ?? report.generated_at ?? raw.generatedAt ?? raw.generated_at ?? null,
    total: {
      rounds: numberOrZero(total.rounds ?? report.rounds),
      hits: numberOrZero(total.hits ?? report.hits),
      misses: numberOrZero(total.misses ?? report.misses),
      pushes: numberOrZero(total.pushes ?? report.pushes),
      mainEvaluated: numberOrZero(total.mainEvaluated ?? total.main_evaluated ?? report.mainEvaluated),
      hitRate: numberOrNull(total.hitRate ?? total.mainHitRate ?? total.main_hit_rate ?? report.mainHitRate),
    },
    tableCount: tables.length || numberOrZero(report.tableCount ?? raw.tableCount),
    tables: tables.slice(0, 32).map((table = {}) => pruneEmpty({
      tableId: table.tableId ?? table.table_id ?? null,
      displayName: table.displayName ?? table.display_name ?? null,
      rounds: numberOrZero(table.rounds),
      hits: numberOrZero(table.hits),
      misses: numberOrZero(table.misses),
      pushes: numberOrZero(table.pushes),
      hitRate: numberOrNull(table.hitRate ?? table.mainHitRate ?? table.main_hit_rate),
    })),
  })
}

function compactReportMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const blocked = new Set(['events', 'rounds', 'rawSummary', 'raw_summary', 'report', 'tables', 'diagnostics', 'lastDiagnostics'])
  return Object.fromEntries(Object.entries(metadata).flatMap(([key, value]) => {
    if (blocked.has(key)) return []
    const compact = compactMetadataValue(value)
    return compact === undefined ? [] : [[key, compact]]
  }))
}

function compactMetadataValue(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (Array.isArray(value)) {
    if (value.length > 20) return undefined
    return value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item)) ? value : undefined
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, nested]) => nested == null || ['string', 'number', 'boolean'].includes(typeof nested))
      .slice(0, 20)
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return undefined
}

function pruneEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item == null) return false
    if (Array.isArray(item)) return item.length > 0
    if (typeof item === 'object') return Object.keys(item).length > 0
    return true
  }))
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
  retryAttempts = 3,
  retryDelayMs = 250,
  requireVerifiedStrategy = process.env.NODE_ENV === 'production',
  maxCompletedRoundKeys = 10000,
  now = Date.now,
  captureStatusHeartbeatMs = 60000,
  snapshotHeartbeatMs = 60000,
} = {}) {
  const configured = Boolean(url && serviceKey && fetchImpl)
  const completedRoundKeys = new Set()
  const inFlightRoundWrites = new Map()
  const preparedRoundWrites = new Map()
  const captureStatusWrites = new Map()
  const snapshotWrites = new Map()
  let runtimeStatus = { ready: false, degraded: false, reason: 'active_strategy_not_verified', activeStrategyVersion: null }
  let writeQueue = Promise.resolve()
  const completedRoundKeyLimit = Math.max(1, Number(maxCompletedRoundKeys) || 10000)

  async function postRest(path, body, conflict, { requireRepresentation = false, requireObject = false, allowSuppressedRepresentation = false } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase backend key is not configured' }
    const endpoint = new URL(`/rest/v1/${path}`, url)
    if (conflict) endpoint.searchParams.set('on_conflict', conflict)
    return withRetry(async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          ['api' + 'key']: serviceKey,
          ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
          'Content-Type': 'application/json',
          Prefer: `resolution=merge-duplicates,return=${requireRepresentation ? 'representation' : 'minimal'}`,
        },
        body: JSON.stringify(body),
      })
      const responseText = await response.text()
      if (!response.ok) throw new Error(`Supabase ${path} failed: ${response.status} ${responseText}`)
      if (requireRepresentation) {
        let rows
        try { rows = JSON.parse(responseText) } catch { rows = null }
        if (Array.isArray(rows) && rows.length === 0 && allowSuppressedRepresentation) {
          return { ok: true, status: response.status, skipped: true, reason: 'snapshot_throttled' }
        }
        if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`Supabase ${path} returned an invalid representation`)
        return { ok: true, status: response.status, row: rows[0] }
      }
      if (requireObject) {
        let payload
        try { payload = JSON.parse(responseText) } catch { payload = null }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`Supabase ${path} returned an invalid acknowledgement`)
        return payload
      }
      return { ok: true, status: response.status }
    })
  }

  async function patchRest(path, body, query = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase backend key is not configured' }
    const endpoint = new URL(`/rest/v1/${path}`, url)
    for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value)
    return withRetry(async () => {
      const response = await fetchImpl(endpoint, {
        method: 'PATCH',
        headers: {
          ['api' + 'key']: serviceKey,
          ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(body),
      })
      const responseText = await response.text()
      if (!response.ok) throw new Error(`Supabase ${path} patch failed: ${response.status} ${responseText}`)
      return { ok: true, status: response.status }
    })
  }

  function enqueueWrite(operation) {
    const next = writeQueue.catch(() => {}).then(operation)
    writeQueue = next.catch(() => {})
    return next
  }

  async function withRetry(operation) {
    let lastError = null
    const attempts = Math.max(1, Number(retryAttempts) || 1)
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt >= attempts || !isRetryableError(error)) break
        await delay(Math.max(0, Number(retryDelayMs) || 0) * attempt)
      }
    }
    throw lastError
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
    async reconcilePredictionLifecycle({ source = SOURCE, tableId, currentShoe, currentVisibleRound } = {}) {
      const visibleRound = Number(currentVisibleRound)
      const normalizedShoe = currentShoe == null ? '' : String(currentShoe)
      if (!source || !tableId || !normalizedShoe || !Number.isSafeInteger(visibleRound) || visibleRound < 1) {
        throw new Error('prediction lifecycle reconciliation identity is incomplete')
      }
      const acknowledgement = await enqueueWrite(() => postRest('rpc/reconcile_v09823_prediction_lifecycle', {
        p_source: String(source),
        p_table_id: String(tableId),
        p_current_shoe: normalizedShoe,
        p_current_visible_round: visibleRound,
      }, undefined, { requireObject: true }))
      const counts = {
        pending: Number(acknowledgement?.pending),
        expiredNoFinal: Number(acknowledgement?.expired_no_final),
        abandonedShoeChange: Number(acknowledgement?.abandoned_shoe_change),
        updatedTotal: Number(acknowledgement?.updated_total),
      }
      if (String(acknowledgement?.source ?? '') !== String(source)
        || String(acknowledgement?.table_id ?? '') !== String(tableId)
        || String(acknowledgement?.current_shoe ?? '') !== normalizedShoe
        || Number(acknowledgement?.current_visible_round) !== visibleRound
        || !Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0)
        || counts.pending + counts.expiredNoFinal + counts.abandonedShoeChange !== counts.updatedTotal) {
        throw new Error('prediction lifecycle reconciliation acknowledgement failed')
      }
      return { source: String(source), tableId: String(tableId), currentShoe: normalizedShoe, currentVisibleRound: visibleRound, counts }
    },
    async issuePrediction(candidate) {
      if (runtimeStatus.degraded) throw new Error(runtimeStatus.reason)
      if (requireVerifiedStrategy && runtimeStatus.ready !== true) throw new Error('active strategy not verified')
      const row = buildPredictionIssuanceDbRow(candidate)
      if (!row.table_id || !row.shoe_no || !Number.isSafeInteger(row.round_no) || row.round_no < 1
        || !row.strategy_version || !['banker', 'player'].includes(row.predicted_result)) {
        throw new Error('prediction issuance payload is incomplete')
      }
      const acknowledgement = await enqueueWrite(() => postRest('rpc/issue_v09821_prediction', { p_prediction: row }, undefined, { requireObject: true }))
      const prediction = acknowledgement?.prediction
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || !acknowledgement.prediction_id || !acknowledgement.prediction_issued_at
        || String(prediction.predictionId ?? '') !== String(acknowledgement.prediction_id)
        || String(prediction.issuedAt ?? '') !== String(acknowledgement.prediction_issued_at)
        || String(prediction.targetTableId ?? '') !== String(candidate.targetTableId ?? '')
        || String(prediction.targetShoe ?? '') !== String(candidate.targetShoe ?? '')
        || Number(prediction.targetRound) !== Number(candidate.targetRound)
        || String(prediction.strategyVersion ?? '') !== String(candidate.strategyVersion ?? '')) {
        throw new Error('durable prediction issuance acknowledgement failed')
      }
      return structuredClone(prediction)
    },
    async readIssuedPrediction({ tableId, shoe, round, strategyVersion } = {}) {
      const targetRound = Number(round)
      if (!tableId || shoe == null || !Number.isSafeInteger(targetRound) || targetRound < 1 || !strategyVersion) return null
      const rows = await getRest('daily_prediction_results', {
        select: 'id,source,table_id,shoe_no,round_no,strategy_version,prediction_issued_at,issued_prediction_payload,settlement_final',
        source: `eq.${SOURCE}`,
        table_id: `eq.${tableId}`,
        shoe_no: `eq.${shoe}`,
        round_no: `eq.${targetRound}`,
        strategy_version: `eq.${strategyVersion}`,
        prediction_issued_at: 'not.is.null',
        issued_prediction_payload: 'not.is.null',
        order: 'created_at.asc',
        limit: '2',
      })
      if (!Array.isArray(rows) || rows.length === 0) return null
      if (rows.length !== 1) throw new Error('conflicting durable prediction issuance identity')
      const row = rows[0]
      const prediction = row?.issued_prediction_payload
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || String(row.table_id ?? tableId) !== String(tableId)
        || String(row.shoe_no ?? shoe) !== String(shoe)
        || Number(row.round_no ?? targetRound) !== targetRound
        || String(row.strategy_version ?? strategyVersion) !== String(strategyVersion)
        || String(prediction.targetTableId ?? '') !== String(tableId)
        || String(prediction.targetShoe ?? '') !== String(shoe)
        || Number(prediction.targetRound) !== targetRound
        || String(prediction.strategyVersion ?? '') !== String(strategyVersion)
        || !row.id || !row.prediction_issued_at) {
        throw new Error('durable prediction issuance read failed')
      }
      return structuredClone({ ...prediction, predictionId: row.id, issuedAt: row.prediction_issued_at })
    },
    async ensureInitialStrategy() {
      try {
        await patchRest('ai_strategy_versions', { status: 'archived' }, { status: 'eq.active', version: `neq.${ALL_MT_EQUAL_STRATEGY_VERSION}` })
        await postRest('ai_strategy_versions', buildFormalActiveStrategy(), 'version')
        const activeRows = await getRest('ai_strategy_versions', { select: 'version,status', status: 'eq.active' })
        if (!Array.isArray(activeRows) || activeRows.length !== 1 || activeRows[0]?.version !== ALL_MT_EQUAL_STRATEGY_VERSION) {
          throw new Error('active strategy verification failed')
        }
        runtimeStatus = { ready: true, degraded: false, reason: null, activeStrategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION }
        return { ok: true, activeStrategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION }
      } catch (error) {
        runtimeStatus = { ready: false, degraded: true, reason: 'active strategy verification failed', activeStrategyVersion: null }
        throw new Error('active strategy verification failed', { cause: error })
      }
    },
    getRuntimeStatus() {
      return { ...runtimeStatus }
    },
    async getStablePredictionRows({ since = null, limit = 10000 } = {}) {
      const query = {
        select: 'id,source,table_id,shoe_no,round_no,strategy_version,predicted_result,actual_result,is_hit,settlement_final,side_hits,prediction_features,created_at',
        or: '(settlement_final.eq.true,prediction_features->>settlement_final.eq.true)',
        order: 'created_at.asc',
        limit: String(Math.min(10000, Math.max(1, Number(limit) || 10000))),
      }
      if (since) query.created_at = `gte.${since}`
      const rows = await getRest('daily_prediction_results', query)
      return (Array.isArray(rows) ? rows : []).filter(isFinalPredictionSettlement)
    },
    async getRecentPredictionRows({ limit = 10000 } = {}) {
      const rows = await getRest('daily_prediction_results', {
        select: 'id,table_id,shoe_no,round_no,strategy_version,predicted_result,actual_result,is_hit,settlement_final,side_hits,prediction_features,created_at',
        or: '(settlement_final.eq.true,prediction_features->>settlement_final.eq.true)',
        strategy_version: `in.(${ALL_MT_EQUAL_STRATEGY_VERSION},${COMPATIBLE_PREDECESSOR_STRATEGY_VERSION},v098_主信心實際命中校準版,v097_副預測命中校準與門檻降5版)`,
        order: 'created_at.desc',
        limit: String(Math.min(10000, Math.max(1, Number(limit) || 10000))),
      })
      return (Array.isArray(rows) ? rows : []).filter(isFinalPredictionSettlement)
    },
    async getTableUiSettledPredictions({ tableId, shoe, limit = 10 } = {}) {
      const boundedLimit = Math.min(10, Math.max(1, Number(limit) || 10))
      const fetchLimit = Math.min(100, boundedLimit * 10)
      const rows = await getRest('daily_prediction_results', {
        select: 'id,table_id,shoe_no,round_no,strategy_version,predicted_result,actual_result,is_hit,settlement_final,side_hits,prediction_features,created_at',
        table_id: `eq.${tableId}`,
        shoe_no: `eq.${shoe}`,
        strategy_version: `in.(${ALL_MT_EQUAL_STRATEGY_VERSION},${COMPATIBLE_PREDECESSOR_STRATEGY_VERSION})`,
        or: '(settlement_final.eq.true,prediction_features->>settlement_final.eq.true)',
        order: 'created_at.desc',
        limit: String(fetchLimit),
      })
      const validRows = (Array.isArray(rows) ? rows : [])
        .filter((row) => (
          String(row?.table_id ?? '') === String(tableId)
          && String(row?.shoe_no ?? '') === String(shoe)
          && [ALL_MT_EQUAL_STRATEGY_VERSION, COMPATIBLE_PREDECESSOR_STRATEGY_VERSION].includes(row?.strategy_version)
          && row?.prediction_features?.prediction_timing === 'pre_result_context'
          && isFinalPredictionSettlement(row)
          && Number.isSafeInteger(Number(row?.round_no))
          && Number(row.round_no) > 0
          && ['banker', 'player'].includes(row?.predicted_result)
          && ['banker', 'player', 'tie'].includes(row?.actual_result)
          && typeof row?.is_hit === 'boolean'
        ))
      const byRound = new Map()
      for (const row of validRows) {
        const tieAction = row?.prediction_features?.side_actions?.tie
        const tieHit = row?.side_hits?.tie ?? row?.prediction_features?.side_hits?.tie
        const hasTieEvidence = typeof tieAction === 'boolean' && typeof tieHit === 'boolean'
        const displaysTiePrediction = row.actual_result === 'tie' && hasTieEvidence && tieAction === true && tieHit === true
        const result = row.actual_result === 'tie'
          ? (displaysTiePrediction ? 'hit' : (hasTieEvidence ? 'uncalculated' : (row.is_hit ? 'hit' : 'miss')))
          : (row.is_hit ? 'hit' : 'miss')
        const next = {
          round: Number(row.round_no),
          ...(hasTieEvidence ? { mainPredictedResult: row.predicted_result } : {}),
          predictedResult: displaysTiePrediction ? 'tie' : row.predicted_result,
          actualResult: row.actual_result,
          isHit: result === 'hit',
          ...(hasTieEvidence ? { result } : {}),
        }
        const existing = byRound.get(next.round)
        if (!existing) {
          byRound.set(next.round, { strategyVersion: row.strategy_version, prediction: next })
          continue
        }
        if (existing.strategyVersion === row.strategy_version) {
          if (JSON.stringify(existing.prediction) !== JSON.stringify(next)) {
            throw new Error(`conflicting settled prediction round ${next.round}`)
          }
          continue
        }
        if (row.strategy_version === ALL_MT_EQUAL_STRATEGY_VERSION) {
          byRound.set(next.round, { strategyVersion: row.strategy_version, prediction: next })
        }
      }
      return [...byRound.values()].map((entry) => entry.prediction).slice(0, boundedLimit)
    },
    async getTableUiRealCardRounds({ tableId, shoe, limit = 100 } = {}) {
      const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 100))
      const rows = await getRest('cloud_table_rounds', {
        select: 'table_id,shoe_no,round_no,raw_event',
        table_id: `eq.${tableId}`,
        shoe_no: `eq.${shoe}`,
        order: 'round_no.asc',
        limit: String(Math.min(200, boundedLimit * 2)),
      })
      const byRound = new Map()
      for (const row of Array.isArray(rows) ? rows : []) {
        if (String(row?.table_id ?? '') !== String(tableId) || String(row?.shoe_no ?? '') !== String(shoe)) continue
        const round = Number(row?.round_no)
        const rawRound = Number(row?.raw_event?.round)
        if (!Number.isSafeInteger(round) || round < 1 || rawRound !== round) continue
        if (String(row.raw_event?.tableId ?? row.raw_event?.table_id ?? '') !== String(tableId)
          || String(row.raw_event?.shoe ?? '') !== String(shoe)) continue
        if (!isVerifiedFinalRoundAction(row.raw_event?.sourceAction)) continue
        const normalized = normalizeExactRealCardEvent(row.raw_event)
        if (!normalized) continue
        const next = {
          round,
          result: normalized.result,
          bankerPoint: normalized.bankerPoint,
          playerPoint: normalized.playerPoint,
          rawResult: normalized.rawResult,
        }
        const existing = byRound.get(round)
        if (existing && JSON.stringify(existing) !== JSON.stringify(next)) throw new Error(`conflicting real-card round ${round}`)
        byRound.set(round, next)
      }
      const rounds = []
      for (let expected = 1; expected <= boundedLimit; expected += 1) {
        const row = byRound.get(expected)
        if (!row) break
        rounds.push({ round: row.round, result: row.result, bankerPoint: row.bankerPoint, playerPoint: row.playerPoint })
      }
      return { rounds, completeThroughRound: rounds.length }
    },
    async persistRound(round, table, precomputedPrediction = null) {
      if (runtimeStatus.degraded) throw new Error(runtimeStatus.reason)
      if (requireVerifiedStrategy && runtimeStatus.ready !== true) throw new Error('active strategy not verified')
      const target = validatePredictionTarget(precomputedPrediction, round)
      if (!target) throw new Error('prediction target mismatch')
      const preparationKey = `${target.tableId}:${target.shoe}:${target.round}:${precomputedPrediction.strategyVersion}`
      let prepared = preparedRoundWrites.get(preparationKey)
      if (!prepared) {
        const event = buildRoadmapEventRow(round, table)
        const prediction = buildPredictionResultRow(round, table, precomputedPrediction)
        const compactEvent = buildCompactRoadmapEventDbRow(event)
        const compactPrediction = buildCompactPredictionResultDbRow(prediction)
        prepared = { event, prediction, compactEvent, compactPrediction }
        preparedRoundWrites.set(preparationKey, prepared)
      }
      const { event, prediction, compactEvent, compactPrediction } = prepared
      const roundKey = buildRoundDedupeKey(compactEvent, compactPrediction)
      if (completedRoundKeys.has(roundKey)) {
        preparedRoundWrites.delete(preparationKey)
        return { skipped: true, reason: 'duplicate_round', event, prediction, compactEvent, compactPrediction }
      }
      if (inFlightRoundWrites.has(roundKey)) return inFlightRoundWrites.get(roundKey)

      const writePromise = enqueueWrite(async () => {
        if (completedRoundKeys.has(roundKey)) {
          preparedRoundWrites.delete(preparationKey)
          return { skipped: true, reason: 'duplicate_round', event, prediction, compactEvent, compactPrediction }
        }
        const hasPredictionIdentity = Boolean(precomputedPrediction?.predictionId)
        if (!hasPredictionIdentity && configured && requireVerifiedStrategy) {
          throw new Error('prediction identity is required for production settlement')
        }
        const acknowledgement = hasPredictionIdentity
          ? await postRest('rpc/settle_v09821_prediction', {
              p_roadmap: compactEvent,
              p_settlement: {
                prediction_id: precomputedPrediction.predictionId,
                source: compactPrediction.source,
                table_id: compactPrediction.table_id,
                shoe_no: compactPrediction.shoe_no,
                round_no: compactPrediction.round_no,
                strategy_version: compactPrediction.strategy_version,
                actual_result: compactPrediction.actual_result,
                is_hit: compactPrediction.is_hit,
                resolved_at: compactPrediction.resolved_at,
                settlement_final: compactPrediction.prediction_features?.settlement_final === true,
                settlement_source_action: compactPrediction.prediction_features?.settlement_source_action ?? null,
                side_actual_results: compactPrediction.prediction_features?.side_actual_results ?? {},
                side_hits: compactPrediction.prediction_features?.side_hits ?? {},
              },
            }, undefined, { requireObject: true })
          : await postRest('rpc/persist_v098_settled_round', {
              p_roadmap: compactEvent,
              p_prediction: compactPrediction,
            }, undefined, { requireObject: true })
        if (acknowledgement.persisted !== true || acknowledgement.roadmapDurable !== true || acknowledgement.predictionDurable !== true
          || (hasPredictionIdentity && acknowledgement.prediction_id !== precomputedPrediction.predictionId)) {
          throw new Error('durable settlement acknowledgement failed')
        }
        completedRoundKeys.add(roundKey)
        while (completedRoundKeys.size > completedRoundKeyLimit) {
          completedRoundKeys.delete(completedRoundKeys.values().next().value)
        }
        preparedRoundWrites.delete(preparationKey)
        return { event, prediction, compactEvent, compactPrediction }
      }).finally(() => {
        inFlightRoundWrites.delete(roundKey)
      })
      inFlightRoundWrites.set(roundKey, writePromise)
      return writePromise
    },
    async writeCloudCaptureStatus(payload) {
      const row = buildCloudCaptureStatusRow(payload)
      const key = String(row.session_id ?? 'default')
      const fingerprint = JSON.stringify([
        row.capture_source, row.deploy_mode, row.connected, row.authenticated,
        row.table_count, row.status_text, row.error_message, row.metadata,
      ])
      const timestamp = Number(now())
      const previous = captureStatusWrites.get(key)
      const heartbeatMs = Math.max(1000, Number(captureStatusHeartbeatMs) || 60000)
      if (previous?.fingerprint === fingerprint && timestamp - previous.writtenAt < heartbeatMs) {
        return { skipped: true, reason: 'unchanged_before_heartbeat', row }
      }
      await enqueueWrite(() => postRest('cloud_capture_status', row, 'session_id'))
      captureStatusWrites.set(key, { fingerprint, writtenAt: timestamp })
      return { ok: true, row }
    },
    async writeOperationalEvent(payload) {
      const row = buildOperationalEventRow(payload)
      await enqueueWrite(() => postRest('cloud_operational_events', row))
      return { ok: true, row }
    },
    async writeCloudTableSnapshot(payload) {
      const row = buildCloudTableSnapshotRow(payload)
      const key = String(row.session_id ?? 'default')
      const connectionFingerprint = JSON.stringify([row.capture_source, row.metadata?.connectionState ?? null])
      const timestamp = Number(now())
      const previous = snapshotWrites.get(key)
      const heartbeatMs = Math.max(1000, Number(snapshotHeartbeatMs) || 60000)
      if (previous?.connectionFingerprint === connectionFingerprint && timestamp - previous.writtenAt < heartbeatMs) {
        return { skipped: true, reason: 'snapshot_before_heartbeat', row }
      }
      const result = await enqueueWrite(() => postRest('rpc/persist_latest_cloud_table_snapshot', { p_snapshot: row }, null, { requireObject: true }))
      if (result?.skipped) return result
      snapshotWrites.set(key, { connectionFingerprint, writtenAt: timestamp })
      return { ok: true, row, result }
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
      const rows = await getRest('daily_prediction_results', {
        select: 'id,settlement_final,prediction_features',
        created_at: `gte.${since.toISOString()}`,
        or: '(settlement_final.eq.true,prediction_features->>settlement_final.eq.true)',
      })
      return (Array.isArray(rows) ? rows : []).filter(isFinalPredictionSettlement).length
    },
    async getPredictionLifecycleStats() {
      const acknowledgement = await postRest('rpc/get_v09823_prediction_lifecycle_stats', {}, undefined, { requireObject: true })
      const stats = {
        activePending: Number(acknowledgement?.active_pending),
        settled: Number(acknowledgement?.settled),
        expiredNoFinal: Number(acknowledgement?.expired_no_final),
        abandonedShoeChange: Number(acknowledgement?.abandoned_shoe_change),
        unclassified: Number(acknowledgement?.unclassified),
        total: Number(acknowledgement?.total),
      }
      if (!Object.values(stats).every((value) => Number.isSafeInteger(value) && value >= 0)
        || stats.activePending + stats.settled + stats.expiredNoFinal + stats.abandonedShoeChange + stats.unclassified !== stats.total) {
        throw new Error('prediction lifecycle stats acknowledgement failed')
      }
      return stats
    },
    async writeCloudRoundEvent(payload) {
      const row = buildCloudRoundEventRow(payload)
      await enqueueWrite(() => postRest('cloud_table_rounds', row, 'source,table_id,shoe_no,round_no'))
      return { ok: true, row }
    },
    async writeCloudStrategyReport(payload) {
      const row = buildCloudStrategyReportRow(payload)
      await enqueueWrite(() => postRest('cloud_strategy_reports', row))
      return { ok: true, row }
    },
    async writeStrategyAdjustmentStats(payload) {
      const rows = buildStrategyAdjustmentStatsRows(payload)
      await enqueueWrite(() => postRest('cloud_strategy_adjustment_stats', rows))
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

function isMatchingPendingPrediction(pending, round = {}) {
  return validatePredictionTarget(pending, round) != null
}

function validatePredictionTarget(pending, round = {}) {
  const targetTableId = normalizeRequiredIdentity(pending?.targetTableId)
  const targetShoe = normalizeRequiredIdentity(pending?.targetShoe)
  const completedTableId = normalizeRequiredIdentity(round?.tableId)
  const completedShoe = normalizeRequiredIdentity(round?.shoe)
  const targetRound = normalizeRequiredRound(pending?.targetRound)
  const completedRound = normalizeRequiredRound(round?.round)
  if (!targetTableId || !targetShoe || !completedTableId || !completedShoe || targetRound == null || completedRound == null) return null
  if (targetTableId !== completedTableId || targetShoe !== completedShoe || targetRound !== completedRound) return null
  if (pending?.source !== 'backend'
    || !['banker', 'player'].includes(pending.predictedResult)
    || !Number.isFinite(Number(pending.confidence))
    || !pending.sidePredictions || typeof pending.sidePredictions !== 'object'
    || !pending.sideActions || typeof pending.sideActions !== 'object'
    || typeof pending.strategyVersion !== 'string') return null
  return { tableId: targetTableId, shoe: targetShoe, round: targetRound }
}

function normalizeRequiredIdentity(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeRequiredRound(value) {
  if (value == null || value === '') return null
  const normalized = Number(value)
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

function buildRoundDedupeKey(event = {}, prediction = {}) {
  const rawResult = Array.isArray(event.raw_event?.rawResult) ? event.raw_event.rawResult : []
  return JSON.stringify({
    source: event.source,
    tableId: event.table_id,
    shoeNo: event.shoe_no,
    roundNo: event.round_no,
    strategyVersion: prediction.strategy_version,
    rawResult,
    mainResult: event.main_result,
    bankerPoints: event.banker_points,
    playerPoints: event.player_points,
  })
}

function isFinalPredictionSettlement(row = {}) {
  return row?.settlement_final === true
    || (row?.settlement_final == null && row?.prediction_features?.settlement_final === true)
}

function isRetryableError(error) {
  const message = String(error?.message ?? error)
  const status = Number(message.match(/failed:\s*(\d+)/)?.[1] ?? 0)
  return status === 0 || status === 408 || status === 429 || status >= 500 || /timeout|aborted|network|fetch failed/i.test(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    prediction: table.prediction ?? null,
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
      confidence: clampPercent(Math.min(50, baseConfidence), 30, 70),
    }
  }
  if (rate != null && rate > 0.65) {
    const boost = rate >= 0.80 ? 10 : 5
    return {
      predictedResult,
      confidence: clampPercent(baseConfidence + boost, 30, 70),
    }
  }
  return { predictedResult, confidence: clampPercent(baseConfidence, 30, 70) }
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
