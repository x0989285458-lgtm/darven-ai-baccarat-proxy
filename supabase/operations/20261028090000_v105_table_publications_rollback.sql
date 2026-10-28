-- Operational rollback: stop/drain publication callers BEFORE this transaction.
-- REVOKE prevents new invocations; it does not cancel an already admitted RPC.
-- Retain all bundle evidence, the read RPC, raw persistence, issuance and settlement.
-- Reapplying the forward migration deliberately re-enables publication EXECUTE.
BEGIN;
REVOKE ALL ON FUNCTION public.publish_v105_table_publication(text,text,integer,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
