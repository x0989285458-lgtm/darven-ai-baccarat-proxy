-- Align V10 compact hydration ordering with Node.js millisecond timestamp precision.
-- Additive/repeatable: replaces one read-only SECURITY DEFINER RPC and preserves all V10 evidence.
begin;

create or replace function public.get_v105_shadow_v10_compact_history(p_per_table_limit integer)
returns table (
  prediction_id uuid,
  source text,
  table_id text,
  shoe_no text,
  round_no integer,
  strategy_version text,
  prediction_timing text,
  prediction_issued_at timestamptz,
  predicted_result text,
  same_side_streak integer,
  actual_result text,
  settlement_final boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_per_table_limit is null or p_per_table_limit not between 1 and 60 then
    raise exception 'p_per_table_limit must be between 1 and 60' using errcode = '22023';
  end if;

  return query
  with target_tables(target_table_id) as (
    values ('BAG01'), ('BAG02'), ('BAG03'), ('BAG03A'), ('BAG05'),
      ('BAG06'), ('BAG07'), ('BAG08'), ('BAG09'), ('BAG10')
  ),
  compact_rows as (
    select final_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, s.actual_result, true as settlement_final
      from public.v105_shadow_v10_issuances i
      inner join public.v105_shadow_v10_settlements s on s.prediction_id = i.id
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v10-uncommon-road-structure'
        and i.prediction_timing = 'pre_result_context'
        and s.settlement_final = true
      order by date_trunc('milliseconds', i.prediction_issued_at) desc, i.id desc
      limit p_per_table_limit
    ) final_row
    union all
    select pending_row.*
    from target_tables t
    cross join lateral (
      select i.id as prediction_id, i.source, i.table_id, i.shoe_no, i.round_no,
        i.strategy_version, i.prediction_timing, i.prediction_issued_at, i.predicted_result,
        i.same_side_streak, null::text as actual_result, false as settlement_final
      from public.v105_shadow_v10_issuances i
      where i.table_id = t.target_table_id
        and i.source = 'ofalive99'
        and i.strategy_version = 'v105-shadow-v10-uncommon-road-structure'
        and i.prediction_timing = 'pre_result_context'
        and not exists (
          select 1
          from public.v105_shadow_v10_settlements final_settlement
          where final_settlement.prediction_id = i.id
            and final_settlement.settlement_final = true
        )
      order by date_trunc('milliseconds', i.prediction_issued_at) desc, i.id desc
      limit 1
    ) pending_row
  )
  select compact.prediction_id, compact.source, compact.table_id, compact.shoe_no, compact.round_no,
    compact.strategy_version, compact.prediction_timing, compact.prediction_issued_at,
    compact.predicted_result, compact.same_side_streak, compact.actual_result, compact.settlement_final
  from compact_rows compact
  order by date_trunc('milliseconds', compact.prediction_issued_at) asc, compact.prediction_id asc;
end;
$$;

revoke all on function public.get_v105_shadow_v10_compact_history(integer) from public;
revoke all on function public.get_v105_shadow_v10_compact_history(integer) from anon, authenticated, service_role;
grant execute on function public.get_v105_shadow_v10_compact_history(integer) to service_role;

do $acl$
declare
  unexpected_roles text[];
begin
  select array_agg(distinct coalesce(role_row.rolname, 'PUBLIC') order by coalesce(role_row.rolname, 'PUBLIC'))
  into unexpected_roles
  from pg_catalog.pg_proc function_row
  cross join lateral pg_catalog.aclexplode(
    coalesce(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
  ) acl_row
  left join pg_catalog.pg_roles role_row on role_row.oid = acl_row.grantee
  where function_row.oid = 'public.get_v105_shadow_v10_compact_history(integer)'::pg_catalog.regprocedure
    and acl_row.privilege_type = 'EXECUTE'
    and acl_row.grantee <> function_row.proowner
    and acl_row.grantee <> (select oid from pg_catalog.pg_roles where rolname = 'service_role');

  if unexpected_roles is not null then
    raise exception 'unexpected execute ACL on V10 compact history: %', unexpected_roles
      using errcode = '42501';
  end if;
end;
$acl$;

commit;
