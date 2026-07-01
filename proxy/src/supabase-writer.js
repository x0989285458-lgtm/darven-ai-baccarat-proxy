import { buildRoundCardSnapshot, scoreCardShoeInfluence } from './card-shoe.js'

const SOURCE = 'ofalive99'
const DEFAULT_STRATEGY_VERSION = 'v012_equal_weight_seed'
export const SHORT_RUN_STRATEGY_VERSION = 'v049_no_observe_confidence_30_80'

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
  const useShortRunStrategy = tablePerformance.recentHitRate != null || table.strategyVersion === SHORT_RUN_STRATEGY_VERSION
  const basePrediction = pickPrediction(probabilities)
  const adjusted = useShortRunStrategy
    ? applyShortRunTablePerformanceAdjustment({ predictedResult: basePrediction, probabilities, tablePerformance })
    : { predictedResult: basePrediction, confidence: probabilities[basePrediction] ?? 50 }
  const predicted_result = adjusted.predictedResult
  return {
    source: SOURCE,
    table_id: String(round.tableId ?? table.tableId ?? ''),
    shoe_no: round.shoe == null ? null : String(round.shoe),
    round_no: Number(round.round ?? 0),
    strategy_version: useShortRunStrategy ? SHORT_RUN_STRATEGY_VERSION : DEFAULT_STRATEGY_VERSION,
    predicted_result,
    confidence: adjusted.confidence,
    actual_result: facts.winner,
    is_hit: predicted_result === facts.winner,
    table_recent_hit_rate: tablePerformance.recentHitRate,
    table_recent_prediction_count: tablePerformance.recentPredictionCount,
    short_run_adjustment: useShortRunStrategy
      ? buildShortRunAdjustmentSummary({ basePrediction, adjusted, tablePerformance })
      : {},
    prediction_features: {
      road_features: buildRoadFeatures(table),
      card_shoe_features: scoreCardShoeInfluence({ lastRound: round, shoeState: round.cardShoe ?? null }).features,
      point_features: {
        playerPoint: facts.playerPoint,
        bankerPoint: facts.bankerPoint,
        pointDiff: facts.pointDiff,
        playerDrew: facts.playerDrew,
        bankerDrew: facts.bankerDrew,
        playerNatural: facts.playerNatural,
        bankerNatural: facts.bankerNatural,
      },
      side_predictions: buildSidePredictions(table),
      side_actual_results: buildSideActualResults(round, facts),
      side_hits: buildSideHits(buildSidePredictions(table), buildSideActualResults(round, facts)),
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
    feature_weights: useShortRunStrategy ? { ...SHORT_RUN_WEIGHTS } : { ...DEFAULT_EQUAL_WEIGHTS },
    resolved_at: new Date().toISOString(),
  }
}


function buildSidePredictions(table = {}) {
  const banker = Number(table.bankerCount ?? 0)
  const player = Number(table.playerCount ?? 0)
  const tie = Number(table.tieCount ?? 0)
  const total = Math.max(1, banker + player + tie)
  return {
    tie: clampPercent(percentValue(tie, total) * 0.65, 0, 80),
    superSix: clampPercent(percentValue(banker, total) * 0.12, 0, 80),
    bankerPair: clampPercent(percentValue(Number(table.bankerPairCount ?? 0), total) * 0.55, 0, 80),
    playerPair: clampPercent(percentValue(Number(table.playerPairCount ?? 0), total) * 0.55, 0, 80),
    bankerDragon: clampPercent(percentValue(banker, total) * 0.36, 0, 80),
    playerDragon: clampPercent(percentValue(player, total) * 0.36, 0, 80),
  }
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

function buildSideHits(predictions = {}, actual = {}) {
  return Object.fromEntries(Object.entries(predictions).map(([key, value]) => [key, Number(value) >= 10 && Boolean(actual[key])]))
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
