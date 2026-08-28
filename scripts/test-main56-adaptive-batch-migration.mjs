import { readFile } from 'node:fs/promises'
import pg from '../proxy/node_modules/pg/lib/index.js'

const mode = String(process.env.MAIN56_ADAPTIVE_BATCH_TEST_MODE ?? '')
if (mode !== 'rollback-only' || process.env.MAIN56_ADAPTIVE_BATCH_ROLLBACK_CONFIRM !== 'ROLLBACK_ONLY_NO_COMMIT') {
  throw new Error('Main56 adaptive batch test requires rollback-only and ROLLBACK_ONLY_NO_COMMIT')
}
const connectionString = String(process.env.SUPABASE_DB_CONNECTION_STRING ?? '')
if (!connectionString) throw new Error('SUPABASE_DB_CONNECTION_STRING is required')
const migrationPath = new URL('../supabase/migrations/20260828090000_v105_capture_outbox_adaptive_batch.sql', import.meta.url)
const rawSql = await readFile(migrationPath, 'utf8')
const sql = rawSql.replace(/^\s*begin;\s*/i, '').replace(/\s*commit;\s*$/i, '')
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
await db.connect()
let rolledBack = false

async function insertPending(sessionId, count, createdOffsetSeconds) {
  await db.query(`insert into public.v105_capture_settlement_outbox
    (session_id, sequence, round_keys, payload, payload_hash, status, attempts, lease_generation, next_attempt_at, created_at, updated_at)
    select $1, item, '[]'::jsonb, jsonb_build_object('main56_test', true, 'sequence', item),
      encode(extensions.digest($1 || ':' || item::text, 'sha256'), 'hex'), 'pending', 0, 0, null,
      now() + make_interval(secs => $3 + item), now()
    from generate_series(1,$2) as item`, [sessionId, count, createdOffsetSeconds])
}

try {
  await db.query('begin')
  await db.query(sql)
  await db.query('lock table public.v105_capture_settlement_outbox in share row exclusive mode')
  await db.query("update public.v105_capture_settlement_outbox set status='completed', locked_at=null, claim_token=null where status <> 'completed'")
  const identity = `main56-adaptive-${Date.now()}`

  const lowSession = `${identity}-low`
  const highSession = `${identity}-high`
  const barrierSession = `${identity}-barrier`
  await insertPending(lowSession, 20, 0)
  await insertPending(highSession, 301, 1000)
  await insertPending(barrierSession, 302, 2000)
  await db.query(`update public.v105_capture_settlement_outbox
    set status='processing', attempts=1, lease_generation=1,
      claim_token=pg_catalog.gen_random_uuid(), locked_at=now(), updated_at=now()
    where session_id=$1 and sequence=15`, [barrierSession])

  const low = await db.query('select session_id,sequence,claim_token,attempts,status from public.claim_v105_capture_settlement_outbox_batch(100)')
  if (low.rows.length !== 10 || low.rows.some((row) => row.session_id !== lowSession)) {
    throw new Error(`Main56 low session did not claim exactly 10 isolated rows: count=${low.rows.length}`)
  }
  if (low.rows.some((row, index) => Number(row.sequence) !== index + 1 || row.status !== 'processing' || !row.claim_token || Number(row.attempts) !== 1)) {
    throw new Error('Main56 low session did not preserve sequence or exact lease semantics')
  }
  await db.query("update public.v105_capture_settlement_outbox set status='completed', locked_at=null, claim_token=null where session_id=$1", [lowSession])

  const high = await db.query('select session_id,sequence,claim_token,attempts,status from public.claim_v105_capture_settlement_outbox_batch(100)')
  if (high.rows.length !== 100 || high.rows.some((row) => row.session_id !== highSession)) {
    throw new Error(`Main56 high session did not claim exactly 100 isolated rows: count=${high.rows.length}`)
  }
  if (high.rows.some((row, index) => Number(row.sequence) !== index + 1 || row.status !== 'processing' || !row.claim_token || Number(row.attempts) !== 1)) {
    throw new Error('Main56 high session did not preserve sequence or exact lease semantics')
  }

  const barrier = await db.query('select session_id,sequence,claim_token,attempts,status from public.claim_v105_capture_settlement_outbox_batch(100)')
  if (barrier.rows.length !== 10 || barrier.rows.some((row) => row.session_id !== barrierSession)) {
    throw new Error(`Main56 barrier session did not stay on the low-water batch: count=${barrier.rows.length}`)
  }
  if (barrier.rows.some((row, index) => Number(row.sequence) !== index + 1)) {
    throw new Error('Main56 barrier session did not preserve the claimable sequence prefix')
  }

  await db.query('savepoint request101')
  let request101Rejected = false
  try {
    await db.query('select * from public.claim_v105_capture_settlement_outbox_batch(101)')
  } catch (error) {
    request101Rejected = /batch limit must be between 1 and 100/i.test(String(error?.message))
    await db.query('rollback to savepoint request101')
  }
  if (!request101Rejected) throw new Error('Main56 DB accepted claim request 101')

  const definition = await db.query("select lower(pg_get_functiondef('public.claim_v105_capture_settlement_outbox_batch(integer)'::regprocedure)) as definition")
  if (!definition.rows[0]?.definition?.includes('offset 300') || !definition.rows[0].definition.includes('then 100 else 10')) {
    throw new Error('Main56 installed claim definition does not bind adaptive 301/100/10 policy')
  }

  await db.query('rollback')
  rolledBack = true
  console.log(JSON.stringify({ ok: true, lowSessionClaimed: 10, highSessionClaimed: 100, barrierSessionClaimed: 10, request101Rejected: true, crossSessionIsolated: true, rollback: true }))
} finally {
  if (!rolledBack) await db.query('rollback').catch(() => {})
  await db.end()
}
