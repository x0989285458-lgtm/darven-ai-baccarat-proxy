begin;

create or replace function public.rebuild_v100_rank_ledger_from_cloud_rounds(
  p_source text,
  p_table_id text,
  p_shoe_no text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
as $$
declare
  latest_shoe text;
  min_round integer;
  max_round integer;
  row_count integer;
  distinct_round_count integer;
  round_row record;
  apply_result jsonb;
  final_ledger public.shoe_rank_ledgers%rowtype;
begin
  if nullif(p_source,'') is null or nullif(p_table_id,'') is null or nullif(p_shoe_no,'') is null
     or p_table_id not in ('BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10') then
    raise exception 'invalid v100 rank recovery identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('v100-rank|'||p_source||'|'||p_table_id||'|'||p_shoe_no,0)
  );

  select shoe_no into latest_shoe
  from public.cloud_table_rounds
  where source=p_source and table_id=p_table_id
  order by received_at desc,round_no desc
  limit 1;
  if latest_shoe is distinct from p_shoe_no then
    raise exception 'v100 rank recovery accepts only the current authoritative shoe';
  end if;

  select min(round_no),max(round_no),count(*)::integer,count(distinct round_no)::integer
    into min_round,max_round,row_count,distinct_round_count
  from public.cloud_table_rounds
  where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no;
  if min_round is distinct from 1 or max_round is null
     or row_count is distinct from max_round or distinct_round_count is distinct from max_round then
    raise exception 'v100 rank recovery authoritative shoe is incomplete';
  end if;

  for round_row in
    select round_no,raw_event
    from public.cloud_table_rounds
    where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no
    order by round_no
    for share
  loop
    apply_result:=public.apply_v100_rank_ledger_event(jsonb_build_object(
      'source',p_source,
      'table_id',p_table_id,
      'shoe_no',p_shoe_no,
      'round_no',round_row.round_no,
      'source_action',round_row.raw_event->>'sourceAction',
      'raw_result_exact10',round_row.raw_event->'rawResult'
    ));
    if apply_result->'accepted' is distinct from 'true'::jsonb
       or apply_result->>'status' is distinct from 'contiguous' then
      raise exception 'v100 rank recovery rejected round %',round_row.round_no;
    end if;
  end loop;

  select * into final_ledger
  from public.shoe_rank_ledgers
  where source=p_source and table_id=p_table_id and shoe_no=p_shoe_no
  for share;
  if final_ledger.status is distinct from 'contiguous'
     or final_ledger.complete_through_round is distinct from max_round then
    raise exception 'v100 rank recovery did not reach the authoritative Final';
  end if;

  return jsonb_build_object(
    'accepted',true,
    'source',p_source,
    'table_id',p_table_id,
    'shoe_no',p_shoe_no,
    'complete_through_round',max_round,
    'status',final_ledger.status,
    'remaining_rank_counts',final_ledger.undealt_after_observed_deals
  );
end;
$$;

revoke all on function public.rebuild_v100_rank_ledger_from_cloud_rounds(text,text,text) from public,anon,authenticated;
grant execute on function public.rebuild_v100_rank_ledger_from_cloud_rounds(text,text,text) to service_role;

commit;
