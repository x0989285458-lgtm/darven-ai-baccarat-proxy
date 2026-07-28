import { readFile } from 'node:fs/promises'
import pg from '../proxy/node_modules/pg/lib/index.js'

function safeFailure(error) {
  const raw = String(error?.message ?? error ?? 'migration harness failed')
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-connection]')
    .replace(/(password|secret|token)=?[^\s,;]*/gi, '$1=[redacted]')
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`)
  process.exit(1)
})

const mode = String(process.env.CAPTURE_OUTBOX_TEST_MODE ?? '')
if (!['rollback-only', 'disposable'].includes(mode)) {
  throw new Error('CAPTURE_OUTBOX_TEST_MODE must explicitly be disposable or rollback-only')
}
if (mode === 'disposable' && process.env.CAPTURE_OUTBOX_DISPOSABLE_CONFIRM !== 'DESTROY_AFTER_TEST') {
  throw new Error('disposable mode requires CAPTURE_OUTBOX_DISPOSABLE_CONFIRM=DESTROY_AFTER_TEST')
}
if (mode === 'rollback-only' && process.env.CAPTURE_OUTBOX_ROLLBACK_ONLY_CONFIRM !== 'ROLLBACK_ONLY_NO_COMMIT') {
  throw new Error('rollback-only mode requires CAPTURE_OUTBOX_ROLLBACK_ONLY_CONFIRM=ROLLBACK_ONLY_NO_COMMIT')
}
const connectionString = String(process.env.SUPABASE_DB_CONNECTION_STRING ?? '')
if (!connectionString) throw new Error('SUPABASE_DB_CONNECTION_STRING is required')
const migrationPath = new URL('../supabase/migrations/20260729043000_v105_capture_settlement_outbox.sql', import.meta.url)
const rawSql = await readFile(migrationPath, 'utf8')
const sql = rawSql.replace(/^\s*begin;\s*/i, '').replace(/\s*commit;\s*$/i, '')
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
await db.connect()
let rolledBack = false
try {
  if (mode === 'rollback-only') {
    await db.query('begin')
    await db.query(sql)
  } else {
    await db.query(rawSql)
  }
  const identity = `outbox-migration-test-${Date.now()}`
  const sequence = Date.now()
  const capturedAt = new Date(sequence).toISOString()
  const roundKey = `BAG01:${identity}:1`
  const round = {
    session_id: identity, source: 'ofalive99', table_id: 'BAG01', table_name: 'test',
    shoe_no: identity, round_no: 1, main_result: 'banker', banker_points: 9, player_points: 1,
    raw_event: { tableId: 'BAG01', shoe: identity, round: 1, winner: 'banker', rawResult: [1,9,2,10,-1,-1,-1,-1,1,9], sourceAction: '/summary' },
    table_snapshot: { tableId: 'BAG01', shoe: identity, round: 1 }, received_at: capturedAt, metadata: { test: true },
  }
  const capture = {
    session_id: identity, sequence, round_keys: [roundKey], rounds: [round],
    snapshot: { session_id: identity, capture_source: 'cloud_browser', table_count: 1, tables: [round.table_snapshot], table_summary: [], snapshot_at: capturedAt, metadata: { test: true } },
    status: { session_id: identity, capture_source: 'cloud_browser', connected: true, authenticated: true, table_count: 1, last_message_at: capturedAt, last_round_at: capturedAt, metadata: { test: true } },
    work: { sessionId: identity, status: { connected: true, authenticated: true, tableCount: 1 }, tables: [round.table_snapshot], rounds: [round.raw_event] },
  }
  const first = await db.query('select public.persist_v105_capture_envelope($1::jsonb) as ack', [capture])
  if (first.rows[0]?.ack?.persisted !== true || first.rows[0]?.ack?.duplicate !== false) throw new Error('first persist acknowledgement failed')
  const duplicate = await db.query('select public.persist_v105_capture_envelope($1::jsonb) as ack', [capture])
  if (duplicate.rows[0]?.ack?.duplicate !== true) throw new Error('duplicate persist acknowledgement failed')
  const conflictVariants = [
    ['winner', (candidate) => { candidate.rounds[0].main_result = 'player'; candidate.work.rounds[0].winner = 'player' }],
    ['cards', (candidate) => { candidate.rounds[0].raw_event.rawResult = [2,8,1,9,-1,-1,-1,-1,2,8]; candidate.work.rounds[0].rawResult = [2,8,1,9,-1,-1,-1,-1,2,8] }],
    ['snapshot', (candidate) => { candidate.snapshot.table_count = 9; candidate.work.tables[0].round = 99 }],
    ['status', (candidate) => { candidate.status.connected = false; candidate.work.status.connected = false }],
  ]
  for (const [name, mutate] of conflictVariants) {
    const candidate = structuredClone(capture)
    mutate(candidate)
    let rejected = false
    try {
      if (mode === 'rollback-only') await db.query(`savepoint conflict_${name}`)
      await db.query('select public.persist_v105_capture_envelope($1::jsonb)', [candidate])
    } catch (error) {
      rejected = /capture identity conflict/i.test(String(error?.message))
      if (mode === 'rollback-only') await db.query(`rollback to savepoint conflict_${name}`)
    }
    if (!rejected) throw new Error(`same-sequence ${name} conflict was accepted`)
  }
  const secondRoundKey = `BAG01:${identity}:2`
  const secondCapture = {
    ...capture,
    sequence: sequence + 1,
    round_keys: [secondRoundKey],
    rounds: [{ ...round, round_no: 2, raw_event: { ...round.raw_event, round: 2 }, table_snapshot: { ...round.table_snapshot, round: 2 } }],
    work: { ...capture.work, rounds: [{ ...capture.work.rounds[0], round: 2 }] },
  }
  await db.query('select public.persist_v105_capture_envelope($1::jsonb)', [secondCapture])
  let conflictClosed = false
  try {
    if (mode === 'rollback-only') await db.query('savepoint conflict_probe')
    await db.query('select public.persist_v105_capture_envelope($1::jsonb)', [{ ...capture, work: { ...capture.work, conflict: true } }])
  } catch (error) {
    conflictClosed = /capture identity conflict/i.test(String(error?.message))
    if (mode === 'rollback-only') await db.query('rollback to savepoint conflict_probe')
  }
  if (!conflictClosed) throw new Error('conflicting replay did not fail closed')
  const claimed = await db.query('select session_id, sequence, status, claim_token, attempts from public.claim_v105_capture_settlement_outbox(10)')
  if (claimed.rows.length !== 1 || claimed.rows[0].status !== 'processing') throw new Error('claim did not return one processing item')
  const blockedHealth = await db.query('select public.get_v105_capture_outbox_health() as health')
  const blockedWakeupAt = Date.parse(blockedHealth.rows[0]?.health?.next_wakeup_at ?? '')
  if (!Number.isFinite(blockedWakeupAt) || blockedWakeupAt < Date.now() + (4 * 60 * 1000)) {
    throw new Error('blocked later sequence caused an immediate health wakeup loop')
  }
  await db.query("update public.v105_capture_settlement_outbox set locked_at=now()-interval '6 minutes' where session_id=$1 and sequence=$2", [identity, sequence])
  const reclaimed = await db.query('select session_id, sequence, status, claim_token, attempts from public.claim_v105_capture_settlement_outbox(10)')
  if (reclaimed.rows.length !== 1 || reclaimed.rows[0].status !== 'processing' || reclaimed.rows[0].attempts !== 2
      || reclaimed.rows[0].claim_token === claimed.rows[0].claim_token) {
    throw new Error('stale processing item was not reclaimed after crash timeout')
  }
  let staleCompleteRejected = false
  try {
    if (mode === 'rollback-only') await db.query('savepoint stale_complete_probe')
    await db.query('select public.complete_v105_capture_settlement_outbox($1,$2,$3,$4)', [identity, sequence, claimed.rows[0].claim_token, claimed.rows[0].attempts])
  } catch (error) {
    staleCompleteRejected = /stale lease/i.test(String(error?.message))
    if (mode === 'rollback-only') await db.query('rollback to savepoint stale_complete_probe')
  }
  if (!staleCompleteRejected) throw new Error('old owner completed a newer lease')
  let staleFailRejected = false
  try {
    if (mode === 'rollback-only') await db.query('savepoint stale_fail_probe')
    await db.query('select public.fail_v105_capture_settlement_outbox($1,$2,$3,$4,$5)', [identity, sequence, claimed.rows[0].claim_token, claimed.rows[0].attempts, 'stale owner'])
  } catch (error) {
    staleFailRejected = /stale lease/i.test(String(error?.message))
    if (mode === 'rollback-only') await db.query('rollback to savepoint stale_fail_probe')
  }
  if (!staleFailRejected) throw new Error('old owner failed a newer lease')
  const completed = await db.query('select public.complete_v105_capture_settlement_outbox($1,$2,$3,$4) as ack', [identity, sequence, reclaimed.rows[0].claim_token, reclaimed.rows[0].attempts])
  if (completed.rows[0]?.ack?.completed !== true) throw new Error('completion acknowledgement failed')
  const secondClaim = await db.query('select session_id, sequence, status, claim_token, attempts from public.claim_v105_capture_settlement_outbox(10)')
  if (secondClaim.rows.length !== 1 || Number(secondClaim.rows[0].sequence) !== sequence + 1) throw new Error('same-session outbox sequence advanced out of order')
  await db.query('select public.complete_v105_capture_settlement_outbox($1,$2,$3,$4)', [identity, sequence + 1, secondClaim.rows[0].claim_token, secondClaim.rows[0].attempts])
  let disposableChecks = null
  if (mode === 'disposable') {
    const db2 = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
    await db2.connect()
    try {
      const acl = await db.query(`select
        has_function_privilege('anon', 'public.persist_v105_capture_envelope(jsonb)', 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', 'public.claim_v105_capture_settlement_outbox(integer)', 'EXECUTE') as authenticated_execute,
        has_function_privilege('service_role', 'public.persist_v105_capture_envelope(jsonb)', 'EXECUTE') as service_execute,
        has_table_privilege('service_role', 'public.v105_capture_settlement_outbox', 'SELECT') as service_select,
        has_table_privilege('service_role', 'public.v105_capture_settlement_outbox', 'INSERT') as service_insert`)
      const privileges = acl.rows[0]
      if (privileges.anon_execute || privileges.authenticated_execute || !privileges.service_execute || !privileges.service_select || privileges.service_insert) {
        throw new Error('capture outbox ACL contract failed')
      }

      const makeCapture = (sessionId, itemSequence, roundNo) => {
        const at = new Date(sequence + itemSequence + roundNo).toISOString()
        const item = structuredClone(capture)
        item.session_id = sessionId
        item.sequence = itemSequence
        item.round_keys = [`BAG01:${sessionId}:${roundNo}`]
        item.rounds[0].session_id = sessionId
        item.rounds[0].shoe_no = sessionId
        item.rounds[0].round_no = roundNo
        item.rounds[0].received_at = at
        item.rounds[0].raw_event.shoe = sessionId
        item.rounds[0].raw_event.round = roundNo
        item.rounds[0].table_snapshot.shoe = sessionId
        item.rounds[0].table_snapshot.round = roundNo
        item.snapshot.session_id = sessionId
        item.snapshot.snapshot_at = at
        item.status.session_id = sessionId
        item.status.last_message_at = at
        item.status.last_round_at = at
        item.work.sessionId = sessionId
        item.work.tables[0].shoe = sessionId
        item.work.tables[0].round = roundNo
        item.work.rounds[0].shoe = sessionId
        item.work.rounds[0].round = roundNo
        return item
      }

      const parallelA = makeCapture(`${identity}-parallel-a`, 1, 1)
      const parallelB = makeCapture(`${identity}-parallel-b`, 1, 1)
      await Promise.all([
        db.query('select public.persist_v105_capture_envelope($1::jsonb)', [parallelA]),
        db2.query('select public.persist_v105_capture_envelope($1::jsonb)', [parallelB]),
      ])
      const [ownerA, ownerB] = await Promise.all([
        db.query('select session_id,sequence,claim_token,attempts from public.claim_v105_capture_settlement_outbox(1)'),
        db2.query('select session_id,sequence,claim_token,attempts from public.claim_v105_capture_settlement_outbox(1)'),
      ])
      const concurrentClaims = [...ownerA.rows, ...ownerB.rows]
      if (concurrentClaims.length !== 2 || new Set(concurrentClaims.map((row) => row.session_id)).size !== 2) {
        throw new Error('concurrent claim did not isolate owners')
      }
      await Promise.all(concurrentClaims.map((row, index) => (index === 0 ? db : db2).query(
        'select public.complete_v105_capture_settlement_outbox($1,$2,$3,$4)',
        [row.session_id, row.sequence, row.claim_token, row.attempts],
      )))

      const orderedSession = `${identity}-ordered`
      await db.query('select public.persist_v105_capture_envelope($1::jsonb)', [makeCapture(orderedSession, 1, 1)])
      const outOfOrder = await Promise.allSettled([
        db.query('select public.persist_v105_capture_envelope($1::jsonb)', [makeCapture(orderedSession, 3, 3)]),
        db2.query('select public.persist_v105_capture_envelope($1::jsonb)', [makeCapture(orderedSession, 2, 2)]),
      ])
      if (outOfOrder.every((result) => result.status === 'rejected')) throw new Error('cross-replica monotonic persist made no progress')
      const latest = await db.query('select latest_sequence from public.v105_capture_ingest_sessions where session_id=$1', [orderedSession])
      if (Number(latest.rows[0]?.latest_sequence) !== 3) throw new Error('cross-replica latest_sequence regressed')

      const poisonSession = `${identity}-poison`
      await db.query('select public.persist_v105_capture_envelope($1::jsonb)', [makeCapture(poisonSession, 1, 1)])
      await db.query('select public.persist_v105_capture_envelope($1::jsonb)', [makeCapture(poisonSession, 2, 2)])
      let poison = (await db.query('select * from public.claim_v105_capture_settlement_outbox(100)')).rows.find((row) => row.session_id === poisonSession)
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        if (!poison || Number(poison.attempts) !== attempt) throw new Error('poison attempt sequence mismatch')
        const failed = await db.query('select public.fail_v105_capture_settlement_outbox($1,$2,$3,$4,$5) as ack', [poisonSession, 1, poison.claim_token, poison.attempts, 'synthetic poison'])
        if (attempt === 5) {
          if (failed.rows[0]?.ack?.isolated !== true) throw new Error('poison row was not isolated at max attempts')
        } else {
          await db.query('update public.v105_capture_settlement_outbox set next_attempt_at=now()-interval \'1 second\' where session_id=$1 and sequence=1', [poisonSession])
          poison = (await db.query('select * from public.claim_v105_capture_settlement_outbox(100)')).rows.find((row) => row.session_id === poisonSession)
        }
      }
      const afterPoison = (await db.query('select * from public.claim_v105_capture_settlement_outbox(100)')).rows.find((row) => row.session_id === poisonSession)
      if (Number(afterPoison?.sequence) !== 2) throw new Error('poison isolation blocked the next sequence')
      await db.query('select public.complete_v105_capture_settlement_outbox($1,$2,$3,$4)', [poisonSession, 2, afterPoison.claim_token, afterPoison.attempts])
      const health = await db.query('select public.get_v105_capture_outbox_health() as health')
      if (Number(health.rows[0]?.health?.dead_letter) < 1 || health.rows[0]?.health?.alert !== true) throw new Error('dead-letter health alert missing')
      disposableChecks = { acl: true, concurrentClaim: true, crossReplica: true, poison: true }
    } finally {
      await db2.end()
    }
  }
  const counts = await db.query("select status,count(*)::integer as count from public.v105_capture_settlement_outbox group by status")
  console.log(JSON.stringify({ migration: mode, first: true, duplicate: true, conflictClosed, staleCompleteRejected, staleFailRejected, claimed: claimed.rows.length, reclaimed: reclaimed.rows.length, disposableChecks, counts: counts.rows }))
  if (mode === 'rollback-only') {
    await db.query('rollback')
    rolledBack = true
  }
} finally {
  if (mode === 'rollback-only' && !rolledBack) await db.query('rollback').catch(() => {})
  if (mode === 'rollback-only') {
    const residue = await db.query("select to_regclass('public.v105_capture_settlement_outbox') as relation")
    if (residue.rows[0]?.relation != null) throw new Error('rollback-only migration left catalog residue')
  }
  await db.end()
}
