import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v092 Supabase schema adds unique indexes for round dedupe', () => {
  const sql = readFileSync(new URL('../../frontend/supabase/schema_v092_stability.sql', import.meta.url), 'utf8')

  assert.match(sql, /create unique index if not exists daily_roadmap_events_v092_round_unique/i)
  assert.match(sql, /on public\.daily_roadmap_events \(source, table_id, shoe_no, round_no\)/i)
  assert.match(sql, /create unique index if not exists daily_prediction_results_v092_round_strategy_unique/i)
  assert.match(sql, /on public\.daily_prediction_results \(source, table_id, shoe_no, round_no, strategy_version\)/i)
  assert.match(sql, /create unique index if not exists cloud_table_rounds_v092_round_unique/i)
  assert.match(sql, /on public\.cloud_table_rounds \(source, table_id, shoe_no, round_no\)/i)
})
