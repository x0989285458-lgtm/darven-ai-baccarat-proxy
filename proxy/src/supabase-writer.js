import pg from 'pg'
import { buildRoundCardSnapshot, scoreCardShoeInfluence } from './card-shoe.js'
import { BUILD_VERSION } from './build-version.js'
import { isVerifiedFinalRoundAction, normalizeExactRealCardEvent } from '../../shared/real-card-validator.js'
import { V104_DIRECTION_WEIGHTS, V104_SHOE_BIAS } from './v104-main-contract.js'
import { PRODUCTION_TABLE_IDS } from './cloud-capture.js'

const SOURCE = 'ofalive99'
export const ALL_MT_EQUAL_STRATEGY_VERSION = 'v105'
export const V100_MAIN_SIGNAL_DEDUP_VERSION = 'v105_五路通用週期正式版'
export const V100_SIDE_DEDUP_VERSION = 'v105_副預測沿用v104正式規則'
export const V100_SIDE_SCORE_CALIBRATION_OFFSETS = Object.freeze({
  tie: -13.867936925098554,
  superSix: -1.8125,
  bankerPair: 18.877647058823527,
  playerPair: 13.875,
  bankerDragon: 0,
  playerDragon: 0,
})
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
  'roadmap_trend_signals',
  'ask_road_signals',
  'recent_practical_calibration',
  'shoe_banker_player_bias',
  'neutral_reserve',
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
  roadmap_trend_signals: 0.35,
  ask_road_signals: 0.15,
  recent_practical_calibration: 0.30,
  shoe_banker_player_bias: 0.10,
  neutral_reserve: 0.10,
})

export const V100_MAIN_SIGNAL_DEDUP_WEIGHTS = ALL_MT_EQUAL_MAIN_WEIGHTS

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
  tie: 30,
  superSix: 50,
  bankerPair: 50,
  playerPair: 50,
  bankerDragon: 40,
  playerDragon: 40,
}


export function buildFormalActiveStrategy() {
  return {
    version: ALL_MT_EQUAL_STRATEGY_VERSION,
    status: 'active',
    sample_count: 0,
    weights: { ...V104_DIRECTION_WEIGHTS },
    metrics: {
      mode: 'formal_live_prediction',
      auto_adjust: false,
      main_strategy: V100_MAIN_SIGNAL_DEDUP_VERSION,
      side_strategy: V100_SIDE_DEDUP_VERSION,
      main_weights: { ...V104_DIRECTION_WEIGHTS },
      side_weights: Object.fromEntries(Object.entries(SIDE_PREDICTION_WEIGHT_PROFILES).map(([key, profile]) => [key, { ...profile }])),
      side_thresholds: { ...SIDE_PREDICTION_THRESHOLDS },
      rank_ledger: 'durable_eight_deck_exact_rank_ledger',
      recent_calibration: 'confidence_only_direction_contribution_zero',
      shoe_bias: { ...V104_SHOE_BIAS, priorCenter: 0.5 },
      description: 'v104正式策略；主預測採方向／信心分離、當靴收縮與第五次同邊防鎖Gate，副預測完整沿用v102正式規則。',
    },
    notes: 'Only active runtime strategy and history source for formal release v104.',
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

function buildV103ShadowIssuanceRpcRow(candidate = {}) {
  return {
    source: candidate.source,
    table_id: candidate.targetTableId,
    shoe_no: candidate.targetShoe,
    round_no: candidate.targetRound,
    strategy_version: candidate.strategyVersion,
    prediction_timing: candidate.predictionTiming,
    predicted_result: candidate.predictedResult,
    confidence: candidate.confidence,
    feature_weights: structuredClone(candidate.featureWeights ?? {}),
    score_sources: structuredClone(candidate.scoreSources ?? {}),
    score_totals: structuredClone(candidate.scoreTotals ?? {}),
    calibration: structuredClone(candidate.calibration ?? {}),
    prediction_payload: structuredClone(candidate),
  }
}

function buildV103ShadowSettlementRpcRow(settlement = {}) {
  return {
    prediction_id: settlement.predictionId,
    source: settlement.source,
    table_id: settlement.tableId,
    shoe_no: settlement.shoe,
    round_no: settlement.round,
    strategy_version: settlement.strategyVersion,
    predicted_result: settlement.predictedResult,
    actual_result: settlement.actualResult,
    is_hit: settlement.isHit,
    settlement_status: settlement.settlementStatus,
    settlement_final: settlement.settlementFinal,
    settlement_source_action: settlement.settlementSourceAction,
    resolved_at: settlement.resolvedAt,
  }
}

function buildV104ShadowIssuanceRpcRow(candidate = {}) {
  return {
    source: candidate.source,
    table_id: candidate.targetTableId,
    shoe_no: candidate.targetShoe,
    round_no: candidate.targetRound,
    strategy_version: candidate.strategyVersion,
    prediction_timing: candidate.predictionTiming,
    predicted_result: candidate.predictedResult,
    confidence: candidate.confidence,
    feature_weights: structuredClone(candidate.featureWeights ?? {}),
    score_sources: structuredClone(candidate.scoreSources ?? {}),
    score_totals: structuredClone(candidate.scoreTotals ?? {}),
    diagnostics: structuredClone(candidate.diagnostics ?? {}),
    same_side_streak: candidate.sameSideStreak,
    independent_support_count: candidate.independentSupportCount,
    shoe_bias_suppressed: candidate.shoeBiasSuppressed,
    lock_risk: candidate.lockRisk,
    prediction_payload: structuredClone(candidate),
  }
}

function buildV104ShadowSettlementRpcRow(settlement = {}) {
  return {
    prediction_id: settlement.predictionId,
    source: settlement.source,
    table_id: settlement.tableId,
    shoe_no: settlement.shoe,
    round_no: settlement.round,
    strategy_version: settlement.strategyVersion,
    predicted_result: settlement.predictedResult,
    actual_result: settlement.actualResult,
    is_hit: settlement.isHit,
    settlement_status: settlement.settlementStatus,
    settlement_final: settlement.settlementFinal,
    settlement_source_action: settlement.settlementSourceAction,
    resolved_at: settlement.resolvedAt,
  }
}

function buildV104IterationShadowIssuanceRpcRow(candidate = {}) {
  return {
    source: candidate.source,
    table_id: candidate.targetTableId,
    shoe_no: candidate.targetShoe,
    round_no: candidate.targetRound,
    strategy_version: candidate.strategyVersion,
    prediction_timing: candidate.predictionTiming,
    predicted_result: candidate.predictedResult,
    confidence: candidate.confidence,
    same_side_streak: candidate.sameSideStreak,
    independent_support_count: candidate.independentSupportCount,
    shoe_bias_suppressed: candidate.shoeBiasSuppressed,
    lock_risk: candidate.lockRisk,
    prediction_payload: structuredClone(candidate),
  }
}

function buildV104IterationShadowSettlementRpcRow(settlement = {}) {
  return {
    prediction_id: settlement.predictionId,
    source: settlement.source,
    table_id: settlement.tableId,
    shoe_no: settlement.shoe,
    round_no: settlement.round,
    strategy_version: settlement.strategyVersion,
    predicted_result: settlement.predictedResult,
    actual_result: settlement.actualResult,
    actual_facts: structuredClone(settlement.actualFacts ?? {}),
    is_hit: settlement.isHit,
    settlement_status: settlement.settlementStatus,
    settlement_final: settlement.settlementFinal,
    settlement_source_action: settlement.settlementSourceAction,
    head_results: structuredClone(settlement.headResults ?? {}),
    resolved_at: settlement.resolvedAt,
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
  const confidenceCalibration = calibrateMainConfidenceByHitRate(rawSignalConfidence, tablePerformance, predictedResult)
  return { predictedResult, confidence: confidenceCalibration.finalConfidence, confidenceCalibration, scores, total }
}

export function calculateV100MainPrediction({ round = {}, table = {}, facts = {}, probabilities = {}, tablePerformance = {} } = {}) {
  const prepared = prepareCurrentSignalInputs(table)
  const safeTable = prepared.table
  const derived = buildDerivedMainFeatures(round, safeTable, facts, probabilities, tablePerformance)
  const roadFeatures = buildRoadFeatures(safeTable)
  const scores = Object.fromEntries(Object.keys(V100_MAIN_SIGNAL_DEDUP_WEIGHTS).map((key) => [key, scoreAllMtFeature(key, { round, facts, table: safeTable, probabilities, tablePerformance, derived, roadFeatures })]))
  const originalShoeScore = scores.shoe_banker_player_bias
  const askRoadScore = scores.ask_road_signals
  const adjustment = deduplicateShoeBankerPlayerBias(
    prepared.askRoadValid ? askRoadScore : { banker: Number.NaN, player: Number.NaN },
    prepared.shoeBiasValid ? originalShoeScore : { banker: Number.NaN, player: Number.NaN },
  )
  scores.shoe_banker_player_bias = adjustment.adjustedScore
  const total = Object.entries(V100_MAIN_SIGNAL_DEDUP_WEIGHTS).reduce((acc, [key, weight]) => {
    const score = scores[key] ?? neutralScore()
    acc.banker += score.banker * weight
    acc.player += score.player * weight
    return acc
  }, { banker: 0, player: 0 })
  const difference = Math.abs(total.banker - total.player)
  const predictedResult = difference < 1e-9 ? breakAllMtMainTie({ round, table: safeTable, facts, probabilities }) : (total.banker > total.player ? 'banker' : 'player')
  const rawSignalConfidence = difference < 1e-9 ? 30 : calculateConservativeMainConfidence(scores, V100_MAIN_SIGNAL_DEDUP_WEIGHTS)
  const confidenceCalibration = calibrateMainConfidenceByHitRate(rawSignalConfidence, tablePerformance, predictedResult)
  return {
    strategyVersion: V100_MAIN_SIGNAL_DEDUP_VERSION,
    predictedResult,
    confidence: confidenceCalibration.finalConfidence,
    confidenceCalibration,
    scores,
    total,
    featureWeights: { ...V100_MAIN_SIGNAL_DEDUP_WEIGHTS },
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

function prepareCurrentSignalInputs(table) {
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

export function buildLivePrediction(table = {}, options = {}) {
  const probabilities = calculateInitialProbabilities(table)
  const tablePerformance = buildTablePerformanceFeature(table)
  const nextRound = {
    tableId: table.tableId,
    shoe: table.shoe,
    round: Number(table.round ?? 0) + 1,
    lastRound: table.lastRound ?? null,
    cardShoe: table.cardShoe ?? null,
  }
  const baselinePrediction = calculateV100MainPrediction({
    round: nextRound,
    table,
    facts: {},
    probabilities,
    tablePerformance,
  })
  const prediction = options.mainPredictionOverride
    ? structuredClone(options.mainPredictionOverride)
    : baselinePrediction
  const mainStreakAdjustment = options.mainStreakAdjustmentOverride
    ? structuredClone(options.mainStreakAdjustmentOverride)
    : buildMainPredictionStreakAdjustment({
      table,
      predictedResult: prediction.predictedResult,
      confidence: prediction.confidence,
      scores: prediction.scores,
    })
  const baseSidePredictions = buildSidePredictions(table, nextRound)
  const rankCardShoe = table.v102RankLedger ?? null
  const rankAvailable = rankCardShoe?.rankDataAvailable === true
    && hasCompleteRemainingRankCounts(rankCardShoe.remainingRankCounts)
  const v100Side = calculateV100SidePrediction({
    table,
    round: { ...nextRound, v102RankLedger: rankCardShoe },
    rankAvailable,
    rankFallback: 'renormalize',
    mainPrediction: prediction.predictedResult,
    baseSidePredictions,
  })
  const sidePredictions = v100Side.predictions
  const sideActions = v100Side.actions
  const buildVersion = String(options.buildVersion ?? BUILD_VERSION)
  const strategyVersion = String(options.strategyVersion ?? ALL_MT_EQUAL_STRATEGY_VERSION)
  const mainPolicyKey = String(options.mainPolicyKey ?? 'v102_main_signal_dedup')
  const sidePolicyKey = String(options.sidePolicyKey ?? 'v102_side_policy')
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
    main_streak_adjustment: structuredClone(mainStreakAdjustment),
    [mainPolicyKey]: {
      strategyVersion,
      diagnostics: structuredClone(prediction.diagnostics),
    },
    [sidePolicyKey]: structuredClone(v100Side),
  }
  return {
    source: 'backend',
    buildVersion,
    strategyVersion,
    targetTableId: String(table.tableId ?? ''),
    targetShoe: table.shoe == null ? null : String(table.shoe),
    targetRound: nextRound.round,
    predictedResult: prediction.predictedResult,
    confidence: mainStreakAdjustment.finalConfidence,
    probabilities,
    scoreTotals: prediction.total,
    scoreSources: prediction.scores,
    sidePredictions,
    sideActions,
    mainStreakAdjustment,
    tableRecentHitRate: tablePerformance.recentHitRate,
    tableRecentPredictionCount: tablePerformance.recentPredictionCount,
    shortRunAdjustment: {
      rule: strategyVersion,
      includedMainWeightCount: Object.keys(ALL_MT_EQUAL_MAIN_WEIGHTS).length,
      includedSideWeightCount: Object.keys(SIDE_WEIGHT_KEYS).length,
      sideActionRateTargets: structuredClone(SIDE_PREDICTION_ACTION_RATE_TARGETS),
      sideTargetHitRate: SIDE_PREDICTION_TARGET_HIT_RATE,
      baseProbabilities: structuredClone(probabilities),
    },
    predictionFeatures,
    featureWeights: { ...prediction.featureWeights },
  }
}

function buildMainPredictionStreakAdjustment({ table = {}, predictedResult, confidence, scores = {} } = {}) {
  const streak = normalizePriorMainPredictionStreak(table)
  const baseConfidence = clampPercent(Number(confidence), 30, 70)
  if (!streak) return mainStreakResult('streak-unavailable', false, baseConfidence, 0, {})
  if (streak.direction !== predictedResult) return mainStreakResult('direction-changed', false, baseConfidence, 0, {})

  const supportGroups = buildIndependentMainSupportGroups(predictedResult, scores)
  const supportGroupCount = Object.values(supportGroups).filter(Boolean).length
  if (streak.count < 5) return mainStreakResult('below-five', false, baseConfidence, supportGroupCount, supportGroups)
  if (supportGroupCount >= 2) return mainStreakResult('two-independent-groups', false, baseConfidence, supportGroupCount, supportGroups)
  return mainStreakResult('five-same-side-low-support', true, clampPercent(baseConfidence - 5, 30, 70), supportGroupCount, supportGroups)
}

function normalizePriorMainPredictionStreak(table = {}) {
  const raw = table.priorMainPredictionStreak ?? table.prior_main_prediction_streak
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const direction = normalizeMainDirection(raw.direction ?? raw.predictedResult ?? raw.predicted_result)
  const count = numberOrNull(raw.count ?? raw.streakCount ?? raw.streak_count)
  if (!direction || count == null || count < 0) return null
  return { direction, count: Math.floor(count) }
}

function normalizeMainDirection(value) {
  const direction = String(value ?? '').trim().toLowerCase()
  if (direction === 'banker' || direction === '莊') return 'banker'
  if (direction === 'player' || direction === '閒') return 'player'
  return null
}

function buildIndependentMainSupportGroups(predictedResult, scores = {}) {
  const roadmapAskMargin = signedScoreMargin(scores.roadmap_trend_signals) * ALL_MT_EQUAL_MAIN_WEIGHTS.roadmap_trend_signals
    + signedScoreMargin(scores.ask_road_signals) * ALL_MT_EQUAL_MAIN_WEIGHTS.ask_road_signals
  return {
    roadmapAsk: marginSupportsDirection(roadmapAskMargin, predictedResult),
    directionalCalibration: scoreSupportsDirection(scores.recent_practical_calibration, predictedResult),
    shoeBias: scoreSupportsDirection(scores.shoe_banker_player_bias, predictedResult),
  }
}

function scoreSupportsDirection(score, direction) {
  return marginSupportsDirection(signedScoreMargin(score), direction)
}

function marginSupportsDirection(margin, direction) {
  return direction === 'banker' ? margin > 1e-12 : margin < -1e-12
}

function mainStreakResult(reason, applied, finalConfidence, supportGroupCount, supportGroups) {
  return {
    applied,
    reason,
    confidencePenalty: applied ? 5 : 0,
    finalConfidence,
    supportGroupCount,
    supportGroups,
    actionSuppressed: false,
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

export function calibrateMainConfidenceByHitRate(rawSignalConfidence, tablePerformance = {}, predictedResult = null) {
  const signal = clampPercent(Number(rawSignalConfidence), 30, 70)
  const direction = normalizeMainDirection(predictedResult)
  const directionStats = direction ? tablePerformance.settledDirectionalPredictionStats?.[direction] : null
  const recentHitRate = normalizedRate(directionStats?.hitRate)
  const recentPredictionCount = numberOrNull(directionStats?.settledPredictionCount)
  const signalAdjustment = (signal - 50) * 0.2
  if (recentHitRate == null || recentPredictionCount == null || recentPredictionCount < 20) {
    return {
      rawSignalConfidence: signal,
      finalConfidence: Math.round(clampPercent(50 + signalAdjustment, 30, 70)),
      reason: 'learning-neutral-shrinkage',
      ...(direction ? { direction } : {}),
      recentHitRate,
      recentPredictionCount,
      reliability: 0,
    }
  }
  const reliability = Math.min(1, Math.max(0, recentPredictionCount / 20))
  const empiricalCenter = 50 + (recentHitRate * 100 - 50) * reliability
  return {
    rawSignalConfidence: signal,
    finalConfidence: Math.round(clampPercent(empiricalCenter + signalAdjustment, 30, 70)),
    reason: 'settled-direction-hit-rate-calibration',
    ...(direction ? { direction } : {}),
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
    case 'neutral_reserve': return neutralScore()
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
    settledDirectionalPredictionStats: structuredClone(tablePerformance.settledDirectionalPredictionStats ?? null),
    source: tablePerformance.directionalCalibrationSource ?? 'unavailable',
    preferred: score.banker > score.player ? 'banker' : score.player > score.banker ? 'player' : 'neutral',
    banker: score.banker,
    player: score.player,
  }
}

function scoreRecentPracticalCalibrationFeature(_probabilities = {}, tablePerformance = {}) {
  const stats = tablePerformance.settledDirectionalPredictionStats ?? {}
  return {
    banker: scoreSettledDirection(stats.banker),
    player: scoreSettledDirection(stats.player),
  }
}

function scoreSettledDirection(stats = {}) {
  const count = numberOrNull(stats.settledPredictionCount)
  const rate = normalizedRate(stats.hitRate)
  if (count == null || count < 20 || rate == null) return 0.5
  return roundRate(Math.max(0.45, Math.min(0.55, 0.5 + (rate - 0.5) * 0.25)))
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

export function calculateV100SidePrediction({
  table = {},
  round = {},
  primitives: primitiveOverrides = null,
  rankAvailable: rankAvailableOverride,
  rankFallback,
  mainPrediction = null,
  baseSidePredictions: baseOverrides = null,
} = {}) {
  const rankCardShoe = round.v102RankLedger ?? table.v102RankLedger ?? null
  const featureScores = primitiveOverrides == null ? buildSideFeatureScores(table, { ...round, cardShoe: rankCardShoe }) : null
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
    ? rankCardShoe?.rankDataAvailable === true && hasCompleteRemainingRankCounts(rankCardShoe.remainingRankCounts)
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
  const tie = weightedSideScore({ T: primitives.T, A: primitives.A, S: primitives.S, R: primitives.R }, {
    T: 0.5068331143232588, A: 0.1931668856767411, S: 0.10, R: 0.20,
  }, omitRank ? ['R'] : [])
  const bankerPair = weightedSideScore({ Q: primitives.Q, S: primitives.S, XB: primitives.XB, RB: bankerPairResidual, Hpair: primitives.Hpair }, {
    Q: 0.15, S: 0.20, XB: 0.20, RB: 0.35, Hpair: 0.10,
  }, omitRank ? ['Q'] : [])
  const playerPair = weightedSideScore({ Q: primitives.Q, S: primitives.S, XP: primitives.XP, RP: playerPairResidual, Hpair: primitives.Hpair }, {
    Q: 0.20, S: 0.15, XP: 0.20, RP: 0.25, Hpair: 0.20,
  }, omitRank ? ['Q'] : [])
  const superSix = weightedSideScore({ B: primitives.B, H6: primitives.H6, R: primitives.R, S: primitives.S }, {
    B: 0.35, H6: 0.35, R: 0.20, S: 0.10,
  }, omitRank ? ['R'] : [])
  const baseSidePredictions = baseOverrides ?? buildSidePredictions(table, round)
  const rawPredictions = {
    tie: tie.score,
    superSix: superSix.score,
    bankerPair: bankerPair.score,
    playerPair: playerPair.score,
    bankerDragon: clampSideScore(baseSidePredictions.bankerDragon),
    playerDragon: clampSideScore(baseSidePredictions.playerDragon),
  }
  const predictions = Object.fromEntries(Object.entries(rawPredictions).map(([key, score]) => [
    key,
    clampSideScore(score + Number(V100_SIDE_SCORE_CALIBRATION_OFFSETS[key] ?? 0)),
  ]))
  const actions = rankAvailable
    ? buildV100SideActions(predictions, mainPrediction)
    : { tie: false, superSix: false, bankerPair: false, playerPair: false, bankerDragon: false, playerDragon: false }
  return {
    strategyVersion: V100_SIDE_DEDUP_VERSION,
    predictions,
    actions,
    diagnostics: {
      rawPredictions,
      scoreCalibration: {
        method: 'train_quantile_to_existing_threshold',
        offsets: { ...V100_SIDE_SCORE_CALIBRATION_OFFSETS },
        actionRateTargets: { ...SIDE_PREDICTION_ACTION_RATE_TARGETS },
      },
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
        substituted: !rankAvailable && rankFallback === 'neutral' ? { Q: 50, R: 50 } : null,
        excluded: !rankAvailable && rankFallback === 'renormalize' ? ['Q', 'R'] : [],
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

export function buildV100SideActions(predictions = {}, mainPrediction = null) {
  return buildSideActions(predictions, mainPrediction)
}

function weightedSideScore(values, coefficients, omittedKeys = []) {
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

export function buildSideFeatureScores(table = {}, round = {}) {
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
    tie_risk: clampPercent(tieRate * 1.6, 0, 100),
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
  if (table.prediction?.source === 'backend'
    && table.prediction?.strategyVersion === ALL_MT_EQUAL_STRATEGY_VERSION
    && Number.isFinite(Number(table.prediction.confidence))) {
    return { ...table, buildVersion: BUILD_VERSION, prediction: { ...table.prediction, buildVersion: BUILD_VERSION } }
  }
  return { ...table, buildVersion: BUILD_VERSION }
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

function normalizeV100DurableRankLedger(row = {}, expectedIdentity = {}) {
  const source = String(row.source ?? expectedIdentity.source ?? '')
  const tableId = String(row.table_id ?? expectedIdentity.tableId ?? '')
  const shoe = String(row.shoe_no ?? expectedIdentity.shoe ?? '')
  if (!source || !tableId || !shoe
    || source !== String(expectedIdentity.source ?? source)
    || tableId !== String(expectedIdentity.tableId ?? tableId)
    || shoe !== String(expectedIdentity.shoe ?? shoe)) {
    throw new Error('v100 durable rank ledger identity mismatch')
  }
  const completeThrough = Number(row.complete_through_round)
  const status = String(row.status ?? '')
  const cardsSeen = Number(row.cards_seen_dealt)
  const revision = Number(row.revision)
  const seen = row.seen_dealt_rank_counts
  const codes = row.seen_dealt_code_counts
  const undealt = row.undealt_after_observed_deals
  const validRanks = seen && undealt && RANK_REMAINING_FACES.every((rank) => Number.isInteger(Number(seen[rank]))
    && Number(seen[rank]) >= 0 && Number(seen[rank]) <= 32
    && Number.isInteger(Number(undealt[rank])) && Number(undealt[rank]) >= 0 && Number(undealt[rank]) <= 32
    && (status !== 'contiguous' || Number(seen[rank]) + Number(undealt[rank]) === 32))
  const validCodes = codes && Array.from({ length: 52 }, (_, index) => String(index + 1)).every((code) => Number.isInteger(Number(codes[code]))
    && Number(codes[code]) >= 0 && Number(codes[code]) <= 8)
  const ranksFromCodes = Object.fromEntries(RANK_REMAINING_FACES.map((rank) => [rank, 0]))
  if (validCodes) {
    for (let code = 1; code <= 52; code += 1) {
      ranksFromCodes[RANK_REMAINING_FACES[(code - 1) % 13]] += Number(codes[String(code)])
    }
  }
  const codeRanksMatch = validCodes && validRanks && RANK_REMAINING_FACES.every((rank) => ranksFromCodes[rank] === Number(seen[rank]))
  const seenTotal = validRanks ? RANK_REMAINING_FACES.reduce((sum, rank) => sum + Number(seen[rank]), 0) : -1
  const codeTotal = validCodes ? Array.from({ length: 52 }, (_, index) => String(index + 1)).reduce((sum, code) => sum + Number(codes[code]), 0) : -1
  if (!['contiguous', 'gap', 'conflicted', 'invalid'].includes(status)
    || !Number.isSafeInteger(completeThrough) || completeThrough < 0
    || !Number.isSafeInteger(cardsSeen) || cardsSeen < 0 || cardsSeen > 416
    || !Number.isSafeInteger(revision) || revision < 0 || !validRanks || !validCodes || !codeRanksMatch
    || seenTotal !== cardsSeen || codeTotal !== cardsSeen
    || row.physical_remaining_exact !== false || row.burn_observation_status !== 'unavailable'
    || !/^[0-9a-f]{64}$/.test(String(row.ledger_checksum ?? ''))) {
    throw new Error('v100 durable rank ledger acknowledgement failed')
  }
  return {
    identity: { source, table_id: tableId, shoe },
    status,
    complete_through_round: completeThrough,
    completeThroughRound: completeThrough,
    targetRound: completeThrough + 1,
    rankDataAvailable: status === 'contiguous',
    seen_dealt_rank_counts: structuredClone(seen),
    seenDealtCodeCounts: structuredClone(codes),
    undealt_after_observed_deals: structuredClone(undealt),
    remainingRankCounts: structuredClone(undealt),
    cards_seen_dealt: cardsSeen,
    cardsSeenTotal: cardsSeen,
    cardsRemainingTotal: 416 - cardsSeen,
    physical_remaining_exact: false,
    physicalRemainingExact: false,
    burn_observation_status: 'unavailable',
    burnObservationStatus: 'unavailable',
    ledgerChecksum: String(row.ledger_checksum),
    revision,
  }
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
  requestTimeoutMs: defaultRequestTimeoutMs = 3500,
  startupRequestTimeoutMs = 60000,
  shadowRequestTimeoutMs = 9000,
  dbConnectionString = null,
  strategyPool = null,
} = {}) {
  const configured = Boolean(url && serviceKey && fetchImpl)
  const strategyDb = strategyPool ?? (dbConnectionString ? new pg.Pool({
    connectionString: dbConnectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000,
    query_timeout: 65000,
    statement_timeout: 60000,
    idleTimeoutMillis: 30000,
  }) : null)
  const completedRoundKeys = new Set()
  const inFlightRoundWrites = new Map()
  const preparedRoundWrites = new Map()
  const captureStatusWrites = new Map()
  const snapshotWrites = new Map()
  let runtimeStatus = { ready: false, degraded: false, reason: 'active_strategy_not_verified', activeStrategyVersion: null }
  let writeQueue = Promise.resolve()
  let shadowWriteQueue = Promise.resolve()
  let v104ShadowWriteQueue = Promise.resolve()
  let v104IterationShadowWriteQueue = Promise.resolve()
  const completedRoundKeyLimit = Math.max(1, Number(maxCompletedRoundKeys) || 10000)
  const formalTimeoutMs = Math.max(1, Number(defaultRequestTimeoutMs) || 3500)
  const startupTimeoutMs = Math.max(formalTimeoutMs, Number(startupRequestTimeoutMs) || 30000)
  const shadowTimeoutMs = Math.max(1, Number(shadowRequestTimeoutMs) || 9000)

  async function verifyActiveStrategyFromDatabase() {
    if (!strategyDb || typeof strategyDb.query !== 'function') return false
    try {
      const result = await strategyDb.query(
        'select version, status from public.ai_strategy_versions where status = $1 order by created_at desc limit 2',
        ['active'],
      )
      const rows = Array.isArray(result?.rows) ? result.rows : []
      return rows.length === 1
        && rows[0]?.version === ALL_MT_EQUAL_STRATEGY_VERSION
        && rows[0]?.status === 'active'
    } catch {
      return false
    }
  }

  async function fetchWithOptionalTimeout(endpoint, init, requestTimeoutMs = 0) {
    if (!(requestTimeoutMs > 0)) return fetchImpl(endpoint, init)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    timer.unref?.()
    try {
      return await fetchImpl(endpoint, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function postRest(path, body, conflict, { requireRepresentation = false, requireObject = false, allowSuppressedRepresentation = false, requestTimeoutMs = formalTimeoutMs } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase backend key is not configured' }
    const endpoint = new URL(`/rest/v1/${path}`, url)
    if (conflict) endpoint.searchParams.set('on_conflict', conflict)
    return withRetry(async () => {
      const response = await fetchWithOptionalTimeout(endpoint, {
        method: 'POST',
        headers: {
          ['api' + 'key']: serviceKey,
          ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
          'Content-Type': 'application/json',
          Prefer: `resolution=merge-duplicates,return=${requireRepresentation ? 'representation' : 'minimal'}`,
        },
        body: JSON.stringify(body),
      }, requestTimeoutMs)
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

  async function postRpcRows(path, body, { requestTimeoutMs = 0 } = {}) {
    if (!configured) return []
    const endpoint = new URL(`/rest/v1/rpc/${path}`, url)
    return withRetry(async () => {
      const response = await fetchWithOptionalTimeout(endpoint, {
        method: 'POST',
        headers: {
          ['api' + 'key']: serviceKey,
          ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, requestTimeoutMs)
      const responseText = await response.text()
      if (!response.ok) throw new Error(`Supabase rpc/${path} read failed: ${response.status} ${responseText}`)
      let rows
      try { rows = JSON.parse(responseText) } catch { rows = null }
      if (!Array.isArray(rows)) throw new Error(`Supabase rpc/${path} returned invalid rows`)
      return rows
    })
  }

  async function readV105RecentPerformanceRows(perTableLimit, { requestTimeoutMs = startupTimeoutMs } = {}) {
    const normalizedLimit = Math.min(60, Math.max(1, Number(perTableLimit) || 60))
    if (strategyDb && typeof strategyDb.query === 'function') {
      const result = await strategyDb.query({
        text: 'select * from public.get_v105_recent_performance_rows($1)',
        values: [normalizedLimit],
      })
      if (!Array.isArray(result?.rows)) throw new Error('Direct DB recent-performance function returned invalid rows')
      return result.rows
    }
    return postRpcRows('get_v105_recent_performance_rows', {
      p_per_table_limit: normalizedLimit,
    }, { requestTimeoutMs })
  }

  async function patchRest(path, body, query = {}, { requestTimeoutMs = formalTimeoutMs } = {}) {
    if (!configured) return { skipped: true, reason: 'Supabase backend key is not configured' }
    const endpoint = new URL(`/rest/v1/${path}`, url)
    for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value)
    return withRetry(async () => {
      const response = await fetchWithOptionalTimeout(endpoint, {
        method: 'PATCH',
        headers: {
          ['api' + 'key']: serviceKey,
          ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(body),
      }, requestTimeoutMs)
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

  function enqueueShadowWrite(operation) {
    const next = shadowWriteQueue.catch(() => {}).then(operation)
    shadowWriteQueue = next.catch(() => {})
    return next
  }

  function enqueueV104ShadowWrite(operation) {
    const next = v104ShadowWriteQueue.catch(() => {}).then(operation)
    v104ShadowWriteQueue = next.catch(() => {})
    return next
  }

  function enqueueV104IterationShadowWrite(operation) {
    const next = v104IterationShadowWriteQueue.catch(() => {}).then(operation)
    v104IterationShadowWriteQueue = next.catch(() => {})
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

  async function getRest(path, query = {}, { requestTimeoutMs = 0 } = {}) {
    if (!configured) return null
    const endpoint = new URL(`/rest/v1/${path}`, url)
    for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value)
    const response = await fetchWithOptionalTimeout(endpoint, {
      method: 'GET',
      headers: {
        ['api' + 'key']: serviceKey,
        ['Author' + 'ization']: ['Bearer', serviceKey].join(' '),
        Accept: 'application/json',
      },
    }, requestTimeoutMs)
    if (!response.ok) throw new Error(`Supabase ${path} read failed: ${response.status} ${await response.text()}`)
    return response.json()
  }

  return {
    configured,
    async applyV100RankLedgerEvent(event = {}) {
      const normalized = normalizeExactRealCardEvent(event)
      const source = String(event.source ?? SOURCE)
      const tableId = String(event.tableId ?? event.table_id ?? '')
      const shoe = String(event.shoe ?? '')
      const round = Number(event.round)
      if (!isVerifiedFinalRoundAction(event.sourceAction) || !normalized || !source || !tableId || !shoe
        || !Number.isSafeInteger(round) || round < 1) {
        throw new Error('v102 durable rank event is invalid')
      }
      const acknowledgement = await enqueueWrite(() => postRest('rpc/apply_v105_rank_ledger_event', {
        p_event: {
          source,
          table_id: tableId,
          shoe_no: shoe,
          round_no: round,
          source_action: event.sourceAction,
          raw_result_exact10: normalized.rawResult,
        },
        p_ledger: null,
      }, undefined, { requireObject: true }))
      if (acknowledgement?.accepted !== true) {
        const status = String(acknowledgement?.status ?? 'unavailable')
        if (!['gap', 'conflicted', 'invalid'].includes(status)) throw new Error('v100 durable rank ledger acknowledgement failed')
        return {
          identity: { source, table_id: tableId, shoe },
          status,
          rankDataAvailable: false,
          reason: acknowledgement?.reason ?? null,
          expectedRound: Number(acknowledgement?.expected_round) || null,
          revision: Number(acknowledgement?.revision) || 0,
        }
      }
      const acknowledgedRound = Number(acknowledgement.complete_through_round)
      if (!Number.isSafeInteger(acknowledgedRound) || acknowledgedRound < round) {
        throw new Error('v100 durable rank ledger acknowledgement failed')
      }
      return normalizeV100DurableRankLedger({ ...acknowledgement, source, table_id: tableId, shoe_no: shoe }, { source, tableId, shoe })
    },
    async readV100RankLedger({ source = SOURCE, tableId, shoe } = {}) {
      const normalizedSource = String(source ?? '')
      const normalizedTable = String(tableId ?? '')
      const normalizedShoe = String(shoe ?? '')
      if (!normalizedSource || !normalizedTable || !normalizedShoe) throw new Error('v100 durable rank ledger identity is incomplete')
      const rows = strategyDb && typeof strategyDb.query === 'function'
        ? (await strategyDb.query({
            text: `select source, table_id, shoe_no, complete_through_round,
                          seen_dealt_rank_counts, seen_dealt_code_counts,
                          undealt_after_observed_deals, cards_seen_dealt, status,
                          ledger_checksum, revision, physical_remaining_exact,
                          burn_observation_status
                     from public.shoe_rank_ledgers
                    where source = $1 and table_id = $2 and shoe_no = $3
                    limit 2`,
            values: [normalizedSource, normalizedTable, normalizedShoe],
          })).rows
        : await getRest('shoe_rank_ledgers', {
        select: 'source,table_id,shoe_no,complete_through_round,seen_dealt_rank_counts,seen_dealt_code_counts,undealt_after_observed_deals,cards_seen_dealt,status,ledger_checksum,revision,physical_remaining_exact,burn_observation_status',
        source: `eq.${normalizedSource}`,
        table_id: `eq.${normalizedTable}`,
        shoe_no: `eq.${normalizedShoe}`,
        limit: '2',
      })
      if (!Array.isArray(rows) || rows.length === 0) return null
      if (rows.length !== 1) throw new Error('conflicting v100 durable rank ledger identity')
      return normalizeV100DurableRankLedger(rows[0], { source: normalizedSource, tableId: normalizedTable, shoe: normalizedShoe })
    },
    async reconcilePredictionLifecycle({ source = SOURCE, tableId, currentShoe, currentVisibleRound } = {}) {
      const visibleRound = Number(currentVisibleRound)
      const normalizedShoe = currentShoe == null ? '' : String(currentShoe)
      if (!source || !tableId || !normalizedShoe || !Number.isSafeInteger(visibleRound) || visibleRound < 1) {
        throw new Error('prediction lifecycle reconciliation identity is incomplete')
      }
      const acknowledgement = await enqueueWrite(() => postRest('rpc/reconcile_v105_prediction_lifecycle', {
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
      const acknowledgement = await enqueueWrite(() => postRest('rpc/issue_v105_prediction', { p_prediction: row }, undefined, { requireObject: true }))
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
      }, { requestTimeoutMs: formalTimeoutMs })
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
    async issueV103ShadowPrediction(candidate = {}) {
      const row = buildV103ShadowIssuanceRpcRow(candidate)
      const acknowledgement = await enqueueShadowWrite(() => postRest('rpc/issue_v103_shadow_prediction', { p_prediction: row }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
      const prediction = acknowledgement?.prediction
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || !acknowledgement.prediction_id || !acknowledgement.prediction_issued_at
        || String(prediction.source ?? '') !== String(candidate.source ?? '')
        || String(prediction.targetTableId ?? '') !== String(candidate.targetTableId ?? '')
        || String(prediction.targetShoe ?? '') !== String(candidate.targetShoe ?? '')
        || Number(prediction.targetRound) !== Number(candidate.targetRound)
        || prediction.strategyVersion !== 'v103'
        || prediction.predictionTiming !== 'pre_result_context') {
        throw new Error('v103 shadow issuance acknowledgement failed')
      }
      return structuredClone({ ...prediction, predictionId: acknowledgement.prediction_id, issuedAt: acknowledgement.prediction_issued_at })
    },
    async readV103ShadowIssuance({ source = SOURCE, tableId, shoe, round } = {}) {
      const targetRound = Number(round)
      if (!source || !tableId || shoe == null || !Number.isSafeInteger(targetRound) || targetRound < 1) return null
      const rows = await getRest('v103_shadow_issuances', {
        select: 'id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,prediction_payload',
        source: `eq.${source}`,
        table_id: `eq.${tableId}`,
        shoe_no: `eq.${shoe}`,
        round_no: `eq.${targetRound}`,
        strategy_version: 'eq.v103',
        prediction_timing: 'eq.pre_result_context',
        prediction_issued_at: 'not.is.null',
        limit: '2',
      })
      if (!Array.isArray(rows) || rows.length === 0) return null
      if (rows.length !== 1) throw new Error('conflicting v103 shadow issuance identity')
      const row = rows[0]
      const prediction = row?.prediction_payload
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || String(row.source) !== String(source)
        || String(row.table_id) !== String(tableId)
        || String(row.shoe_no) !== String(shoe)
        || Number(row.round_no) !== targetRound
        || row.strategy_version !== 'v103'
        || row.prediction_timing !== 'pre_result_context'
        || !row.id || !row.prediction_issued_at) throw new Error('v103 shadow issuance read failed')
      return structuredClone({ ...prediction, predictionId: row.id, issuedAt: row.prediction_issued_at })
    },
    async settleV103ShadowPrediction(settlement = {}) {
      const row = buildV103ShadowSettlementRpcRow(settlement)
      const acknowledgement = await enqueueShadowWrite(() => postRest('rpc/settle_v103_shadow_prediction', { p_settlement: row }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
      if (String(acknowledgement?.prediction_id ?? '') !== String(settlement.predictionId ?? '')) throw new Error('v103 shadow settlement acknowledgement failed')
      return { ...acknowledgement, predictionId: acknowledgement.prediction_id }
    },
    async getV103ShadowHistory({ limit = 10000 } = {}) {
      const rows = await getRest('v103_shadow_history', {
        select: 'prediction_id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,predicted_result,actual_result,is_hit,settlement_status,settlement_final,resolved_at',
        strategy_version: 'eq.v103',
        prediction_timing: 'eq.pre_result_context',
        prediction_issued_at: 'not.is.null',
        settlement_final: 'eq.true',
        order: 'resolved_at.desc',
        limit: String(Math.min(10000, Math.max(1, Number(limit) || 10000))),
      })
      return (Array.isArray(rows) ? rows : []).filter((row) => row?.strategy_version === 'v103'
        && row?.prediction_timing === 'pre_result_context'
        && Boolean(row?.prediction_issued_at)
        && row?.settlement_final === true)
    },
    async issueV104ShadowPrediction(candidate = {}) {
      const row = buildV104ShadowIssuanceRpcRow(candidate)
      const acknowledgement = await enqueueV104ShadowWrite(() => postRest('rpc/issue_v104_shadow_prediction', { p_prediction: row }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
      const prediction = acknowledgement?.prediction
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || !acknowledgement.prediction_id || !acknowledgement.prediction_issued_at
        || String(prediction.source ?? '') !== String(candidate.source ?? '')
        || String(prediction.targetTableId ?? '') !== String(candidate.targetTableId ?? '')
        || String(prediction.targetShoe ?? '') !== String(candidate.targetShoe ?? '')
        || Number(prediction.targetRound) !== Number(candidate.targetRound)
        || prediction.strategyVersion !== 'v104'
        || prediction.predictionTiming !== 'pre_result_context') {
        throw new Error('v104 shadow issuance acknowledgement failed')
      }
      return structuredClone({ ...prediction, predictionId: acknowledgement.prediction_id, issuedAt: acknowledgement.prediction_issued_at })
    },
    async readV104ShadowIssuance({ source = SOURCE, tableId, shoe, round } = {}) {
      const targetRound = Number(round)
      if (!source || !tableId || shoe == null || !Number.isSafeInteger(targetRound) || targetRound < 1) return null
      const rows = await getRest('v104_shadow_issuances', {
        select: 'id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,prediction_payload',
        source: `eq.${source}`, table_id: `eq.${tableId}`, shoe_no: `eq.${shoe}`,
        round_no: `eq.${targetRound}`, strategy_version: 'eq.v104',
        prediction_timing: 'eq.pre_result_context', prediction_issued_at: 'not.is.null', limit: '2',
      }, { requestTimeoutMs: shadowTimeoutMs })
      if (!Array.isArray(rows) || rows.length === 0) return null
      if (rows.length !== 1) throw new Error('conflicting v104 shadow issuance identity')
      const row = rows[0]
      const prediction = row?.prediction_payload
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || String(row.source) !== String(source) || String(row.table_id) !== String(tableId)
        || String(row.shoe_no) !== String(shoe) || Number(row.round_no) !== targetRound
        || row.strategy_version !== 'v104' || row.prediction_timing !== 'pre_result_context'
        || !row.id || !row.prediction_issued_at) throw new Error('v104 shadow issuance read failed')
      return structuredClone({ ...prediction, predictionId: row.id, issuedAt: row.prediction_issued_at })
    },
    async settleV104ShadowPrediction(settlement = {}) {
      const row = buildV104ShadowSettlementRpcRow(settlement)
      const acknowledgement = await enqueueV104ShadowWrite(() => postRest('rpc/settle_v104_shadow_prediction', { p_settlement: row }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
      if (String(acknowledgement?.prediction_id ?? '') !== String(settlement.predictionId ?? '')) throw new Error('v104 shadow settlement acknowledgement failed')
      return { ...acknowledgement, predictionId: acknowledgement.prediction_id }
    },
    async getV104ShadowHistory({ limit = 10000 } = {}) {
      const rows = await getRest('v104_shadow_history', {
        select: 'prediction_id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,predicted_result,confidence,prediction_payload,same_side_streak,independent_support_count,shoe_bias_suppressed,lock_risk,actual_result,is_hit,settlement_status,settlement_final,resolved_at',
        strategy_version: 'eq.v104', prediction_timing: 'eq.pre_result_context',
        prediction_issued_at: 'not.is.null', order: 'prediction_issued_at.desc',
        limit: String(Math.min(10000, Math.max(1, Number(limit) || 10000))),
      }, { requestTimeoutMs: shadowTimeoutMs })
      return (Array.isArray(rows) ? rows : []).filter((row) => row?.strategy_version === 'v104'
        && row?.prediction_timing === 'pre_result_context' && Boolean(row?.prediction_issued_at))
    },
    async issueV104IterationShadowPrediction(candidate = {}) {
      const row = buildV104IterationShadowIssuanceRpcRow(candidate)
      const acknowledgement = await enqueueV104IterationShadowWrite(() => postRest('rpc/issue_v104_iteration_shadow_v5_prediction', { p_prediction: row }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
      const prediction = acknowledgement?.prediction
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || !acknowledgement.prediction_id || !acknowledgement.prediction_issued_at
        || String(prediction.source ?? '') !== String(candidate.source ?? '')
        || String(prediction.targetTableId ?? '') !== String(candidate.targetTableId ?? '')
        || String(prediction.targetShoe ?? '') !== String(candidate.targetShoe ?? '')
        || Number(prediction.targetRound) !== Number(candidate.targetRound)
        || prediction.strategyVersion !== 'v104-seven-head-shadow-v5-best-stage-side-reweight'
        || prediction.predictionTiming !== 'pre_result_context'
        || prediction.shadowOnly !== true || prediction.activationEligible !== false
        || prediction.memberVisible !== false || prediction.writesSideActions !== false) {
        throw new Error('v104 iteration shadow issuance acknowledgement failed')
      }
      return structuredClone({ ...prediction, predictionId: acknowledgement.prediction_id, issuedAt: acknowledgement.prediction_issued_at })
    },
    async readV104IterationShadowIssuance({ source = SOURCE, tableId, shoe, round } = {}) {
      const targetRound = Number(round)
      if (!source || !tableId || shoe == null || !Number.isSafeInteger(targetRound) || targetRound < 1) return null
      const rows = await getRest('v104_iteration_shadow_v5_issuances', {
        select: 'id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,prediction_payload',
        source: `eq.${source}`, table_id: `eq.${tableId}`, shoe_no: `eq.${shoe}`,
        round_no: `eq.${targetRound}`, strategy_version: 'eq.v104-seven-head-shadow-v5-best-stage-side-reweight',
        prediction_timing: 'eq.pre_result_context', prediction_issued_at: 'not.is.null', limit: '2',
      }, { requestTimeoutMs: shadowTimeoutMs })
      if (!Array.isArray(rows) || rows.length === 0) return null
      if (rows.length !== 1) throw new Error('conflicting v104 iteration shadow issuance identity')
      const row = rows[0]
      const prediction = row?.prediction_payload
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)
        || String(row.source) !== String(source) || String(row.table_id) !== String(tableId)
        || String(row.shoe_no) !== String(shoe) || Number(row.round_no) !== targetRound
        || row.strategy_version !== 'v104-seven-head-shadow-v5-best-stage-side-reweight' || row.prediction_timing !== 'pre_result_context'
        || !row.id || !row.prediction_issued_at) throw new Error('v104 iteration shadow issuance read failed')
      return structuredClone({ ...prediction, predictionId: row.id, issuedAt: row.prediction_issued_at })
    },
    async settleV104IterationShadowPrediction(settlement = {}) {
      const row = buildV104IterationShadowSettlementRpcRow(settlement)
      const acknowledgement = await enqueueV104IterationShadowWrite(() => postRest('rpc/settle_v104_iteration_shadow_v5_prediction', { p_settlement: row }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
      if (String(acknowledgement?.prediction_id ?? '') !== String(settlement.predictionId ?? '')) throw new Error('v104 iteration shadow settlement acknowledgement failed')
      return { ...acknowledgement, predictionId: acknowledgement.prediction_id }
    },
    async persistV104IterationShadowArtifacts({ report = null, reportSvg = null, suggestions = [] } = {}) {
      if (!Array.isArray(suggestions)) throw new TypeError('v104 iteration shadow suggestions must be an array')
      if (report && (typeof report.cycleNumber !== 'number' || !Number.isSafeInteger(report.cycleNumber) || report.cycleNumber <= 0)) {
        throw new TypeError('v104 iteration shadow cycleNumber must be a positive safe integer')
      }
      const pReport = report ? { report_payload: structuredClone(report), report_svg: String(reportSvg ?? '') } : null
      const acknowledgement = await enqueueV104IterationShadowWrite(() => postRest('rpc/persist_v104_iteration_shadow_v5_artifacts', {
        p_report: pReport, p_suggestions: structuredClone(suggestions),
      }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
      const expectedCycleNumber = report ? report.cycleNumber : null
      const acknowledgedCycleNumber = acknowledgement?.cycle_number
      const acknowledgedSuggestionCount = acknowledgement?.suggestions
      const cycleMatches = report
        ? Number.isSafeInteger(expectedCycleNumber) && expectedCycleNumber > 0
          && typeof acknowledgedCycleNumber === 'number' && Number.isSafeInteger(acknowledgedCycleNumber)
          && acknowledgedCycleNumber === expectedCycleNumber
        : acknowledgedCycleNumber === null
      if (acknowledgement?.persisted !== true
        || typeof acknowledgedSuggestionCount !== 'number'
        || !Number.isSafeInteger(acknowledgedSuggestionCount)
        || acknowledgedSuggestionCount !== suggestions.length
        || !cycleMatches) throw new Error('v104 iteration shadow artifact acknowledgement failed')
      return acknowledgement
    },
    async reviewV104IterationShadowSuggestion({ suggestionId, decision, reviewer } = {}) {
      return enqueueV104IterationShadowWrite(() => postRest('rpc/review_v104_iteration_shadow_v5_suggestion', {
        p_suggestion_id: suggestionId, p_decision: decision, p_reviewer: reviewer,
      }, undefined, { requireObject: true, requestTimeoutMs: shadowTimeoutMs }))
    },
    async getV104IterationShadowCounters() {
      const rows = await getRest('v104_iteration_shadow_v5_sequence_counters', {
        select: 'settlement_count,main_action_count,tie_action_count,super_six_action_count,banker_dragon_action_count,player_dragon_action_count,banker_pair_action_count,player_pair_action_count,updated_at',
        release_candidate: 'eq.v104.5.0-seven-head-shadow.5', limit: '1',
      }, { requestTimeoutMs: shadowTimeoutMs })
      return Array.isArray(rows) && rows.length === 1 ? rows[0] : null
    },
    async getV104IterationShadowSettledRange({ startSequence, endSequence } = {}) {
      const start = Math.max(1, Number(startSequence) || 1)
      const end = Math.max(start, Number(endSequence) || start)
      const rows = await getRest('v104_iteration_shadow_v5_history', {
        select: 'prediction_id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,predicted_result,confidence,prediction_payload,actual_result,actual_facts,is_hit,settlement_status,settlement_final,settlement_source_action,head_results,resolved_at,settlement_sequence,main_action_sequence,tie_action_sequence,super_six_action_sequence,banker_dragon_action_sequence,player_dragon_action_sequence,banker_pair_action_sequence,player_pair_action_sequence',
        strategy_version: 'eq.v104-seven-head-shadow-v5-best-stage-side-reweight', settlement_final: 'eq.true',
        settlement_sequence: `gte.${start}`, and: `(settlement_sequence.lte.${end})`, order: 'settlement_sequence.asc',
        limit: String(Math.min(1000, end - start + 1)),
      }, { requestTimeoutMs: shadowTimeoutMs })
      return Array.isArray(rows) ? rows : []
    },
    async getV104IterationShadowHeadActionRange({ headKey, startAction, endAction } = {}) {
      const fields = {
        main: 'main_action_sequence', tie: 'tie_action_sequence', superSix: 'super_six_action_sequence',
        bankerDragon: 'banker_dragon_action_sequence', playerDragon: 'player_dragon_action_sequence',
        bankerPair: 'banker_pair_action_sequence', playerPair: 'player_pair_action_sequence',
      }
      const sequenceField = fields[headKey]
      if (!sequenceField) throw new Error('invalid v104 iteration shadow head')
      const start = Math.max(1, Number(startAction) || 1)
      const end = Math.max(start, Number(endAction) || start)
      const query = {
        select: 'prediction_id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,predicted_result,confidence,prediction_payload,actual_result,actual_facts,is_hit,settlement_status,settlement_final,settlement_source_action,head_results,resolved_at,settlement_sequence,main_action_sequence,tie_action_sequence,super_six_action_sequence,banker_dragon_action_sequence,player_dragon_action_sequence,banker_pair_action_sequence,player_pair_action_sequence',
        strategy_version: 'eq.v104-seven-head-shadow-v5-best-stage-side-reweight', settlement_final: 'eq.true',
        [sequenceField]: `gte.${start}`, and: `(${sequenceField}.lte.${end})`, order: `${sequenceField}.asc`,
        [`head_results->${headKey}->>action`]: 'eq.true',
        limit: String(Math.min(1000, end - start + 1)),
      }
      const rows = await getRest('v104_iteration_shadow_v5_history', query, { requestTimeoutMs: shadowTimeoutMs })
      return (Array.isArray(rows) ? rows : []).filter((row) => row?.head_results?.[headKey]?.action === true)
    },
    async getV104IterationShadowCycleReports({ limit = 100 } = {}) {
      const cappedLimit = Math.min(50000, Math.max(1, Number(limit) || 100))
      const collected = []
      while (collected.length < cappedLimit) {
        const requestLimit = Math.min(1000, cappedLimit - collected.length)
        const rows = await getRest('v104_iteration_shadow_v5_cycle_reports', {
          select: 'cycle_number,start_sequence,end_sequence,model_version,report_payload,report_svg,created_at',
          order: 'cycle_number.desc', limit: String(requestLimit), offset: String(collected.length),
        }, { requestTimeoutMs: shadowTimeoutMs })
        const page = Array.isArray(rows) ? rows : []
        collected.push(...page)
        if (page.length < requestLimit) break
      }
      return collected
    },
    async getV104IterationShadowSuggestions({ limit = 1000 } = {}) {
      const cappedLimit = Math.min(50000, Math.max(1, Number(limit) || 1000))
      const collected = []
      while (collected.length < cappedLimit) {
        const requestLimit = Math.min(1000, cappedLimit - collected.length)
        const rows = await getRest('v104_iteration_shadow_v5_weight_suggestions', {
          select: 'suggestion_id,head_key,action_cycle,sample_start_action,sample_end_action,model_version,search_method,current_weights,suggested_weights,baseline_metrics,candidate_metrics,status,auto_apply,reviewed_by,reviewed_at,created_at',
          order: 'action_cycle.desc,head_key.asc', limit: String(requestLimit), offset: String(collected.length),
        }, { requestTimeoutMs: shadowTimeoutMs })
        const page = Array.isArray(rows) ? rows : []
        collected.push(...page)
        if (page.length < requestLimit) break
      }
      return collected
    },
    async getV104IterationShadowHistory({ limit = 50000 } = {}) {
      const cappedLimit = Math.min(50000, Math.max(1, Number(limit) || 50000))
      const pageSize = Math.min(1000, cappedLimit)
      const collected = []
      let snapshotBefore = null
      while (collected.length < cappedLimit) {
        const query = {
          select: 'prediction_id,source,table_id,shoe_no,round_no,strategy_version,prediction_timing,prediction_issued_at,predicted_result,confidence,prediction_payload,same_side_streak,actual_result,actual_facts,is_hit,settlement_status,settlement_final,settlement_source_action,head_results,resolved_at,settlement_sequence,main_action_sequence,tie_action_sequence,super_six_action_sequence,banker_dragon_action_sequence,player_dragon_action_sequence,banker_pair_action_sequence,player_pair_action_sequence',
          strategy_version: 'eq.v104-seven-head-shadow-v5-best-stage-side-reweight', prediction_timing: 'eq.pre_result_context',
          prediction_issued_at: snapshotBefore ? `lte.${snapshotBefore}` : 'not.is.null', order: 'prediction_issued_at.desc,prediction_id.desc',
          limit: String(Math.min(pageSize, cappedLimit - collected.length)), offset: String(collected.length),
        }
        const rows = await getRest('v104_iteration_shadow_v5_history', query, { requestTimeoutMs: shadowTimeoutMs })
        const page = Array.isArray(rows) ? rows : []
        if (!snapshotBefore && page.length) snapshotBefore = page[0].prediction_issued_at
        collected.push(...page)
        if (page.length < pageSize) break
      }
      return collected.filter((row) => row?.strategy_version === 'v104-seven-head-shadow-v5-best-stage-side-reweight'
        && row?.prediction_timing === 'pre_result_context' && Boolean(row?.prediction_issued_at))
    },
    async ensureInitialStrategy() {
      try {
        if (await verifyActiveStrategyFromDatabase()) {
          runtimeStatus = { ready: true, degraded: false, reason: null, activeStrategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION }
          return { ok: true, activeStrategyVersion: ALL_MT_EQUAL_STRATEGY_VERSION }
        }
        await patchRest('ai_strategy_versions', { status: 'archived' }, { status: 'eq.active', version: `neq.${ALL_MT_EQUAL_STRATEGY_VERSION}` }, { requestTimeoutMs: startupTimeoutMs })
        await postRest('ai_strategy_versions', buildFormalActiveStrategy(), 'version', { requestTimeoutMs: startupTimeoutMs })
        const activeRows = await getRest('ai_strategy_versions', { select: 'version,status', status: 'eq.active' }, { requestTimeoutMs: startupTimeoutMs })
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
        strategy_version: `eq.${ALL_MT_EQUAL_STRATEGY_VERSION}`,
        settlement_final: 'eq.true',
        order: 'created_at.asc',
        limit: String(Math.min(10000, Math.max(1, Number(limit) || 10000))),
      }
      if (since) query.created_at = `gte.${since}`
      const rows = await getRest('daily_prediction_results', query)
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.strategy_version === ALL_MT_EQUAL_STRATEGY_VERSION)
        .filter(isFinalPredictionSettlement)
    },
    async getV104FormalHistory({ limit = 10000, requestTimeoutMs = 0 } = {}) {
      const rows = await getRest('daily_prediction_results', {
        select: 'id,source,table_id,shoe_no,round_no,strategy_version,predicted_result,actual_result,is_hit,settlement_final,prediction_issued_at,prediction_features,created_at',
        strategy_version: 'eq.v104',
        prediction_issued_at: 'not.is.null',
        order: 'prediction_issued_at.desc',
        limit: String(Math.min(10000, Math.max(1, Number(limit) || 10000))),
      }, { requestTimeoutMs })
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.strategy_version === 'v104'
          && row?.prediction_features?.prediction_timing === 'pre_result_context'
          && Boolean(row?.prediction_issued_at))
        .map((row) => ({
          ...row,
          prediction_id: row.id,
          prediction_timing: row.prediction_features.prediction_timing,
        }))
    },
    async getV105FormalHistory({ limit = 10000, requestTimeoutMs = 0 } = {}) {
      const projectedSelect = 'id,source,table_id,shoe_no,round_no,strategy_version,predicted_result,actual_result,is_hit,settlement_final,prediction_issued_at,created_at,prediction_timing:prediction_features->>prediction_timing,baseline_v104_predicted_result:issued_prediction_payload->>baselineV104PredictedResult,baseline_v104_same_side_streak:issued_prediction_payload->>baselineV104SameSideStreak,issued_same_side_streak:issued_prediction_payload->>sameSideStreak'
      const fetchInBatches = async (fetcher) => {
        const results = []
        for (let index = 0; index < PRODUCTION_TABLE_IDS.length; index += 5) {
          const batch = PRODUCTION_TABLE_IDS.slice(index, index + 5)
          results.push(...await Promise.all(batch.map(fetcher)))
        }
        return results
      }
      const settledRows = await readV105RecentPerformanceRows(60, { requestTimeoutMs })
      const settledByTable = new Map(PRODUCTION_TABLE_IDS.map((tableId) => [tableId, []]))
      for (const row of Array.isArray(settledRows) ? settledRows : []) {
        const tableId = String(row?.table_id ?? '')
        if (settledByTable.has(tableId)) settledByTable.get(tableId).push(row)
      }
      let latestStateByTable
      if (strategyDb && typeof strategyDb.query === 'function') {
        latestStateByTable = []
        for (const tableId of PRODUCTION_TABLE_IDS) {
          const result = await strategyDb.query({
            text: `select id, source, table_id, shoe_no, round_no, strategy_version,
                          predicted_result, actual_result, is_hit, settlement_final,
                          prediction_issued_at, created_at,
                          prediction_features->>'prediction_timing' as prediction_timing,
                          issued_prediction_payload->>'baselineV104PredictedResult' as baseline_v104_predicted_result,
                          issued_prediction_payload->>'baselineV104SameSideStreak' as baseline_v104_same_side_streak,
                          issued_prediction_payload->>'sameSideStreak' as issued_same_side_streak
                     from public.daily_prediction_results
                    where table_id = $1
                      and strategy_version = any($2)
                      and prediction_issued_at is not null
                    order by prediction_issued_at desc
                    limit 1`,
            values: [tableId, ['v104', 'v105']],
          })
          latestStateByTable.push(Array.isArray(result?.rows) ? result.rows : [])
        }
      } else latestStateByTable = await fetchInBatches((tableId) => getRest('daily_prediction_results', {
        select: projectedSelect,
        strategy_version: 'in.(v104,v105)',
        table_id: `eq.${tableId}`,
        prediction_issued_at: 'not.is.null',
        order: 'prediction_issued_at.desc',
        limit: '1',
      }, { requestTimeoutMs }))
      const rowsByTable = PRODUCTION_TABLE_IDS.map((tableId, index) => {
        const settledRows = settledByTable.get(tableId)
        const latestStateRows = latestStateByTable[index]
        const validSettledRows = (Array.isArray(settledRows) ? settledRows : []).filter((row) => (
          String(row?.table_id ?? '') === tableId
          && ['v104', 'v105'].includes(row?.strategy_version)
          && row?.prediction_timing === 'pre_result_context'
          && row?.settlement_final === true
          && Boolean(row?.prediction_issued_at)
        ))
        if (validSettledRows.length < 60) throw new Error(`v105 formal hydration requires 60 settled rows for ${tableId}`)
        const latestState = (Array.isArray(latestStateRows) ? latestStateRows : []).find((row) => (
          String(row?.table_id ?? '') === tableId
          && ['v104', 'v105'].includes(row?.strategy_version)
          && row?.prediction_timing === 'pre_result_context'
          && Boolean(row?.prediction_issued_at)
        ))
        if (!latestState) throw new Error(`v105 formal hydration requires latest issuance state for ${tableId}`)
        return [...validSettledRows, latestState]
      })
      const rowsById = new Map()
      for (const row of rowsByTable.flat()) {
        if (row?.id != null) rowsById.set(String(row.id), { ...rowsById.get(String(row.id)), ...row })
      }
      return [...rowsById.values()]
        .filter((row) => ['v104', 'v105'].includes(row?.strategy_version)
          && row?.prediction_timing === 'pre_result_context'
          && Boolean(row?.prediction_issued_at))
        .sort((left, right) => Date.parse(right.prediction_issued_at) - Date.parse(left.prediction_issued_at))
        .map((row) => ({
          ...row,
          prediction_id: row.id,
          final_v105_predicted_result: row.strategy_version === 'v105' ? row.predicted_result : null,
          predicted_result: row.strategy_version === 'v105'
            ? (row.baseline_v104_predicted_result ?? row.predicted_result)
            : row.predicted_result,
          same_side_streak: row.strategy_version === 'v105'
            ? positiveIntegerOrNull(row.baseline_v104_same_side_streak ?? row.issued_same_side_streak)
            : positiveIntegerOrNull(row.issued_same_side_streak),
        }))
    },
    async getRecentPredictionRows({ limit = 10000 } = {}) {
      const perTableLimit = Math.min(60, Math.max(1, Number(limit) || 60))
      const rows = await readV105RecentPerformanceRows(perTableLimit, { requestTimeoutMs: startupTimeoutMs })
      return rows
        .filter((row) => PRODUCTION_TABLE_IDS.includes(String(row?.table_id ?? '')))
        .filter((row) => row?.strategy_version === ALL_MT_EQUAL_STRATEGY_VERSION)
        .filter((row) => (row?.prediction_timing ?? row?.prediction_features?.prediction_timing) === 'pre_result_context')
        .filter((row) => Boolean(row?.prediction_issued_at))
        .filter(isFinalPredictionSettlement)
    },
    async getTableUiSettledPredictions({ tableId, shoe, limit = 10 } = {}) {
      const boundedLimit = Math.min(10, Math.max(1, Number(limit) || 10))
      const fetchLimit = Math.min(100, boundedLimit * 10)
      const rows = await getRest('daily_prediction_results', {
        select: 'id,table_id,shoe_no,round_no,strategy_version,predicted_result,actual_result,is_hit,settlement_final,side_hits,prediction_features,created_at',
        table_id: `eq.${tableId}`,
        shoe_no: `eq.${shoe}`,
        strategy_version: `eq.${ALL_MT_EQUAL_STRATEGY_VERSION}`,
        settlement_final: 'eq.true',
        order: 'created_at.desc',
        limit: String(fetchLimit),
      })
      const validRows = (Array.isArray(rows) ? rows : [])
        .filter((row) => (
          String(row?.table_id ?? '') === String(tableId)
          && String(row?.shoe_no ?? '') === String(shoe)
          && row?.strategy_version === ALL_MT_EQUAL_STRATEGY_VERSION
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
          ? await postRest('rpc/settle_v105_prediction', {
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
          : await postRest('rpc/persist_v105_settled_round', {
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
        select: 'id,strategy_version,settlement_final',
        created_at: `gte.${since.toISOString()}`,
        strategy_version: `eq.${ALL_MT_EQUAL_STRATEGY_VERSION}`,
        settlement_final: 'eq.true',
      })
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.strategy_version === ALL_MT_EQUAL_STRATEGY_VERSION)
        .filter(isFinalPredictionSettlement).length
    },
    async getPredictionLifecycleStats() {
      const acknowledgement = await postRest('rpc/get_v105_prediction_lifecycle_stats', {}, undefined, { requireObject: true })
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

function positiveIntegerOrNull(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

function isFinalPredictionSettlement(row = {}) {
  return row?.settlement_final === true
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
  const directionalStats = normalizeSettledDirectionalPredictionStats(table)
  const directionalCalibration = {
    settledDirectionalPredictionStats: directionalStats,
    directionalCalibrationSource: directionalStats ? 'provided_settled_directional_prediction_stats' : 'unavailable',
  }
  const directRate = normalizedRate(table.recentHitRate ?? table.tableRecentHitRate ?? table.recent_hit_rate)
  if (directRate != null) {
    return {
      ...directionalCalibration,
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
      ...directionalCalibration,
      recentHitRate: roundRate(hits / total),
      recentPredictionCount: total,
      source: 'provided_recent_hits_misses',
      calculable: true,
    }
  }

  return {
    ...directionalCalibration,
    recentHitRate: null,
    recentPredictionCount: numberOrNull(table.recentPredictionCount ?? table.recent_prediction_count),
    source: 'unavailable',
    calculable: false,
  }
}

function normalizeSettledDirectionalPredictionStats(table = {}) {
  const raw = table.settledDirectionalPredictionStats ?? table.settled_directional_prediction_stats
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    banker: normalizeSettledDirectionStats(raw.banker),
    player: normalizeSettledDirectionStats(raw.player),
  }
}

function normalizeSettledDirectionStats(raw = {}) {
  return {
    settledPredictionCount: numberOrNull(raw?.settledPredictionCount ?? raw?.settled_prediction_count ?? raw?.predictionCount ?? raw?.prediction_count),
    hitRate: normalizedRate(raw?.hitRate ?? raw?.hit_rate),
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
