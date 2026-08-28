import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const parentCommit = 'e25e506a5353abeb2a3287ce53f856bbcf3d548d'
const workflowPath = '.github/workflows/trusted-release-images-main54.yml'
const migrationPath = 'supabase/migrations/20260828010000_v105_capture_outbox_batch100_contract.sql'
const rollbackPath = 'supabase/operations/rollback_v105_main54_batch100_to_main47_batch30.sql'
const harnessPath = 'scripts/test-main54-batch100-migration.mjs'
const readText = (relativePath) => readFile(path.join(root, relativePath), 'utf8')

test('Main54 starts from the exact Main53 parent', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const actualParent = head === parentCommit
    ? head
    : execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(actualParent, parentCommit)
})

test('Main54 migration changes only the three fenced outbox RPCs from 30 to 100', async () => {
  const sql = await readText(migrationPath)
  assert.equal((sql.match(/create or replace function public\.(?:claim|complete|fail)_v105_capture_settlement_outbox_batch/g) ?? []).length, 3)
  assert.match(sql, /limit greatest\(1, least\(coalesce\(p_limit, 10\), 100\)\)/i)
  assert.equal((sql.match(/expected > 100/g) ?? []).length, 2)
  assert.match(sql, /for update skip locked/i)
  assert.match(sql, /claim_token/i)
  assert.match(sql, /lease_generation/i)
  assert.match(sql, /grant execute on function public\.claim_v105_capture_settlement_outbox_batch\(integer\) to service_role/i)
  assert.match(sql, /pg_get_functiondef/i)
  assert.match(sql, /batch100 .* verification failed/i)
})

test('Main54 rollback restores the Main47 batch30 three-function contract', async () => {
  const sql = await readText(rollbackPath)
  assert.equal((sql.match(/create or replace function public\.(?:claim|complete|fail)_v105_capture_settlement_outbox_batch/g) ?? []).length, 3)
  assert.match(sql, /limit greatest\(1, least\(coalesce\(p_limit, 10\), 30\)\)/i)
  assert.equal((sql.match(/expected > 30/g) ?? []).length, 2)
  assert.match(sql, /pg_get_functiondef/i)
})

test('Main54 harness is rollback-only and proves 100 complete, 100 fail, and 101 rejection', async () => {
  const script = await readText(harnessPath)
  assert.match(script, /MAIN54_BATCH100_TEST_MODE.*rollback-only/s)
  assert.match(script, /ROLLBACK_ONLY_NO_COMMIT/)
  assert.match(script, /generate_series\(1,100\)/)
  assert.match(script, /length: 101/)
  assert.match(script, /completed: 100/)
  assert.match(script, /failed: 100/)
  assert.match(script, /rejected101: true/)
  assert.match(script, /rollback: true/)
})

test('Main54 workflow builds and attests only Formal Consumer from exact Main53 parent', async () => {
  const workflow = await readText(workflowPath)
  assert.match(workflow, /v105-v10-main\.54/g)
  assert.match(workflow, new RegExp(parentCommit, 'g'))
  assert.match(workflow, /IMAGE: darven-ai-baccarat-formal-consumer/)
  assert.match(workflow, /file: proxy\/Dockerfile\.formal-consumer/)
  assert.match(workflow, /gh attestation verify/)
  assert.doesNotMatch(workflow, /IMAGE: darven-ai-baccarat-(?:proxy|worker)/)
})
