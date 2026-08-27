import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseMain50MigrationSteps, runMain50LifecycleMigration } from '../../scripts/apply-v105-main50-lifecycle-hotpath.mjs'

const rawSql = readFileSync(new URL('../../supabase/migrations/20260827103000_v105_lifecycle_hotpath.sql', import.meta.url), 'utf8')
const expectedSha256 = createHash('sha256').update(rawSql).digest('hex')
const expectedFunctionBody = parseMain50MigrationSteps(rawSql).FUNCTION_CUTOVER.match(/\bas\s+\$\$([\s\S]*?)\$\$\s*;/i)[1].replace(/\r\n/g, '\n').trim()
const run = (db, sql = rawSql, sha256 = expectedSha256) => runMain50LifecycleMigration({ db, rawSql: sql, expectedSha256: sha256 })

class FakeDb {
  constructor({ createError = null, indexReady = true, functionError = null, alreadyApplied = false,
    ledgerValid = true, ledgerVersionValid = true, indexExact = true, functionExact = true, extraAcl = false } = {}) {
    Object.assign(this, { createError, indexReady, functionError, alreadyApplied, ledgerValid, ledgerVersionValid, indexExact, functionExact, extraAcl })
    this.calls = []
  }
  async query(text, params = []) {
    const sql = String(text)
    this.calls.push({ sql, params })
    if (/select version, name, statements from supabase_migrations\.schema_migrations/i.test(sql)) {
      const rows = this.alreadyApplied ? [{
        version: this.ledgerVersionValid ? '20260827103000' : 'WRONG_VERSION',
        name: this.ledgerValid ? 'v105_lifecycle_hotpath' : 'wrong_name',
        statements: [this.ledgerValid ? rawSql : 'select drifted'],
      }] : []
      return { rows, rowCount: rows.length }
    }
    if (/drop index concurrently/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/create index concurrently/i.test(sql)) {
      if (this.createError) throw this.createError
      return { rows: [], rowCount: 0 }
    }
    if (/from pg_catalog\.pg_index/i.test(sql)) {
      return { rows: [{
        indisvalid: this.indexReady,
        indisready: this.indexReady,
        table_schema: 'public',
        table_name: this.indexExact ? 'daily_prediction_results' : 'wrong_table',
        index_definition: 'CREATE INDEX daily_prediction_results_v105_lifecycle_hot_idx ON public.daily_prediction_results USING btree (source, table_id, strategy_version, shoe_no, round_no) WHERE ((prediction_issued_at IS NOT NULL) AND (settlement_final IS NOT TRUE) AND ((issuance_status IS NULL) OR (issuance_status = ANY (\'{pending,expired_no_final}\'::text[]))))',
        predicate: this.indexExact
          ? "((prediction_issued_at IS NOT NULL) AND (settlement_final IS NOT TRUE) AND ((issuance_status IS NULL) OR (issuance_status = ANY ('{pending,expired_no_final}'::text[]))))"
          : '(prediction_issued_at IS NOT NULL) OR (settlement_final IS NOT TRUE)',
      }], rowCount: 1 }
    }
    if (/create or replace function public\.reconcile_v105_prediction_lifecycle/i.test(sql)) {
      if (this.functionError) throw this.functionError
      return { rows: [], rowCount: 0 }
    }
    if (/pg_get_functiondef/i.test(sql)) {
      return { rows: [{
        definition: this.functionExact
          ? "CREATE FUNCTION public.reconcile_v105_prediction_lifecycle(...) SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'"
          : "CREATE FUNCTION public.reconcile_v105_prediction_lifecycle(...) SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'",
        prosrc: this.functionExact
          ? expectedFunctionBody
          : "begin\n  -- strategy_version = 'v105'; source = p_source; table_id = p_table_id; prediction_issued_at is not null; settlement_final is not true; issuance_status = 'pending'; issuance_status = 'expired_no_final'\n  update public.daily_prediction_results set issuance_status = 'pending' where true;\nend;",
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, public'],
        owner_role: 'postgres',
      }], rowCount: 1 }
    }
    if (/aclexplode/i.test(sql)) {
      const rows = [{ grantee: 'service_role', privilege_type: 'EXECUTE' }]
      if (this.extraAcl) rows.push({ grantee: 'unexpected_role', privilege_type: 'EXECUTE' })
      return { rows, rowCount: rows.length }
    }
    if (/insert into supabase_migrations\.schema_migrations/i.test(sql)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
}

const callsMatching = (db, pattern) => db.calls.filter(({ sql }) => pattern.test(sql))

test('Main50 parser requires exactly one ordered marker for every migration step', () => {
  assert.deepEqual(Object.keys(parseMain50MigrationSteps(rawSql)), ['DROP_INDEX', 'CREATE_INDEX', 'FUNCTION_CUTOVER'])
  const reordered = rawSql.replace('MAIN50_STEP_DROP_INDEX', 'MAIN50_STEP_TEMP').replace('MAIN50_STEP_CREATE_INDEX', 'MAIN50_STEP_DROP_INDEX').replace('MAIN50_STEP_TEMP', 'MAIN50_STEP_CREATE_INDEX')
  assert.throws(() => parseMain50MigrationSteps(reordered), /unique and ordered/)
  assert.throws(() => parseMain50MigrationSteps(`${rawSql}\n-- MAIN50_STEP_DROP_INDEX\ndrop index concurrently if exists duplicate;`), /unique and ordered/)
})

test('Main50 runner rejects SQL bytes that do not match immutable SHA-256 before any DB call', async () => {
  const db = new FakeDb()
  await assert.rejects(run(db, `${rawSql}\n-- drift`, expectedSha256), /SHA-256/)
  assert.equal(db.calls.length, 0)
})

test('Main50 runner stops before function cutover and ledger when concurrent index creation fails', async () => {
  const db = new FakeDb({ createError: new Error('concurrent index build failed') })
  await assert.rejects(run(db), /concurrent index build failed/)
  assert.equal(callsMatching(db, /create or replace function public\.reconcile_v105_prediction_lifecycle/i).length, 0)
  assert.equal(callsMatching(db, /insert into supabase_migrations\.schema_migrations/i).length, 0)
})

test('Main50 runner stops before function cutover when index catalog is not valid and ready', async () => {
  const db = new FakeDb({ indexReady: false })
  await assert.rejects(run(db), /not valid and ready/)
  assert.equal(callsMatching(db, /create or replace function public\.reconcile_v105_prediction_lifecycle/i).length, 0)
})

test('Main50 runner rejects an inexact index target or predicate', async () => {
  await assert.rejects(run(new FakeDb({ indexExact: false })), /wrong table|predicate is not exact/)
})

test('Main50 runner cuts over function and migration ledger only after exact valid index readback', async () => {
  const db = new FakeDb()
  const result = await run(db)
  assert.equal(result.applied, true)
  const createIndexAt = db.calls.findIndex(({ sql }) => /create index concurrently/i.test(sql))
  const indexReadbackAt = db.calls.findIndex(({ sql }) => /from pg_catalog\.pg_index/i.test(sql))
  const beginAt = db.calls.findIndex(({ sql }) => /^begin$/i.test(sql.trim()))
  const functionAt = db.calls.findIndex(({ sql }) => /create or replace function public\.reconcile_v105_prediction_lifecycle/i.test(sql))
  const ledgerAt = db.calls.findIndex(({ sql }) => /insert into supabase_migrations\.schema_migrations/i.test(sql))
  const commitAt = db.calls.findIndex(({ sql }) => /^commit$/i.test(sql.trim()))
  assert.ok(createIndexAt < indexReadbackAt && indexReadbackAt < beginAt && beginAt < functionAt && functionAt < ledgerAt && ledgerAt < commitAt)
})

test('Main50 runner rolls back function and never records ledger when cutover fails', async () => {
  const db = new FakeDb({ functionError: new Error('function cutover failed') })
  await assert.rejects(run(db), /function cutover failed/)
  assert.equal(callsMatching(db, /^rollback$/i).length, 1)
  assert.equal(callsMatching(db, /insert into supabase_migrations\.schema_migrations/i).length, 0)
})

test('Main50 runner rejects drifted existing ledger before accepting applied state', async () => {
  await assert.rejects(run(new FakeDb({ alreadyApplied: true, ledgerValid: false })), /ledger receipt/)
  await assert.rejects(run(new FakeDb({ alreadyApplied: true, ledgerVersionValid: false })), /ledger receipt/)
})

test('Main50 runner rejects a semantically drifted function body and unexpected EXECUTE roles', async () => {
  await assert.rejects(run(new FakeDb({ alreadyApplied: true, functionExact: false })), /body does not match/)
  await assert.rejects(run(new FakeDb({ alreadyApplied: true, extraAcl: true })), /unexpected EXECUTE grant/)
})

test('Main50 runner verifies an exact existing ledger receipt without replaying DDL', async () => {
  const db = new FakeDb({ alreadyApplied: true })
  const result = await run(db)
  assert.equal(result.applied, false)
  assert.equal(result.alreadyApplied, true)
  assert.equal(callsMatching(db, /drop index concurrently|create index concurrently|create or replace function/i).length, 0)
  assert.equal(callsMatching(db, /from pg_catalog\.pg_index/i).length, 1)
  assert.equal(callsMatching(db, /pg_get_functiondef/i).length, 1)
})
