-- Corrective read-only observation contract. Apply after 20261028090000.
-- Domain is one primary postmaster. Epoch mismatch is not ordered.
BEGIN;
CREATE OR REPLACE FUNCTION public.read_v105_table_publications()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
WITH snapshot_authority AS MATERIALIZED (
  -- pg_current_snapshot uses GetActiveSnapshot, the same snapshot used by this
  -- STABLE SQL function. Reject own-write and standby visibility exceptions.
  SELECT pg_current_snapshot() AS snap,
    NOT pg_is_in_recovery() AND pg_current_xact_id_if_assigned() IS NULL AS valid,
    encode(sha256(convert_to((SELECT system_identifier::text FROM pg_control_system())
      || ':' || (extract(epoch FROM pg_postmaster_start_time())*1000000)::bigint::text, 'UTF8')), 'hex') AS epoch
), observation AS MATERIALIZED (
  SELECT CASE WHEN valid AND length(snap::text) <= 65536
    AND (SELECT count(*) FROM pg_snapshot_xip(snap)) <= 2048
    THEN jsonb_build_object('epoch',epoch,'snapshot',snap::text) ELSE NULL END AS evidence
  FROM snapshot_authority
), latest AS MATERIALIZED (
  SELECT * FROM public.cloud_table_snapshots ORDER BY snapshot_at DESC, id DESC LIMIT 1
), raw AS MATERIALIZED (
  SELECT s.snapshot_at, e.screen, e.ordinality,
    count(*) OVER (PARTITION BY e.screen->>'tableId') AS identity_count,
    CASE WHEN e.screen->>'roundBasis' = 'completed' AND e.screen->>'round' ~ '^[0-9]{1,9}$'
      THEN (e.screen->>'round')::integer + 1 END AS target_round,
    CASE WHEN pg_catalog.pg_input_is_valid(e.screen->>'sourceUpdatedAt', 'timestamp with time zone')
      THEN (e.screen->>'sourceUpdatedAt')::timestamptz END AS captured
  FROM latest s CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.tables) = 'array' THEN s.tables ELSE '[]'::jsonb END
  ) WITH ORDINALITY e(screen, ordinality)
), bundles AS (
  SELECT r.*, p.table_screen, p.prediction_payload, p.revision, p.published_at,
    p.source_captured_at, p.prediction_id,
    coalesce(r.identity_count = 1 AND p.table_id IS NOT NULL
      AND p.shoe_no = r.screen->>'shoe' AND p.target_round = r.target_round
      AND r.captured BETWEEN statement_timestamp() - interval '120 seconds' AND statement_timestamp()
      AND r.snapshot_at BETWEEN statement_timestamp() - interval '120 seconds' AND statement_timestamp()
      AND p.source_captured_at BETWEEN statement_timestamp() - interval '120 seconds' AND statement_timestamp()
      AND p.snapshot_at BETWEEN statement_timestamp() - interval '120 seconds' AND statement_timestamp()
      AND EXISTS (SELECT 1 FROM public.ai_strategy_versions WHERE version='v105' AND status='active' AND issuance_enabled IS TRUE)
      AND d.source='ofalive99' AND d.strategy_version='v105'
      AND d.table_id=p.table_id AND d.shoe_no=p.shoe_no AND d.round_no=p.target_round
      AND d.prediction_issued_at IS NOT NULL AND d.settlement_final IS NOT TRUE
      AND d.actual_result IS NULL AND d.resolved_at IS NULL
      AND p.prediction_payload = d.issued_prediction_payload || jsonb_build_object('predictionId',d.id,'issuedAt',d.prediction_issued_at)
      AND d.issued_prediction_payload->>'targetTableId'=p.table_id
      AND d.issued_prediction_payload->>'targetShoe'=p.shoe_no
      AND d.issued_prediction_payload->>'targetRound'=p.target_round::text
      AND d.issued_prediction_payload->>'strategyVersion'='v105'
      AND d.issued_prediction_payload->>'predictedResult'=d.predicted_result
      AND d.issued_prediction_payload->>'confidence'=d.confidence::text, false) AS ready
  FROM raw r LEFT JOIN public.v105_table_publications p ON p.table_id=r.screen->>'tableId'
    LEFT JOIN public.daily_prediction_results d ON d.id=p.prediction_id
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'table', CASE WHEN ready THEN table_screen ELSE screen END,
  'prediction', CASE WHEN ready THEN prediction_payload ELSE NULL END,
  'publication', jsonb_build_object('state', CASE WHEN ready THEN 'ready' ELSE 'pending' END,
    -- Wall time is TTL metadata only; never orders different MVCC snapshots.
    'observation', (SELECT evidence FROM observation),
    'observedAtMicros', (extract(epoch FROM statement_timestamp()) * 1000000)::bigint::text,
    'revision', CASE WHEN ready THEN revision ELSE NULL END,
    'publishedAt', CASE WHEN ready THEN published_at ELSE NULL END,
    'sourceCapturedAt', CASE WHEN ready THEN source_captured_at ELSE captured END,
    'rawIdentity', jsonb_build_object('tableId',screen->>'tableId','shoe',screen->>'shoe','round',target_round),
    'readyIdentity', CASE WHEN ready THEN jsonb_build_object('tableId',screen->>'tableId','shoe',screen->>'shoe',
      'round',target_round,'predictionId',prediction_id) ELSE NULL END)
) ORDER BY ordinality), '[]'::jsonb) FROM bundles;
$fn$;
REVOKE ALL ON FUNCTION public.read_v105_table_publications() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_v105_table_publications() TO service_role;
COMMIT;
