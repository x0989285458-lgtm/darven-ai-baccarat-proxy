import fs from 'node:fs'
import crypto from 'node:crypto'
import pg from '../proxy/node_modules/pg/lib/index.js'

const connectionString = process.env.SUPABASE_DB_CONNECTION_STRING
if (!connectionString) throw new Error('SUPABASE_DB_CONNECTION_STRING is required')
const migrationUrl = new URL('../supabase/migrations/20260828110000_v105_capture_outbox_three_tier_adaptive_batch.sql', import.meta.url)
const raw = fs.readFileSync(migrationUrl, 'utf8')
const sql = raw.replace(/^\s*begin;\s*/i, '').replace(/\s*commit;\s*$/i, '')
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, query_timeout: 120000 })
await db.connect()
const digest = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
let rolledBack = false
try {
  const before = await db.query("select id::text,status,attempts,lease_generation,claim_token::text,locked_at::text,next_attempt_at::text,processed_at::text,isolated_at::text,last_error from public.v105_capture_settlement_outbox where status<>'completed' order by id")
  const beforeHash = digest(before.rows)
  await db.query('begin')
  await db.query('lock table public.v105_capture_settlement_outbox in share row exclusive mode')
  await db.query(sql)
  await db.query("update public.v105_capture_settlement_outbox set status='completed',claim_token=null,locked_at=null,processed_at=coalesce(processed_at,now()) where status<>'completed'")
  const identity = `main61-three-tier-${Date.now()}`
  async function insertRows(session,count) {
    const values=[]; const params=[]
    for(let i=1;i<=count;i++) { const b=params.length; params.push(session,i,JSON.stringify({main61:true,sequence:i})); values.push(`($${b+1},$${b+2},'[]'::jsonb,$${b+3}::jsonb,encode(extensions.digest($${b+1}||':'||$${b+2}::text,'sha256'),'hex'),'pending',0,0,now()+($${b+2}::int*interval '1 millisecond'),now())`) }
    await db.query(`insert into public.v105_capture_settlement_outbox(session_id,sequence,round_keys,payload,payload_hash,status,attempts,lease_generation,created_at,updated_at) values ${values.join(',')}`,params)
  }
  await insertRows(`${identity}-low`,29)
  const low=await db.query('select * from public.claim_v105_capture_settlement_outbox_batch(30)')
  if(low.rows.length!==10) throw new Error(`low tier expected 10 got ${low.rows.length}`)
  await db.query("update public.v105_capture_settlement_outbox set status='completed',claim_token=null,locked_at=null where session_id=$1",[`${identity}-low`])
  await insertRows(`${identity}-mid`,30)
  const mid=await db.query('select * from public.claim_v105_capture_settlement_outbox_batch()')
  if(mid.rows.length!==30) throw new Error(`mid tier expected default 30 got ${mid.rows.length}`)
  await db.query("update public.v105_capture_settlement_outbox set status='completed',claim_token=null,locked_at=null where session_id=$1",[`${identity}-mid`])
  await insertRows(`${identity}-high`,301)
  const high=await db.query('select * from public.claim_v105_capture_settlement_outbox_batch(100)')
  if(high.rows.length!==100) throw new Error(`high tier expected 100 got ${high.rows.length}`)
  await db.query('rollback'); rolledBack=true
  const after=await db.query("select id::text,status,attempts,lease_generation,claim_token::text,locked_at::text,next_attempt_at::text,processed_at::text,isolated_at::text,last_error from public.v105_capture_settlement_outbox where status<>'completed' order by id")
  const afterHash=digest(after.rows)
  if(beforeHash!==afterHash || before.rows.length!==after.rows.length) throw new Error('rollback readback mismatch')
  console.log(JSON.stringify({ok:true,low:10,mid:30,high:100,defaultBatch:30,rollback:true,beforeCount:before.rows.length,afterCount:after.rows.length,stateHash:afterHash}))
} finally {
  if(!rolledBack) await db.query('rollback').catch(()=>{})
  await db.end()
}
