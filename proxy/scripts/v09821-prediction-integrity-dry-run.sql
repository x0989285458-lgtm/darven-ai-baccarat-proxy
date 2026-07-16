-- Read-only v098.21 integrity audit. It deliberately makes no historical truth claims.
select
  id as prediction_id,
  source,
  table_id,
  shoe_no,
  round_no,
  strategy_version,
  predicted_result,
  confidence,
  probabilities as original_probabilities,
  prediction_features as original_prediction_features,
  prediction_issued_at,
  actual_result,
  is_hit,
  resolved_at,
  settlement_final,
  settlement_status as original_settlement_status,
  case
    when prediction_issued_at is null or issued_prediction_payload is null then 'unknown'
    when settlement_final is true and actual_result = 'tie' then 'push'
    when settlement_final is true and is_hit is true then 'hit'
    when settlement_final is true and is_hit is false then 'miss'
    else 'unknown'
  end as suggested_status
from public.daily_prediction_results
order by created_at, id;
