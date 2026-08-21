begin;

alter table public.ai_strategy_versions
  add column if not exists issuance_enabled boolean;

update public.ai_strategy_versions
set issuance_enabled = case
  when version = 'v105' and status = 'active' then true
  when version in ('v105', 'v106') then false
  else coalesce(issuance_enabled, true)
end
where issuance_enabled is null or version in ('v105', 'v106');

alter table public.ai_strategy_versions
  alter column issuance_enabled set default true,
  alter column issuance_enabled set not null;

-- The row SHARE lock is the issuance-side half of the cutover barrier.
-- A fence UPDATE on the same v105 row waits for every admitted issuance transaction;
-- after that UPDATE commits, later callers observe false and fail closed.
create or replace function public.issue_v105_prediction(p_prediction jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  issued public.daily_prediction_results%rowtype;
begin
  perform 1
  from public.ai_strategy_versions
  where version = 'v105' and status = 'active' and issuance_enabled is true
  for share;
  if not found then
    raise exception 'v105 issuance is fenced because admission is disabled or v105 is not Active';
  end if;

  if nullif(p_prediction->>'source', '') is null
     or nullif(p_prediction->>'table_id', '') is null
     or nullif(p_prediction->>'shoe_no', '') is null
     or nullif(p_prediction->>'round_no', '') is null
     or nullif(p_prediction->>'strategy_version', '') is null
     or p_prediction->>'strategy_version' is distinct from 'v105'
     or nullif(p_prediction->>'predicted_result', '') is null
     or p_prediction->>'predicted_result' not in ('banker', 'player')
     or jsonb_typeof(p_prediction->'issued_prediction_payload') <> 'object'
     or p_prediction->'issued_prediction_payload'->>'targetTableId' is distinct from p_prediction->>'table_id'
     or p_prediction->'issued_prediction_payload'->>'targetShoe' is distinct from p_prediction->>'shoe_no'
     or (p_prediction->'issued_prediction_payload'->>'targetRound')::integer is distinct from (p_prediction->>'round_no')::integer
     or p_prediction->'issued_prediction_payload'->>'strategyVersion' is distinct from p_prediction->>'strategy_version'
     or p_prediction->'issued_prediction_payload'->>'predictedResult' is distinct from p_prediction->>'predicted_result'
     or (p_prediction->'issued_prediction_payload'->>'confidence')::integer is distinct from (p_prediction->>'confidence')::integer then
    raise exception 'prediction issuance payload is incomplete';
  end if;

  insert into public.daily_prediction_results (
    source, table_id, shoe_no, round_no, strategy_version,
    predicted_result, confidence, actual_result, is_hit,
    table_recent_hit_rate, table_recent_prediction_count, short_run_adjustment,
    prediction_features, probabilities, resolved_at,
    prediction_issued_at, issued_prediction_payload, settlement_final, settlement_status,
    issuance_status, issuance_status_updated_at, issuance_status_reason
  ) values (
    p_prediction->>'source', p_prediction->>'table_id', p_prediction->>'shoe_no', (p_prediction->>'round_no')::integer,
    p_prediction->>'strategy_version', p_prediction->>'predicted_result', (p_prediction->>'confidence')::integer,
    null, null,
    nullif(p_prediction->>'table_recent_hit_rate', '')::numeric,
    nullif(p_prediction->>'table_recent_prediction_count', '')::integer,
    coalesce(p_prediction->'short_run_adjustment', '{}'::jsonb),
    coalesce(p_prediction->'prediction_features', '{}'::jsonb),
    coalesce(p_prediction->'probabilities', '{}'::jsonb),
    null,
    now(), p_prediction->'issued_prediction_payload', false, 'unknown',
    'pending', now(), 'issued_before_authoritative_final'
  )
  on conflict (source, table_id, shoe_no, round_no, strategy_version) do nothing
  returning * into issued;

  if issued.id is null then
    select * into issued
    from public.daily_prediction_results
    where source = p_prediction->>'source'
      and table_id = p_prediction->>'table_id'
      and shoe_no = p_prediction->>'shoe_no'
      and round_no = (p_prediction->>'round_no')::integer
      and strategy_version = p_prediction->>'strategy_version'
    order by created_at, id
    limit 1;
  end if;

  if issued.id is null or issued.prediction_issued_at is null or issued.issued_prediction_payload is null then
    raise exception 'prediction identity conflicts with legacy row without immutable issuance evidence';
  end if;

  return jsonb_build_object(
    'prediction_id', issued.id,
    'prediction_issued_at', issued.prediction_issued_at,
    'prediction', issued.issued_prediction_payload || jsonb_build_object(
      'predictionId', issued.id,
      'issuedAt', issued.prediction_issued_at
    )
  );
end;
$$;

commit;
