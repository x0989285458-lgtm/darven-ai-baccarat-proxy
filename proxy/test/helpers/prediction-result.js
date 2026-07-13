import { buildLivePrediction, buildPredictionResultRow as buildStrictPredictionResultRow } from '../../src/supabase-writer.js'

export function buildPredictionResultRow(round = {}, table = {}) {
  const hasExplicitIdentity = String(table.tableId ?? '') === String(round.tableId ?? '')
    && String(table.shoe ?? '') === String(round.shoe ?? '')
    && Number.isInteger(Number(table.round))
    && Number(table.round) === Number(round.round) - 1
  if (!hasExplicitIdentity) throw new Error('explicit pre-result table identity is required')
  return buildStrictPredictionResultRow(round, table, buildLivePrediction(table))
}

