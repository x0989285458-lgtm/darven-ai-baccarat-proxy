import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const finalize = readFileSync(new URL('../../frontend/supabase/finalize_v105_cutover.sql', import.meta.url), 'utf8')
const rollback = readFileSync(new URL('../../frontend/supabase/rollback_v105_to_v104.sql', import.meta.url), 'utf8')

test('v105 finalize refuses to revoke v104 settlement while predecessor issuances remain pending', () => {
  assert.match(finalize, /get_v104_prediction_lifecycle_stats\(\)[\s\S]*active_pending[\s\S]*(?:<>|!=)\s*0[\s\S]*revoke execute on function public\.settle_v104_prediction/i)
})

test('v105 rollback refuses to revoke v105 settlement while current issuances remain pending', () => {
  assert.match(rollback, /get_v105_prediction_lifecycle_stats\(\)[\s\S]*active_pending[\s\S]*(?:<>|!=)\s*0[\s\S]*revoke execute on function public\.settle_v105_prediction/i)
})
