-- SELECT-only pre-migration preview for the v098.22 schema.
-- Either provide all four transaction-local settings below for one live table,
-- or leave them unset to use each table's latest durable issuance identity.
-- app.v09823_current_source, app.v09823_current_table,
-- app.v09823_current_shoe, app.v09823_current_visible_round.
with raw_parameters as (
  select nullif(current_setting('app.v09823_current_source', true), '') as source,
         nullif(current_setting('app.v09823_current_table', true), '') as table_id,
         nullif(current_setting('app.v09823_current_shoe', true), '') as current_shoe,
         nullif(current_setting('app.v09823_current_visible_round', true), '')::integer as current_visible_round
), parameters as (
  select raw_parameters.*,
         source is not null and table_id is not null and current_shoe is not null and current_visible_round is not null as has_complete_live_context
  from raw_parameters
), issued_tables as (
  select distinct p.source, p.table_id
  from public.daily_prediction_results p
  cross join parameters wanted
  where p.prediction_issued_at is not null
    and (wanted.source is null or p.source = wanted.source)
    and (wanted.table_id is null or p.table_id = wanted.table_id)
), live_context as (
  select t.source,
         t.table_id,
         case when wanted.has_complete_live_context then wanted.current_shoe else latest.shoe_no end as current_shoe,
         case when wanted.has_complete_live_context then wanted.current_visible_round else latest.round_no end as current_visible_round,
         case when wanted.has_complete_live_context then 'caller_parameters' else 'latest_durable_issuance' end as context_source
  from issued_tables t
  cross join parameters wanted
  cross join lateral (
    select p.shoe_no, p.round_no
    from public.daily_prediction_results p
    where p.source = t.source
      and p.table_id = t.table_id
      and p.prediction_issued_at is not null
    order by p.prediction_issued_at desc, p.round_no desc, p.id desc
    limit 1
  ) latest
), classified as (
  select p.id, p.source, p.table_id, p.shoe_no, p.round_no, p.strategy_version,
         p.prediction_issued_at, p.settlement_final, p.settlement_status,
         c.current_shoe, c.current_visible_round, c.context_source,
         case
           when p.settlement_final is true then 'settled'
           when p.shoe_no is distinct from c.current_shoe then 'abandoned_shoe_change'
           when p.round_no < c.current_visible_round then 'expired_no_final'
           else 'pending'
         end as preview_issuance_status
  from public.daily_prediction_results p
  join live_context c on c.source = p.source and c.table_id = p.table_id
  where p.prediction_issued_at is not null
)
select classified.*,
       count(*) filter (where preview_issuance_status = 'pending') over (partition by source, table_id) as would_be_pending,
       count(*) filter (where preview_issuance_status = 'settled') over (partition by source, table_id) as would_be_settled,
       count(*) filter (where preview_issuance_status = 'expired_no_final') over (partition by source, table_id) as would_be_expired_no_final,
       count(*) filter (where preview_issuance_status = 'abandoned_shoe_change') over (partition by source, table_id) as would_be_abandoned_shoe_change
from classified
order by source, table_id, prediction_issued_at, id;
