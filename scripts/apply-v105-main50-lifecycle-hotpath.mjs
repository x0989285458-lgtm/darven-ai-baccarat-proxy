import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from '../proxy/node_modules/pg/lib/index.js'

export const MAIN50_MIGRATION_VERSION = '20260827103000'
export const MAIN50_MIGRATION_NAME = 'v105_lifecycle_hotpath'
const INDEX_NAME = 'daily_prediction_results_v105_lifecycle_hot_idx'
const LOCK_NAME = 'v105-main50-lifecycle-hotpath'

export function parseMain50MigrationSteps(rawSql) {
  const source = String(rawSql)
  const markerPattern = /^-- MAIN50_STEP_(DROP_INDEX|CREATE_INDEX|FUNCTION_CUTOVER)\s*$/gm
  const markers = [...source.matchAll(markerPattern)]
  const names = markers.map((match) => match[1])
  if (JSON.stringify(names) !== JSON.stringify(['DROP_INDEX', 'CREATE_INDEX', 'FUNCTION_CUTOVER'])) {
    throw new Error('Main50 migration markers must be unique and ordered')
  }
  const steps = {}
  for (let index = 0; index < markers.length; index += 1) {
    const start = markers[index].index + markers[index][0].length
    const end = markers[index + 1]?.index ?? source.length
    steps[markers[index][1]] = source.slice(start, end).trim()
  }
  for (const name of ['DROP_INDEX', 'CREATE_INDEX', 'FUNCTION_CUTOVER']) {
    if (!steps[name]) throw new Error(`Main50 migration step is missing: ${name}`)
  }
  if (!/^drop\s+index\s+concurrently/i.test(steps.DROP_INDEX)) throw new Error('Main50 drop-index step is not concurrent')
  if (!/^create\s+index\s+concurrently/i.test(steps.CREATE_INDEX)) throw new Error('Main50 create-index step is not concurrent')
  if (!/create\s+or\s+replace\s+function\s+public\.reconcile_v105_prediction_lifecycle/i.test(steps.FUNCTION_CUTOVER)) {
    throw new Error('Main50 function cutover step is invalid')
  }
  return steps
}

function extractFunctionBody(functionCutoverSql) {
  const match = String(functionCutoverSql).match(/\bas\s+\$\$([\s\S]*?)\$\$\s*;/i)
  if (!match) throw new Error('Main50 function body is missing from immutable migration SQL')
  return match[1].replace(/\r\n/g, '\n').trim()
}

async function verifyHotIndex(db) {
  const result = await db.query(`select i.indisvalid, i.indisready,
      table_ns.nspname as table_schema, table_class.relname as table_name,
      pg_catalog.pg_get_indexdef(i.indexrelid) as index_definition,
      pg_catalog.pg_get_expr(i.indpred, i.indrelid) as predicate
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_class table_class on table_class.oid = i.indrelid
    join pg_catalog.pg_namespace table_ns on table_ns.oid = table_class.relnamespace
    where n.nspname = 'public' and c.relname = $1`, [INDEX_NAME])
  if (result.rows.length !== 1 || result.rows[0].indisvalid !== true || result.rows[0].indisready !== true) {
    throw new Error('Main50 hot index is not valid and ready')
  }
  const row = result.rows[0]
  if (row.table_schema !== 'public' || row.table_name !== 'daily_prediction_results') throw new Error('Main50 hot index targets the wrong table')
  const definition = String(row.index_definition ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!/ on public\.daily_prediction_results using btree \(source, table_id, strategy_version, shoe_no, round_no\) where /.test(definition)) {
    throw new Error('Main50 hot index key definition is incorrect')
  }
  const predicate = String(row.predicate ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const exactPredicates = [
    /^\(*prediction_issued_at is not null\)* and \(*settlement_final is not true\)* and \(\(*issuance_status is null\)* or \(*issuance_status = any \('\{pending,expired_no_final\}'::text\[\]\)\)*\)$/,
    /^\(*prediction_issued_at is not null\)* and \(*settlement_final is not true\)* and \(\(*issuance_status is null\)* or \(*issuance_status = any \(array\['pending'::text, 'expired_no_final'::text\]\)\)*\)$/,
  ]
  if (!exactPredicates.some((pattern) => pattern.test(predicate))) throw new Error('Main50 hot index predicate is not exact')
  return { valid: true, ready: true, predicate }
}

async function verifyFunctionAndAcl(db, expectedFunctionBody) {
  const definitionResult = await db.query(`select pg_catalog.pg_get_functiondef(proc.oid) as definition,
      proc.prosrc, proc.prosecdef, proc.proconfig,
      owner_role.rolname as owner_role
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid = proc.proowner
    where ns.nspname = 'public'
      and proc.oid = 'public.reconcile_v105_prediction_lifecycle(text,text,text,integer)'::pg_catalog.regprocedure`)
  const functionRow = definitionResult.rows[0]
  if (!functionRow || functionRow.prosecdef !== true) throw new Error('Main50 lifecycle function is not SECURITY DEFINER')
  const searchPath = (functionRow.proconfig ?? []).map(String)
  if (searchPath.length !== 1 || searchPath[0].replace(/\s+/g, ' ') !== 'search_path=pg_catalog, public') {
    throw new Error('Main50 lifecycle function search_path is not exact')
  }
  const actualFunctionBody = String(functionRow.prosrc ?? '').replace(/\r\n/g, '\n').trim()
  if (actualFunctionBody !== expectedFunctionBody) throw new Error('Main50 lifecycle function body does not match immutable migration SQL')

  const aclResult = await db.query(`select coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
      expanded.privilege_type::text as privilege_type
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) expanded
    left join pg_catalog.pg_roles grantee_role on grantee_role.oid = expanded.grantee
    where ns.nspname = 'public'
      and proc.proname = 'reconcile_v105_prediction_lifecycle'
      and pg_catalog.pg_get_function_identity_arguments(proc.oid) = 'p_source text, p_table_id text, p_current_shoe text, p_current_visible_round integer'`)
  const grants = aclResult.rows.map((row) => `${row.grantee}:${row.privilege_type}`)
  if (!grants.includes('service_role:EXECUTE')) throw new Error('Main50 lifecycle function service_role EXECUTE grant is missing')
  for (const row of aclResult.rows) {
    if (row.privilege_type === 'EXECUTE' && row.grantee !== 'service_role' && row.grantee !== functionRow.owner_role) {
      throw new Error(`Main50 lifecycle function unexpected EXECUTE grant: ${row.grantee}`)
    }
  }
  return { definition: String(functionRow.definition ?? ''), grants }
}

export async function runMain50LifecycleMigration({ db, rawSql, expectedSha256 }) {
  const actualSha256 = createHash('sha256').update(String(rawSql)).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256 ?? '')) || actualSha256 !== expectedSha256) {
    throw new Error('Main50 migration SQL SHA-256 does not match immutable release binding')
  }
  const steps = parseMain50MigrationSteps(rawSql)
  const expectedFunctionBody = extractFunctionBody(steps.FUNCTION_CUTOVER)
  await db.query(`select pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1, 0))`, [LOCK_NAME])
  try {
    const ledger = await db.query(`select version, name, statements from supabase_migrations.schema_migrations where version = $1`, [MAIN50_MIGRATION_VERSION])
    if (ledger.rows.length > 0) {
      const receipt = ledger.rows[0]
      if (receipt.version !== MAIN50_MIGRATION_VERSION || receipt.name !== MAIN50_MIGRATION_NAME || receipt.statements?.length !== 1 || receipt.statements[0] !== rawSql) {
        throw new Error('Main50 existing migration ledger receipt does not match immutable SQL')
      }
      await verifyHotIndex(db)
      await verifyFunctionAndAcl(db, expectedFunctionBody)
      return { applied: false, alreadyApplied: true, version: MAIN50_MIGRATION_VERSION }
    }

    // These are intentionally separate autocommit statements. Any rejection exits before function cutover.
    await db.query(steps.DROP_INDEX)
    await db.query(steps.CREATE_INDEX)
    await verifyHotIndex(db)

    await db.query('begin')
    try {
      await db.query(steps.FUNCTION_CUTOVER)
      await verifyFunctionAndAcl(db, expectedFunctionBody)
      const receipt = await db.query(`insert into supabase_migrations.schema_migrations(version, statements, name)
        values ($1, array[$2]::text[], $3)
        on conflict (version) do nothing`, [MAIN50_MIGRATION_VERSION, rawSql, MAIN50_MIGRATION_NAME])
      if (receipt.rowCount !== 1) throw new Error('Main50 migration ledger receipt was not inserted')
      await db.query('commit')
    } catch (error) {
      await db.query('rollback')
      throw error
    }

    await verifyHotIndex(db)
    await verifyFunctionAndAcl(db, expectedFunctionBody)
    return { applied: true, alreadyApplied: false, version: MAIN50_MIGRATION_VERSION }
  } finally {
    await db.query(`select pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0))`, [LOCK_NAME]).catch(() => {})
  }
}

function safeError(error) {
  return String(error?.message ?? error ?? 'unknown error').replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DB_URI]')
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  let db
  try {
    if (process.env.MAIN50_APPLY_CONFIRM !== 'APPLY_V105_MAIN50_DB_FIRST') throw new Error('MAIN50_APPLY_CONFIRM is required')
    if (process.env.MAIN50_FORMAL_CONSUMER_STOPPED_CONFIRM !== 'FORMAL_CONSUMER_IS_STOPPED') {
      throw new Error('formal consumer stopped confirmation is required')
    }
    const releaseRef = String(process.env.MAIN50_RELEASE_REF ?? '')
    if (releaseRef !== 'refs/tags/v105-v10-main.50') throw new Error('MAIN50_RELEASE_REF must be the exact Main50 tag')
    const connectionString = String(process.env.SUPABASE_DB_CONNECTION_STRING ?? '')
    if (!connectionString) throw new Error('SUPABASE_DB_CONNECTION_STRING is required')

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const git = (args, encoding = 'utf8') => execFileSync('git', args, { cwd: root, encoding, windowsHide: true })
    const tagCommit = String(git(['rev-parse', `${releaseRef}^{commit}`])).trim()
    const headCommit = String(git(['rev-parse', 'HEAD'])).trim()
    if (headCommit !== tagCommit) throw new Error('Main50 runner HEAD does not match the exact release tag')
    if (String(git(['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Main50 runner requires a clean tracked worktree')

    const migrationPath = 'supabase/migrations/20260827103000_v105_lifecycle_hotpath.sql'
    const manifestPath = 'release/v105-v10-main50-lifecycle-hotpath-release-manifest.json'
    const scriptPath = 'scripts/apply-v105-main50-lifecycle-hotpath.mjs'
    const rawSqlBuffer = git(['show', `${releaseRef}:${migrationPath}`], null)
    const rawSql = rawSqlBuffer.toString('utf8')
    const manifest = JSON.parse(String(git(['show', `${releaseRef}:${manifestPath}`])))
    const expectedSha256 = String(manifest?.releaseBinding?.migration?.sha256 ?? '')
    const taggedScript = git(['show', `${releaseRef}:${scriptPath}`], null)
    const currentScript = await readFile(fileURLToPath(import.meta.url))
    const normalizedCurrentScript = Buffer.from(currentScript.toString('utf8').replace(/\r\n/g, '\n'))
    const scriptSha256 = createHash('sha256').update(taggedScript).digest('hex')
    if (!taggedScript.equals(normalizedCurrentScript) || manifest?.blobSha256?.[scriptPath] !== scriptSha256) {
      throw new Error('Main50 runner script does not match the immutable release binding')
    }

    db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
    await db.connect()
    const result = await runMain50LifecycleMigration({ db, rawSql, expectedSha256 })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`)
    process.exitCode = 1
  } finally {
    await db?.end().catch(() => {})
  }
}
