import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const repo = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, repo), 'utf8')

test('v101 release artifacts remain immutable rollback history after v102 promotion', () => {
  for (const relative of [
    'release/v101-release-manifest.json',
    'frontend/supabase/schema_v101_latest_only.sql',
    'frontend/supabase/rollback_v101_to_v100.sql',
  ]) assert.equal(existsSync(new URL(relative, repo)), true, `${relative} must remain`)
  const manifest = JSON.parse(read('release/v101-release-manifest.json'))
  assert.equal(manifest.identity.productVersion, 'v101')
  assert.equal(manifest.identity.strategyVersion, 'v101')
  assert.match(read('frontend/supabase/schema_v101_latest_only.sql'), /insert into public\.ai_strategy_versions[\s\S]*'v101'/i)
  assert.match(read('frontend/supabase/rollback_v101_to_v100.sql'), /version\s*=\s*'v100'/i)
  assert.doesNotMatch(read('frontend/supabase/schema_v101_latest_only.sql') + read('frontend/supabase/rollback_v101_to_v100.sql'), /drop\s+(?:table|function)|truncate|delete\s+from/i)
})
