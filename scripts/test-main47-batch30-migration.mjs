import { readFile } from 'node:fs/promises'
import pg from '../proxy/node_modules/pg/lib/index.js'

const mode = String(process.env.MAIN47_BATCH30_TEST_MODE ?? '')
if (mode !== 'rollback-only' || process.env.MAIN47_BATCH30_ROLLBACK_CONFIRM !== 'ROLLBACK_ONLY_NO_COMMIT') {
  throw new Error('Main47 batch30 test requires rollback-only and ROLLBACK_ONLY_NO_COMMIT')
}
const connectionString = String(process.env.SUPABASE_DB_CONNECTION_STRING ?? '')
if (!connectionString) throw new Error('SUPABASE_DB_CONNECTION_STRING is required')
const migrationPath = new URL('../supabase/migrations/20260827010000_v105_capture_outbox_batch30_contract.sql', import.meta.url)
const rawSql = await readFile(migrationPath, 'utf8')
const sql = rawSql.replace(/^\s*begin;\s*/i, '').replace(/\s*commit;\s*$/i, '')
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
await db.connect()
let rolledBack = false
const claimsFor = (rows) => rows.map((row) => ({ session_id: row.session_id, sequence: Number(row.sequence), claim_token: row.claim_token, attempt: Number(row.attempts) }))
async function insertThirty(sessionId) {
  await db.query(`insert into public.v105_capture_settlement_outbox
    (session_id, sequence, round_keys, payload, payload_hash, status, attempts, lease_generation, created_at, updated_at)
    select $1, item, '[]'::jsonb, jsonb_build_object('main47_test', true, 'sequence', item),
      encode(extensions.digest($1 || ':' || item::text, 'sha256'), 'hex'), 'pending', 0, 0,
      now() + make_interval(secs => item), now()
    from generate_series(1,30) as item`, [sessionId])
}
try {
  await db.query('begin')
  await db.query(sql)
  await db.query('lock table public.v105_capture_settlement_outbox in share row exclusive mode')
  const identity = `main47-batch30-${Date.now()}`
  await db.query("update public.v105_capture_settlement_outbox set status='completed', locked_at=null, claim_token=null where status <> 'completed'")

  await insertThirty(`${identity}-complete`)
  const claimedForComplete = await db.query('select session_id,sequence,claim_token,attempts,status from public.claim_v105_capture_settlement_outbox_batch(30)')
  if (claimedForComplete.rows.length !== 30 || claimedForComplete.rows.some((row) => row.status !== 'processing' || row.session_id !== `${identity}-complete`)) throw new Error('Main47 DB did not claim exactly 30 exact-session leases')
  const completed = await db.query('select public.complete_v105_capture_settlement_outbox_batch($1::jsonb) as ack', [JSON.stringify(claimsFor(claimedForComplete.rows))])
  if (completed.rows[0]?.ack?.completed !== true || Number(completed.rows[0]?.ack?.count) !== 30) throw new Error('Main47 DB did not complete exactly 30 leases')

  await insertThirty(`${identity}-fail`)
  const claimedForFail = await db.query('select session_id,sequence,claim_token,attempts,status from public.claim_v105_capture_settlement_outbox_batch(30)')
  if (claimedForFail.rows.length !== 30 || claimedForFail.rows.some((row) => row.status !== 'processing' || row.session_id !== `${identity}-fail`)) {
    const sessions = [...new Set(claimedForFail.rows.map((row) => row.session_id))]
    throw new Error(`Main47 DB did not claim second exact-session 30-lease batch: count=${claimedForFail.rows.length} sessions=${sessions.join(',')}`)
  }
  const failed = await db.query('select public.fail_v105_capture_settlement_outbox_batch($1::jsonb,$2) as ack', [JSON.stringify(claimsFor(claimedForFail.rows)), 'main47 rollback-only probe'])
  if (failed.rows[0]?.ack?.failed !== true || Number(failed.rows[0]?.ack?.count) !== 30) throw new Error('Main47 DB did not fail exactly 30 leases')

  const poisonSession = `${identity}-poison`
  await db.query(`insert into public.v105_capture_settlement_outbox
    (session_id, sequence, round_keys, payload, payload_hash, status, attempts, lease_generation, next_attempt_at, created_at, updated_at)
    values
      ($1, 1, '[]'::jsonb, '{"main47_poison":true}'::jsonb, encode(extensions.digest($1 || ':1', 'sha256'), 'hex'), 'error', 5, 5, now()-interval '1 second', now(), now()),
      ($1, 2, '[]'::jsonb, '{"main47_after_poison":true}'::jsonb, encode(extensions.digest($1 || ':2', 'sha256'), 'hex'), 'pending', 0, 0, null, now()+interval '1 second', now())`, [poisonSession])
  const afterPoison = await db.query('select session_id,sequence,claim_token,attempts,status from public.claim_v105_capture_settlement_outbox_batch(30)')
  if (afterPoison.rows.length !== 1 || afterPoison.rows[0].session_id !== poisonSession || Number(afterPoison.rows[0].sequence) !== 2) throw new Error('Main47 DB poison isolation did not unblock the next exact-session sequence')
  const poisonState = await db.query('select status from public.v105_capture_settlement_outbox where session_id=$1 and sequence=1', [poisonSession])
  if (poisonState.rows[0]?.status !== 'dead_letter') throw new Error('Main47 DB did not isolate max-attempt poison row')
  await db.query('select public.complete_v105_capture_settlement_outbox_batch($1::jsonb)', [JSON.stringify(claimsFor(afterPoison.rows))])

  const thirtyOne = Array.from({ length: 31 }, (_, index) => ({ session_id: `${identity}-invalid`, sequence: index + 1, claim_token: '00000000-0000-0000-0000-000000000001', attempt: 1 }))
  let complete31Rejected = false
  await db.query('savepoint complete31')
  try { await db.query('select public.complete_v105_capture_settlement_outbox_batch($1::jsonb)', [JSON.stringify(thirtyOne)]) }
  catch (error) { complete31Rejected = /batch claim identity is invalid/i.test(String(error?.message)); await db.query('rollback to savepoint complete31') }
  if (!complete31Rejected) throw new Error('Main47 DB accepted 31 completion claims')
  let fail31Rejected = false
  await db.query('savepoint fail31')
  try { await db.query('select public.fail_v105_capture_settlement_outbox_batch($1::jsonb,$2)', [JSON.stringify(thirtyOne), 'invalid']) }
  catch (error) { fail31Rejected = /batch claim identity is invalid/i.test(String(error?.message)); await db.query('rollback to savepoint fail31') }
  if (!fail31Rejected) throw new Error('Main47 DB accepted 31 failure claims')

  const definitions = await db.query(`select proname,lower(pg_get_functiondef(p.oid)) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('claim_v105_capture_settlement_outbox_batch','complete_v105_capture_settlement_outbox_batch','fail_v105_capture_settlement_outbox_batch')`)
  if (definitions.rows.length !== 3 || !definitions.rows.every((row) => row.definition.includes('30'))) throw new Error('Main47 installed definitions do not bind batch30')
  await db.query('rollback'); rolledBack = true
  console.log(JSON.stringify({ ok: true, exactSessionClaims: true, claimed: 30, completed: 30, failed: 30, poisonIsolated: true, rejected31: true, rollback: true }))
} finally {
  if (!rolledBack) await db.query('rollback').catch(() => {})
  await db.end()
}
