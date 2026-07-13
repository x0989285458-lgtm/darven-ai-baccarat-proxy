import { buildLivePrediction, buildPredictionResultRow as buildStrictPredictionResultRow } from '../../src/supabase-writer.js'

export function buildPredictionResultRow(round = {}, table = {}) {
  const preResultTable = {
    ...table,
    tableId: round.tableId,
    shoe: round.shoe,
    round: Number(round.round) - 1,
  }
  return buildStrictPredictionResultRow(round, table, buildLivePrediction(preResultTable))
}

