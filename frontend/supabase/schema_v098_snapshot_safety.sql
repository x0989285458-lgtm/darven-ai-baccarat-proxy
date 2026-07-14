-- v098: bound cloud snapshot write frequency and retain only the latest 24 hours.
-- Apply with service/admin privileges after schema_v039_cloud_capture.sql.

-- One function call is one PostgreSQL transaction. If either insert raises,
-- PostgreSQL rolls both inserts back and PostgREST returns a failed RPC.
create or replace function public.persist_v098_settled_round(
  p_roadmap jsonb,
  p_prediction jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  roadmap_durable boolean := false;
  prediction_durable boolean := false;
  roadmap_written integer := 0;
  prediction_written integer := 0;
begin
  if nullif(p_roadmap->>'source', '') is null
     or nullif(p_roadmap->>'table_id', '') is null
     or nullif(p_roadmap->>'shoe_no', '') is null
     or nullif(p_roadmap->>'round_no', '') is null
     or p_roadmap->>'source' is distinct from p_prediction->>'source'
     or p_roadmap->>'table_id' is distinct from p_prediction->>'table_id'
     or p_roadmap->>'shoe_no' is distinct from p_prediction->>'shoe_no'
     or p_roadmap->>'round_no' is distinct from p_prediction->>'round_no' then
    raise exception 'settlement identity mismatch';
  end if;

  insert into public.daily_roadmap_events (
    source, table_id, shoe_no, round_no, main_result,
    banker_points, player_points, banker_pair, player_pair, super_six,
    banker_dragon, player_dragon, bead_code, raw_event,
    player_card_codes, banker_card_codes, player_card_points, banker_card_points,
    player_card_ranks, banker_card_ranks, player_card_faces, banker_card_faces,
    player_drew, banker_drew, player_natural, banker_natural,
    remaining_rank_counts, remaining_point_counts
  ) values (
    p_roadmap->>'source', p_roadmap->>'table_id', p_roadmap->>'shoe_no', (p_roadmap->>'round_no')::integer, p_roadmap->>'main_result',
    nullif(p_roadmap->>'banker_points', '')::integer, nullif(p_roadmap->>'player_points', '')::integer,
    coalesce((p_roadmap->>'banker_pair')::boolean, false), coalesce((p_roadmap->>'player_pair')::boolean, false), coalesce((p_roadmap->>'super_six')::boolean, false),
    coalesce((p_roadmap->>'banker_dragon')::boolean, false), coalesce((p_roadmap->>'player_dragon')::boolean, false),
    p_roadmap->>'bead_code', coalesce(p_roadmap->'raw_event', '{}'::jsonb),
    coalesce(p_roadmap->'player_card_codes', '[]'::jsonb), coalesce(p_roadmap->'banker_card_codes', '[]'::jsonb),
    coalesce(p_roadmap->'player_card_points', '[]'::jsonb), coalesce(p_roadmap->'banker_card_points', '[]'::jsonb),
    coalesce(p_roadmap->'player_card_ranks', '[]'::jsonb), coalesce(p_roadmap->'banker_card_ranks', '[]'::jsonb),
    coalesce(p_roadmap->'player_card_faces', '[]'::jsonb), coalesce(p_roadmap->'banker_card_faces', '[]'::jsonb),
    coalesce((p_roadmap->>'player_drew')::boolean, false), coalesce((p_roadmap->>'banker_drew')::boolean, false),
    coalesce((p_roadmap->>'player_natural')::boolean, false), coalesce((p_roadmap->>'banker_natural')::boolean, false),
    coalesce(p_roadmap->'remaining_rank_counts', '{}'::jsonb), coalesce(p_roadmap->'remaining_point_counts', '{}'::jsonb)
  )
  on conflict (source, table_id, shoe_no, round_no) do update
    set source = excluded.source
    where (to_jsonb(daily_roadmap_events) - 'id' - 'opened_at' - 'created_at' - 'updated_at')
      = (to_jsonb(excluded) - 'id' - 'opened_at' - 'created_at' - 'updated_at');
  get diagnostics roadmap_written = row_count;
  if roadmap_written <> 1 then
    raise exception 'conflicting existing roadmap settlement';
  end if;

  insert into public.daily_prediction_results (
    source, table_id, shoe_no, round_no, strategy_version,
    predicted_result, confidence, actual_result, is_hit,
    table_recent_hit_rate, table_recent_prediction_count, short_run_adjustment,
    prediction_features, probabilities, resolved_at
  ) values (
    p_prediction->>'source', p_prediction->>'table_id', p_prediction->>'shoe_no', (p_prediction->>'round_no')::integer, p_prediction->>'strategy_version',
    p_prediction->>'predicted_result', (p_prediction->>'confidence')::integer, p_prediction->>'actual_result', (p_prediction->>'is_hit')::boolean,
    nullif(p_prediction->>'table_recent_hit_rate', '')::numeric, nullif(p_prediction->>'table_recent_prediction_count', '')::integer,
    coalesce(p_prediction->'short_run_adjustment', '{}'::jsonb), coalesce(p_prediction->'prediction_features', '{}'::jsonb),
    coalesce(p_prediction->'probabilities', '{}'::jsonb), nullif(p_prediction->>'resolved_at', '')::timestamptz
  )
  on conflict (source, table_id, shoe_no, round_no, strategy_version) do update
    set source = excluded.source
    where (to_jsonb(daily_prediction_results) - 'id' - 'created_at' - 'updated_at')
      = (to_jsonb(excluded) - 'id' - 'created_at' - 'updated_at');
  get diagnostics prediction_written = row_count;
  if prediction_written <> 1 then
    raise exception 'conflicting existing prediction settlement';
  end if;

  select exists (
    select 1 from public.daily_roadmap_events
    where source = p_roadmap->>'source'
      and table_id = p_roadmap->>'table_id'
      and shoe_no = p_roadmap->>'shoe_no'
      and round_no = (p_roadmap->>'round_no')::integer
  ) into roadmap_durable;

  select exists (
    select 1 from public.daily_prediction_results
    where source = p_prediction->>'source'
      and table_id = p_prediction->>'table_id'
      and shoe_no = p_prediction->>'shoe_no'
      and round_no = (p_prediction->>'round_no')::integer
      and strategy_version = p_prediction->>'strategy_version'
  ) into prediction_durable;

  if not roadmap_durable or not prediction_durable then
    raise exception 'settlement durability verification failed';
  end if;

  return jsonb_build_object(
    'persisted', roadmap_durable and prediction_durable,
    'roadmapDurable', roadmap_durable,
    'predictionDurable', prediction_durable
  );
end;
$$;

revoke all on function public.persist_v098_settled_round(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.persist_v098_settled_round(jsonb, jsonb) to service_role;

create or replace function public.limit_cloud_table_snapshot_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_snapshot public.cloud_table_snapshots%rowtype;
  has_round_or_shoe_change boolean := false;
  has_connection_transition boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(new.session_id, '')));
  select * into previous_snapshot
  from public.cloud_table_snapshots
  where session_id is not distinct from new.session_id
  order by snapshot_at desc
  limit 1;

  if previous_snapshot.id is not null
     and previous_snapshot.snapshot_at > now() - interval '30 seconds' then
    has_connection_transition :=
      new.metadata->'connectionState' is distinct from previous_snapshot.metadata->'connectionState';

    select exists (
      select 1
      from jsonb_array_elements(coalesce(new.table_summary, '[]'::jsonb)) next_table
      left join jsonb_array_elements(coalesce(previous_snapshot.table_summary, '[]'::jsonb)) prior_table
        on prior_table->>'tableId' = next_table->>'tableId'
      where prior_table is null
         or next_table->>'shoe' is distinct from prior_table->>'shoe'
         or coalesce(nullif(next_table->>'round', '')::integer, 0)
            > coalesce(nullif(prior_table->>'round', '')::integer, 0)
    ) into has_round_or_shoe_change;

    if not has_connection_transition and not has_round_or_shoe_change then
      return null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_limit_cloud_table_snapshot_writes on public.cloud_table_snapshots;
create trigger trg_limit_cloud_table_snapshot_writes
before insert on public.cloud_table_snapshots
for each row execute function public.limit_cloud_table_snapshot_writes();

create or replace function public.cleanup_cloud_table_snapshots()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.cloud_table_snapshots
  where ctid in (
    select ctid
    from public.cloud_table_snapshots
    where snapshot_at < now() - interval '24 hours'
    order by snapshot_at
    limit 500
  );
  return null;
end;
$$;

drop trigger if exists trg_cleanup_cloud_table_snapshots on public.cloud_table_snapshots;
create trigger trg_cleanup_cloud_table_snapshots
after insert on public.cloud_table_snapshots
for each statement execute function public.cleanup_cloud_table_snapshots();

create index if not exists idx_cloud_table_snapshots_session_snapshot_at
  on public.cloud_table_snapshots(session_id, snapshot_at desc);

-- v098: v097 is the sole production strategy. Legacy rows remain as archived history.
update public.ai_strategy_versions
set status = 'archived'
where status = 'active'
  and version <> 'v097_副預測命中校準與門檻降5版';

create unique index if not exists uq_ai_strategy_versions_one_active
  on public.ai_strategy_versions(status)
  where (status = 'active');
