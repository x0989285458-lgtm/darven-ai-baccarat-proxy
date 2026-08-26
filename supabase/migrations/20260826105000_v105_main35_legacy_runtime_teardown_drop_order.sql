begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table
  public.ai_strategy_versions,
  public.v103_shadow_runtime_settings,
  public.v104_shadow_runtime_settings,
  public.v104_iteration_shadow_runtime_settings,
  public.v104_iteration_shadow_v2_runtime_settings,
  public.v104_iteration_shadow_v3_runtime_settings,
  public.v104_iteration_shadow_v4_runtime_settings,
  public.v104_iteration_shadow_v5_runtime_settings,
  public.v105_shadow_v9_runtime_settings,
  public.v105_shadow_v10_runtime_settings,
  public.v105_shadow_v10_big_road_runtime_settings,
  public.v105_shadow_v10_rank_sync_runtime_settings
in share row exclusive mode;

do $main33_preflight$
declare
  runtime_table text;
  enabled_count bigint;
  non_disabled_count bigint;
begin
  if (select count(*) from public.ai_strategy_versions where status = 'active') <> 1
    or not exists (
      select 1 from public.ai_strategy_versions
      where status = 'active' and version = 'v105'
    ) then
    raise exception 'Main33 teardown requires exactly one active strategy and it must be v105';
  end if;

  foreach runtime_table in array array[
    'v103_shadow_runtime_settings',
    'v104_shadow_runtime_settings',
    'v104_iteration_shadow_runtime_settings',
    'v104_iteration_shadow_v2_runtime_settings',
    'v104_iteration_shadow_v3_runtime_settings',
    'v104_iteration_shadow_v4_runtime_settings',
    'v104_iteration_shadow_v5_runtime_settings',
    'v105_shadow_v9_runtime_settings',
    'v105_shadow_v10_runtime_settings',
    'v105_shadow_v10_big_road_runtime_settings',
    'v105_shadow_v10_rank_sync_runtime_settings'
  ]
  loop
    if pg_catalog.to_regclass(pg_catalog.format('public.%I', runtime_table)) is not null then
      execute pg_catalog.format(
        'select count(*) filter (where enabled is true), count(*) filter (where status is distinct from ''shadow_disabled'') from public.%I',
        runtime_table
      ) into enabled_count, non_disabled_count;
      if enabled_count <> 0 or non_disabled_count <> 0 then
        raise exception 'Main35 teardown blocked: runtime setting % enabled=% non_disabled=%',
          runtime_table, enabled_count, non_disabled_count;
      end if;
    end if;
  end loop;
end
$main33_preflight$;

-- Main35: remove the only trigger dependency explicitly.
drop trigger if exists v104_iteration_shadow_2000_settlement_cap on public.v104_iteration_shadow_settlements;

-- Main35: dependent functions must be removed before view composite types.
drop function if exists public.apply_v104_rank_ledger_event(jsonb, jsonb);
drop function if exists public.get_v104_prediction_lifecycle_stats();
drop function if exists public.issue_v104_prediction(jsonb);
drop function if exists public.persist_v104_settled_round(jsonb, jsonb);
drop function if exists public.reconcile_v104_prediction_lifecycle(text, text, text, integer);
drop function if exists public.settle_v104_prediction(jsonb, jsonb);
drop function if exists public.get_v103_shadow_history(integer);
drop function if exists public.settle_v103_shadow_prediction(jsonb);
drop function if exists public.issue_v103_shadow_prediction(jsonb);
drop function if exists public.get_v104_shadow_history(integer);
drop function if exists public.settle_v104_shadow_prediction(jsonb);
drop function if exists public.issue_v104_shadow_prediction(jsonb);
drop function if exists public.review_v104_iteration_shadow_suggestion(text, text, text);
drop function if exists public.persist_v104_iteration_shadow_artifacts(jsonb, jsonb);
drop function if exists public.settle_v104_iteration_shadow_prediction(jsonb);
drop function if exists public.issue_v104_iteration_shadow_prediction(jsonb);
drop function if exists public.enforce_v104_iteration_shadow_2000_settlement_cap();
drop function if exists public.review_v104_iteration_shadow_v2_suggestion(text, text, text);
drop function if exists public.persist_v104_iteration_shadow_v2_artifacts(jsonb, jsonb);
drop function if exists public.settle_v104_iteration_shadow_v2_prediction(jsonb);
drop function if exists public.issue_v104_iteration_shadow_v2_prediction(jsonb);
drop function if exists public.finish_v104_iteration_shadow_v3_drain();
drop function if exists public.begin_v104_iteration_shadow_v3_drain();
drop function if exists public.review_v104_iteration_shadow_v3_suggestion(text, text, text);
drop function if exists public.persist_v104_iteration_shadow_v3_artifacts(jsonb, jsonb);
drop function if exists public.settle_v104_iteration_shadow_v3_prediction(jsonb);
drop function if exists public.issue_v104_iteration_shadow_v3_prediction(jsonb);
drop function if exists public.finish_v104_iteration_shadow_v4_drain();
drop function if exists public.begin_v104_iteration_shadow_v4_drain();
drop function if exists public.review_v104_iteration_shadow_v4_suggestion(text, text, text);
drop function if exists public.persist_v104_iteration_shadow_v4_artifacts(jsonb, jsonb);
drop function if exists public.settle_v104_iteration_shadow_v4_prediction(jsonb);
drop function if exists public.issue_v104_iteration_shadow_v4_prediction(jsonb);
drop function if exists public.finish_v104_iteration_shadow_v5_drain();
drop function if exists public.begin_v104_iteration_shadow_v5_drain();
drop function if exists public.review_v104_iteration_shadow_v5_suggestion(text, text, text);
drop function if exists public.persist_v104_iteration_shadow_v5_artifacts(jsonb, jsonb);
drop function if exists public.settle_v104_iteration_shadow_v5_prediction(jsonb);
drop function if exists public.issue_v104_iteration_shadow_v5_prediction(jsonb);
drop function if exists public.get_v105_shadow_v9_compact_history(integer);
drop function if exists public.settle_v105_shadow_v9_prediction(jsonb);
drop function if exists public.issue_v105_shadow_v9_prediction(jsonb);
drop function if exists public.get_v105_shadow_v10_compact_history(integer);
drop function if exists public.settle_v105_shadow_v10_prediction(jsonb);
drop function if exists public.issue_v105_shadow_v10_prediction(jsonb);
drop function if exists public.get_v105_shadow_v10_big_road_compact_history(integer);
drop function if exists public.settle_v105_shadow_v10_big_road_prediction(jsonb);
drop function if exists public.issue_v105_shadow_v10_big_road_prediction(jsonb);
drop function if exists public.get_v105_shadow_v10_rank_sync_compact_history(integer);
drop function if exists public.settle_v105_shadow_v10_rank_sync_prediction(jsonb);
drop function if exists public.issue_v105_shadow_v10_rank_sync_prediction(jsonb);

-- Views are safe to remove only after every dependent function is gone.
drop view if exists public.v103_shadow_history;
drop view if exists public.v104_shadow_history;
drop view if exists public.v104_iteration_shadow_history;
drop view if exists public.v104_iteration_shadow_v2_history;
drop view if exists public.v104_iteration_shadow_v3_history;
drop view if exists public.v104_iteration_shadow_v4_history;
drop view if exists public.v104_iteration_shadow_v5_history;
drop view if exists public.v105_shadow_v9_history;
drop view if exists public.v105_shadow_v10_history;
drop view if exists public.v105_shadow_v10_big_road_history;
drop view if exists public.v105_shadow_v10_rank_sync_history;

-- Remaining exact retired table allowlist.
drop table if exists public.v104_formal_release_previous_active;
drop table if exists public.v103_shadow_settlements;
drop table if exists public.v103_shadow_issuances;
drop table if exists public.v103_shadow_runtime_settings;
drop table if exists public.v104_shadow_settlements;
drop table if exists public.v104_shadow_issuances;
drop table if exists public.v104_shadow_runtime_settings;
drop table if exists public.v104_iteration_shadow_weight_suggestions;
drop table if exists public.v104_iteration_shadow_cycle_reports;
drop table if exists public.v104_iteration_shadow_settlements;
drop table if exists public.v104_iteration_shadow_issuances;
drop table if exists public.v104_iteration_shadow_sequence_counters;
drop table if exists public.v104_iteration_shadow_runtime_settings;
drop table if exists public.v104_iteration_shadow_v2_weight_suggestions;
drop table if exists public.v104_iteration_shadow_v2_cycle_reports;
drop table if exists public.v104_iteration_shadow_v2_settlements;
drop table if exists public.v104_iteration_shadow_v2_issuances;
drop table if exists public.v104_iteration_shadow_v2_sequence_counters;
drop table if exists public.v104_iteration_shadow_v2_runtime_settings;
drop table if exists public.v104_iteration_shadow_v3_weight_suggestions;
drop table if exists public.v104_iteration_shadow_v3_cycle_reports;
drop table if exists public.v104_iteration_shadow_v3_settlements;
drop table if exists public.v104_iteration_shadow_v3_issuances;
drop table if exists public.v104_iteration_shadow_v3_sequence_counters;
drop table if exists public.v104_iteration_shadow_v3_runtime_settings;
drop table if exists public.v104_iteration_shadow_v4_weight_suggestions;
drop table if exists public.v104_iteration_shadow_v4_cycle_reports;
drop table if exists public.v104_iteration_shadow_v4_settlements;
drop table if exists public.v104_iteration_shadow_v4_issuances;
drop table if exists public.v104_iteration_shadow_v4_sequence_counters;
drop table if exists public.v104_iteration_shadow_v4_runtime_settings;
drop table if exists public.v104_iteration_shadow_v5_weight_suggestions;
drop table if exists public.v104_iteration_shadow_v5_cycle_reports;
drop table if exists public.v104_iteration_shadow_v5_settlements;
drop table if exists public.v104_iteration_shadow_v5_issuances;
drop table if exists public.v104_iteration_shadow_v5_sequence_counters;
drop table if exists public.v104_iteration_shadow_v5_runtime_settings;
drop table if exists public.v105_shadow_v9_settlements;
drop table if exists public.v105_shadow_v9_issuances;
drop table if exists public.v105_shadow_v9_sequence_counters;
drop table if exists public.v105_shadow_v9_runtime_settings;
drop table if exists public.v105_shadow_v10_settlements;
drop table if exists public.v105_shadow_v10_issuances;
drop table if exists public.v105_shadow_v10_sequence_counters;
drop table if exists public.v105_shadow_v10_runtime_settings;
drop table if exists public.v105_shadow_v10_big_road_settlements;
drop table if exists public.v105_shadow_v10_big_road_issuances;
drop table if exists public.v105_shadow_v10_big_road_sequence_counters;
drop table if exists public.v105_shadow_v10_big_road_runtime_settings;
drop table if exists public.v105_shadow_v10_rank_sync_settlements;
drop table if exists public.v105_shadow_v10_rank_sync_issuances;
drop table if exists public.v105_shadow_v10_rank_sync_sequence_counters;
drop table if exists public.v105_shadow_v10_rank_sync_runtime_settings;

commit;
