import { isExactTenRawResult, normalizeExactRealCardEvent } from '../../shared/real-card-validator.js'
import { canonicalProductionTableId, PRODUCTION_TABLE_IDS } from './table-policy.js'

export const RECORD_PROTOCOL_EVIDENCE = Object.freeze({
  endpoint: 'wss://a1.ofalive99.net/game/ws',
  method: 'GET',
  action: '/api/v1/gametype/*/game/*/record',
  observedPayload: Object.freeze({ table_id: 'room_id', shoe: 'summary.shoe', round: 'summary.round' }),
  prerequisite: 'Game authenticate plus exact ten-table join was active',
  observed: Object.freeze({ requests: 22, responses: 21, err: 0, nonempty: 0, valid: 0 }),
  bundleProbe: 'access_restricted_no_bundle',
  contractStatus: 'unverified',
})

export function buildRecordRequest(input, { contract = null } = {}) {
  if (contract?.status !== 'verified' || typeof contract?.buildData !== 'function') throw new Error('record_contract_unverified')
  return {
    method: contract.method ?? 'GET',
    action: {
      name: contract.action ?? RECORD_PROTOCOL_EVIDENCE.action,
      data: contract.buildData(structuredClone(input)),
    },
  }
}

export function parseRecordResponse(response = {}) {
  if (Number(response?.err) !== 0 || !Array.isArray(response?.msg?.game)) return []
  return response.msg.game.flatMap((game) => {
    const sourceAction = normalizeFinalAction(game?.sourceAction ?? game?.action)
    if (!sourceAction) return []
    const rawResult = Array.isArray(game?.result)
      ? game.result.map(Number)
      : String(game?.result ?? '').split(',').filter(Boolean).map(Number)
    if (!isExactTenRawResult(rawResult)) return []
    const normalized = normalizeExactRealCardEvent({ rawResult })
    const tableId = canonicalProductionTableId(game?.tableId ?? game?.table_id)
    const shoe = Number(game?.shoe)
    const round = Number(game?.round)
    if (!normalized || !PRODUCTION_TABLE_IDS.includes(tableId)
      || !Number.isSafeInteger(shoe)
      || !Number.isSafeInteger(round) || round < 1) return []
    return [{
      tableId,
      roomId: Number(game?.roomId ?? game?.room_id),
      shoe,
      round,
      winner: normalized.result,
      rawResult: normalized.rawResult,
      playerPoint: normalized.playerPoint,
      bankerPoint: normalized.bankerPoint,
      sourceAction,
      final: true,
    }]
  })
}

export function createAuthoritativeReplayProvider({
  recordProvider = null,
  backupProvider = null,
  verifyBackupSession = null,
} = {}) {
  async function replay(gap) {
    if (recordProvider?.available === true && typeof recordProvider.replay === 'function') {
      const result = normalizeProviderResult(await recordProvider.replay(gap))
      return { ok: true, events: validateReplayEvents(result.events), ...(result.coverage ? { coverage: result.coverage } : {}), provider: 'record' }
    }
    const gate = typeof verifyBackupSession === 'function' ? await verifyBackupSession() : null
    if (gate?.ok !== true || !gate.backupFingerprint) {
      return { ok: false, events: [], liveGate: 'second_independent_session_token_required' }
    }
    if (typeof backupProvider?.replay !== 'function') return { ok: false, events: [], liveGate: 'backup_journal_provider_unavailable' }
    const result = normalizeProviderResult(await backupProvider.replay(gap, { sessionFingerprint: gate.backupFingerprint }))
    return { ok: true, events: validateReplayEvents(result.events), ...(result.coverage ? { coverage: result.coverage } : {}), provider: 'backup_journal' }
  }
  return { replay }
}

export function createIndependentSessionTokenGate({
  readPrimaryToken,
  backupTokenFile,
  readBackupToken = async () => readFile(String(backupTokenFile ?? ''), 'utf8'),
} = {}) {
  return async function verifyBackupSession() {
    try {
      if (typeof readPrimaryToken !== 'function' || (!String(backupTokenFile ?? '').trim() && !readBackupToken)) throw new Error('token_source_missing')
      const primaryToken = String(await readPrimaryToken()).trim()
      const backupToken = String(await readBackupToken()).trim()
      if (!primaryToken || !backupToken) throw new Error('token_empty')
      const primaryFingerprint = sessionTokenFingerprint(primaryToken)
      const backupFingerprint = sessionTokenFingerprint(backupToken)
      if (primaryFingerprint === backupFingerprint) throw new Error('token_not_independent')
      return { ok: true, primaryFingerprint, backupFingerprint }
    } catch {
      return { ok: false, liveGate: 'second_independent_session_token_required' }
    }
  }
}

export function sessionTokenFingerprint(token) {
  const value = String(token ?? '').trim()
  if (!value) throw new Error('session_token_required')
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeProviderResult(result) {
  return Array.isArray(result) ? { events: result } : { events: result?.events, coverage: result?.coverage }
}

function validateReplayEvents(events) {
  if (!Array.isArray(events)) throw new Error('replay_provider_invalid')
  for (const event of events) {
    if (!PRODUCTION_TABLE_IDS.includes(canonicalProductionTableId(event?.tableId))
      || !isExactTenRawResult(event?.rawResult)
      || !normalizeFinalAction(event?.sourceAction)) throw new Error('replay_provider_invalid')
  }
  return structuredClone(events)
}

function normalizeFinalAction(value) {
  const action = String(value ?? '')
  if (action === 'summary' || action.endsWith('/summary')) return 'summary'
  return null
}
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
