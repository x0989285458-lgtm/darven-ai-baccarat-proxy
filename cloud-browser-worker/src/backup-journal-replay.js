import { readFile } from 'node:fs/promises'
import { finalHash, finalIdentity, markerHash } from './final-journal.js'
import { canonicalProductionTableId } from './table-policy.js'

export function createBackupJournalReplayProvider({ journalPath, primaryOwnerId } = {}) {
  const target = String(journalPath ?? '').trim()
  const primary = String(primaryOwnerId ?? '').trim()
  if (!target || !primary) throw new Error('backup_journal_configuration_required')

  async function replay(gap = {}, { sessionFingerprint } = {}) {
    const records = await readRecords(target)
    const header = validateHeader(records[0], { sessionFingerprint, primaryOwnerId: primary })
    const finals = new Map()
    const closedShoes = new Map()
    for (const record of records.slice(1)) {
      if (record?.type === 'final') {
        const event = record.event
        const identity = finalIdentity(event)
        const hash = finalHash(event)
        if (record.identity !== identity || record.hash !== hash) throw new Error('backup_journal_corrupt')
        const current = finals.get(identity)
        if (current && current.hash !== hash) throw new Error('backup_journal_identity_conflict')
        finals.set(identity, { event, hash })
      } else if (record?.type === 'shoe_closed') {
        const marker = { tableId: canonicalProductionTableId(record.tableId), shoe: Number(record.shoe), finalRound: Number(record.finalRound) }
        const hash = markerHash(marker)
        if (!Number.isSafeInteger(marker.shoe) || !Number.isSafeInteger(marker.finalRound)
          || marker.finalRound < 1 || record.hash !== hash) throw new Error('backup_journal_corrupt')
        const key = `${marker.tableId}:${marker.shoe}`
        const current = closedShoes.get(key)
        if (current && current.hash !== hash) throw new Error('backup_journal_identity_conflict')
        closedShoes.set(key, { ...marker, hash })
      }
    }
    const selected = selectGapEvents(gap, finals)
    if (gap?.type === 'same_shoe' && selected.length !== (gap.rounds ?? []).length) throw new Error('backup_journal_incomplete')
    const coverage = gap?.type === 'cross_shoe' ? validateCrossShoeCoverage(gap, finals, closedShoes) : null
    if (selected.some((event) => String(event?.source?.ownerId ?? '') !== header.ownerId)) throw new Error('backup_journal_not_independent')
    if (selected.length === 0) throw new Error('backup_journal_incomplete')
    return { events: structuredClone(selected), ...(coverage ? { coverage } : {}) }
  }

  return { available: true, replay }
}

function validateHeader(record, { sessionFingerprint, primaryOwnerId }) {
  const fingerprint = String(sessionFingerprint ?? '')
  const ownerId = String(record?.ownerId ?? '')
  if (record?.type !== 'header' || record?.version !== 1 || !/^[a-f0-9]{64}$/.test(fingerprint)
    || record.sessionFingerprint !== fingerprint || !ownerId || ownerId === primaryOwnerId) {
    throw new Error('second_independent_session_token_required')
  }
  return { sessionFingerprint: fingerprint, ownerId }
}

function validateCrossShoeCoverage(gap, finals, closedShoes) {
  const tableId = canonicalProductionTableId(gap?.tableId)
  const fromShoe = Number(gap?.from?.shoe)
  const fromRound = Number(gap?.from?.round)
  const toShoe = Number(gap?.to?.shoe)
  const toRound = Number(gap?.to?.round)
  if (![fromShoe, fromRound, toShoe, toRound].every(Number.isSafeInteger)
    || toShoe <= fromShoe || toShoe - fromShoe > 1000 || fromRound < 1 || toRound < 1) throw new Error('backup_journal_incomplete')
  for (let shoe = fromShoe; shoe < toShoe; shoe += 1) {
    const marker = closedShoes.get(`${tableId}:${shoe}`)
    if (!marker) throw new Error('backup_journal_incomplete')
    const firstRound = shoe === fromShoe ? fromRound + 1 : 1
    if (marker.finalRound < firstRound - 1) throw new Error('backup_journal_incomplete')
    for (let round = firstRound; round <= marker.finalRound; round += 1) {
      if (!finals.has(`${tableId}:${shoe}:${round}`)) throw new Error('backup_journal_incomplete')
    }
  }
  for (let round = 1; round < toRound; round += 1) {
    if (!finals.has(`${tableId}:${toShoe}:${round}`)) throw new Error('backup_journal_incomplete')
  }
  return { type: 'cross_shoe', tableId, from: { shoe: fromShoe, round: fromRound }, to: { shoe: toShoe, round: toRound } }
}

async function readRecords(target) {
  let text
  try { text = await readFile(target, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('backup_journal_unavailable')
    throw error
  }
  try { return text.split(/\r?\n/).filter(Boolean).map(JSON.parse) } catch (error) {
    throw new Error('backup_journal_corrupt', { cause: error })
  }
}

function selectGapEvents(gap, finals) {
  const tableId = canonicalProductionTableId(gap?.tableId)
  if (gap?.type === 'same_shoe') {
    return (gap.rounds ?? []).map((round) => finals.get(`${tableId}:${Number(gap.shoe)}:${Number(round)}`)?.event ?? null)
      .filter(Boolean)
  }
  if (gap?.type === 'cross_shoe') {
    return [...finals.values()].map((value) => value.event)
      .filter((event) => canonicalProductionTableId(event?.tableId) === tableId && afterCursor(event, gap.from) && beforeLive(event, gap.to))
      .sort((left, right) => Number(left.shoe) - Number(right.shoe) || Number(left.round) - Number(right.round))
  }
  throw new Error('backup_journal_gap_invalid')
}

function afterCursor(event, cursor = {}) {
  return Number(event.shoe) > Number(cursor.shoe)
    || (Number(event.shoe) === Number(cursor.shoe) && Number(event.round) > Number(cursor.round))
}

function beforeLive(event, live = {}) {
  return Number(event.shoe) < Number(live.shoe)
    || (Number(event.shoe) === Number(live.shoe) && Number(event.round) < Number(live.round))
}
