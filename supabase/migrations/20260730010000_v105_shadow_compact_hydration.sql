-- Concurrent index phase. This file must be applied outside an explicit transaction.
create index concurrently if not exists v105_shadow_v6_issuances_table_issued_idx
  on public.v105_shadow_v6_issuances (table_id, prediction_issued_at desc, id desc);
create index concurrently if not exists v105_shadow_v7_issuances_table_issued_idx
  on public.v105_shadow_v7_issuances (table_id, prediction_issued_at desc, id desc);
create index concurrently if not exists v105_shadow_v8_issuances_table_issued_idx
  on public.v105_shadow_v8_issuances (table_id, prediction_issued_at desc, id desc);
create index concurrently if not exists v105_shadow_v9_issuances_table_issued_idx
  on public.v105_shadow_v9_issuances (table_id, prediction_issued_at desc, id desc);
