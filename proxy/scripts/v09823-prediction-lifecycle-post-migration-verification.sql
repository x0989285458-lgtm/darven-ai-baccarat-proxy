-- SELECT-only post-migration lifecycle verification.
select count(*) filter (where issuance_status = 'pending') as active_pending,
       count(*) filter (where issuance_status = 'settled') as settled,
       count(*) filter (where issuance_status = 'expired_no_final') as expired_no_final,
       count(*) filter (where issuance_status = 'abandoned_shoe_change') as abandoned_shoe_change,
       count(*) filter (where issuance_status is null) as unclassified,
       count(*) filter (where settlement_final is true and issuance_status is distinct from 'settled') as final_status_mismatches,
       count(*) as total_issued
from public.daily_prediction_results
where prediction_issued_at is not null;
