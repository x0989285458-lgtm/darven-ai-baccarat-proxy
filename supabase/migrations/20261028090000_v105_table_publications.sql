-- Additive display publication only: does not issue, settle, persist raw, or ACK.
-- Apply DB-first. Both RPCs share the existing service_role trust boundary.
BEGIN;
CREATE TABLE IF NOT EXISTS public.v105_table_publications (
  table_id text PRIMARY KEY,
  shoe_no text NOT NULL,
  target_round integer NOT NULL CHECK (target_round > 0),
  prediction_id uuid NOT NULL REFERENCES public.daily_prediction_results(id),
  table_screen jsonb NOT NULL CHECK (jsonb_typeof(table_screen) = 'object'),
  prediction_payload jsonb NOT NULL CHECK (jsonb_typeof(prediction_payload) = 'object'),
  snapshot_id uuid NOT NULL,
  source_captured_at timestamptz NOT NULL,
  snapshot_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  published_at timestamptz NOT NULL
);
ALTER TABLE public.v105_table_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.v105_table_publications FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.publish_v105_table_publication(
  p_table_id text, p_shoe_no text, p_target_round integer, p_prediction_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  snap public.cloud_table_snapshots%ROWTYPE;
  pred public.daily_prediction_results%ROWTYPE;
  old public.v105_table_publications%ROWTYPE;
  screen jsonb;
  payload jsonb;
  captured timestamptz;
  disposition text := 'superseded';
  next_revision bigint;
  matches integer;
BEGIN
  IF nullif(p_table_id, '') IS NULL OR nullif(p_shoe_no, '') IS NULL
     OR p_target_round IS NULL OR p_target_round < 1 OR p_prediction_id IS NULL THEN
    RAISE EXCEPTION 'invalid publication identity';
  END IF;
  -- Independent table lanes. Read authority AFTER waiting, never before.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('v105_table_publication:' || p_table_id, 105));
  SELECT * INTO old FROM public.v105_table_publications WHERE table_id = p_table_id;
  next_revision := old.revision;
  SELECT * INTO snap FROM public.cloud_table_snapshots ORDER BY snapshot_at DESC, id DESC LIMIT 1;
  IF jsonb_typeof(snap.tables) = 'array' THEN
    SELECT count(*), jsonb_agg(e)->0 INTO matches, screen
    FROM pg_catalog.jsonb_array_elements(snap.tables) e WHERE e->>'tableId' = p_table_id;
  END IF;
  IF matches = 1 AND screen->>'roundBasis' = 'completed'
     AND screen->>'shoe' = p_shoe_no
     AND screen->>'round' ~ '^[0-9]{1,9}$'
     AND (screen->>'round')::integer + 1 = p_target_round THEN
    IF NOT pg_catalog.pg_input_is_valid(screen->>'sourceUpdatedAt', 'timestamp with time zone') THEN
      RAISE EXCEPTION 'publication source capture time is invalid';
    END IF;
    captured := (screen->>'sourceUpdatedAt')::timestamptz;
    IF captured IS NULL OR snap.snapshot_at IS NULL
       OR captured < clock_timestamp() - interval '120 seconds'
       OR snap.snapshot_at < clock_timestamp() - interval '120 seconds'
       OR captured > clock_timestamp() OR snap.snapshot_at > clock_timestamp() THEN
      RAISE EXCEPTION 'publication source snapshot is stale or future';
    END IF;
    PERFORM 1 FROM public.ai_strategy_versions
      WHERE version = 'v105' AND status = 'active' AND issuance_enabled IS TRUE FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'v105 publication requires Active issuance'; END IF;
    SELECT * INTO pred FROM public.daily_prediction_results WHERE id = p_prediction_id FOR SHARE;
    IF pred.id IS NULL OR pred.source IS DISTINCT FROM 'ofalive99'
       OR pred.strategy_version IS DISTINCT FROM 'v105'
       OR pred.table_id IS DISTINCT FROM p_table_id OR pred.shoe_no IS DISTINCT FROM p_shoe_no
       OR pred.round_no IS DISTINCT FROM p_target_round
       OR pred.prediction_issued_at IS NULL OR pred.settlement_final IS TRUE
       OR pred.actual_result IS NOT NULL OR pred.resolved_at IS NOT NULL
       OR jsonb_typeof(pred.issued_prediction_payload) IS DISTINCT FROM 'object'
       OR pred.issued_prediction_payload->>'targetTableId' IS DISTINCT FROM p_table_id
       OR pred.issued_prediction_payload->>'targetShoe' IS DISTINCT FROM p_shoe_no
       OR pred.issued_prediction_payload->>'targetRound' IS DISTINCT FROM p_target_round::text
       OR pred.issued_prediction_payload->>'strategyVersion' IS DISTINCT FROM 'v105'
       OR pred.issued_prediction_payload->>'predictedResult' IS DISTINCT FROM pred.predicted_result
       OR pred.issued_prediction_payload->>'confidence' IS DISTINCT FROM pred.confidence::text THEN
      RAISE EXCEPTION 'publication requires exact immutable non-Final prediction';
    END IF;
    payload := pred.issued_prediction_payload || jsonb_build_object('predictionId', pred.id, 'issuedAt', pred.prediction_issued_at);
    IF old.shoe_no = p_shoe_no AND old.target_round = p_target_round THEN
      IF old.prediction_id IS DISTINCT FROM p_prediction_id OR old.prediction_payload IS DISTINCT FROM payload THEN
        RAISE EXCEPTION 'publication immutable prediction conflict';
      END IF;
      -- Same snapshot id may be updated in place: compare the full image and both clocks.
      IF old.table_screen = screen AND old.source_captured_at = captured AND old.snapshot_at = snap.snapshot_at THEN
        disposition := 'duplicate';
      ELSIF captured < old.source_captured_at OR snap.snapshot_at < old.snapshot_at THEN
        disposition := 'superseded';
      ELSE
        disposition := 'published';
      END IF;
    ELSE
      disposition := 'published'; -- shoe numbers are identities, never chronology.
    END IF;
    IF disposition = 'published' THEN
      next_revision := coalesce(old.revision, 0) + 1;
      INSERT INTO public.v105_table_publications(table_id, shoe_no, target_round, prediction_id,
        table_screen, prediction_payload, snapshot_id, source_captured_at, snapshot_at, revision, published_at)
      VALUES (p_table_id, p_shoe_no, p_target_round, p_prediction_id, screen, payload,
        snap.id, captured, snap.snapshot_at, next_revision, clock_timestamp())
      ON CONFLICT (table_id) DO UPDATE SET shoe_no = EXCLUDED.shoe_no, target_round = EXCLUDED.target_round,
        prediction_id = EXCLUDED.prediction_id, table_screen = EXCLUDED.table_screen,
        prediction_payload = EXCLUDED.prediction_payload, snapshot_id = EXCLUDED.snapshot_id,
        source_captured_at = EXCLUDED.source_captured_at, snapshot_at = EXCLUDED.snapshot_at,
        revision = EXCLUDED.revision, published_at = EXCLUDED.published_at;
    END IF;
  END IF;
  RETURN jsonb_build_object('disposition', disposition, 'publication_revision', next_revision,
    'table_id', p_table_id, 'shoe_no', p_shoe_no, 'target_round', p_target_round, 'prediction_id', p_prediction_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.read_v105_table_publications()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
WITH latest AS MATERIALIZED (
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
    -- Read observation only; stable for every bundle in this SQL statement.
    -- Consumers must use fresh READ COMMITTED statements, not retained snapshots.
    'observedAtMicros', (extract(epoch FROM statement_timestamp()) * 1000000)::bigint::text,
    'revision', CASE WHEN ready THEN revision ELSE NULL END,
    'publishedAt', CASE WHEN ready THEN published_at ELSE NULL END,
    'sourceCapturedAt', CASE WHEN ready THEN source_captured_at ELSE captured END,
    'rawIdentity', jsonb_build_object('tableId',screen->>'tableId','shoe',screen->>'shoe','round',target_round),
    'readyIdentity', CASE WHEN ready THEN jsonb_build_object('tableId',screen->>'tableId','shoe',screen->>'shoe',
      'round',target_round,'predictionId',prediction_id) ELSE NULL END)
) ORDER BY ordinality), '[]'::jsonb) FROM bundles;
$fn$;
REVOKE ALL ON FUNCTION public.publish_v105_table_publication(text,text,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_v105_table_publications() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_v105_table_publication(text,text,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_v105_table_publications() TO service_role;
COMMIT;
