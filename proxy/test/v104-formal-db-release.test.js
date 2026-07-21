import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const files = {
  schema: new URL('../../frontend/supabase/schema_v104_formal.sql', import.meta.url),
  finalize: new URL('../../frontend/supabase/finalize_v104_cutover.sql', import.meta.url),
  rollback: new URL('../../frontend/supabase/rollback_v104_to_v102.sql', import.meta.url),
}

test('v104 formal DB migration provides additive compatibility, exact cutover, and non-destructive rollback', () => {
  for (const [name, url] of Object.entries(files)) assert.equal(existsSync(url), true, `${name} SQL must exist`)
  const schema = readFileSync(files.schema, 'utf8')
  const finalize = readFileSync(files.finalize, 'utf8')
  const rollback = readFileSync(files.rollback, 'utf8')

  for (const rpc of ['apply_v104_rank_ledger_event', 'issue_v104_prediction', 'settle_v104_prediction', 'persist_v104_settled_round', 'reconcile_v104_prediction_lifecycle', 'get_v104_prediction_lifecycle_stats']) {
    assert.match(schema, new RegExp(`create or replace function public\\.${rpc}\\b`, 'i'))
    assert.match(schema, new RegExp(`grant execute on function public\\.${rpc}\\b[\\s\\S]*to service_role`, 'i'))
  }
  assert.match(schema, /version\s*=\s*'v102'[\s\S]*status\s*=\s*'active'|status\s*=\s*'active'[\s\S]*version\s*=\s*'v102'/i)
  assert.match(schema, /'v104'\s*,\s*'active'/i)
  assert.match(schema, /grant execute on function public\.issue_v102_prediction\(jsonb\) to service_role/i)
  assert.match(schema, /grant execute on function public\.settle_v102_prediction\(jsonb, jsonb\) to service_role/i)
  assert.doesNotMatch(schema, /drop\s+(table|function)/i)
  assert.doesNotMatch(schema, /truncate\s+/i)

  assert.match(finalize, /revoke execute on function public\.issue_v102_prediction\(jsonb\) from service_role/i)
  assert.match(finalize, /v104 must be the only active strategy/i)
  assert.match(rollback, /update public\.ai_strategy_versions set status = 'active'[\s\S]*where version = 'v102'/i)
  assert.match(rollback, /grant execute on function public\.issue_v102_prediction\(jsonb\) to service_role/i)
  assert.match(rollback, /revoke execute on function public\.issue_v104_prediction\(jsonb\) from service_role/i)
  assert.doesNotMatch(rollback, /delete\s+from\s+public\.daily_prediction_results/i)
})
