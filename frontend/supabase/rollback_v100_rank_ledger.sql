-- v100 safe app-first rollback. This file is NOT auto-executed.
-- 1. Roll back every application instance that calls apply_v100_rank_ledger_event.
-- 2. Verify no running instance invokes the RPC.
-- 3. Revoke only the RPC entry point. Preserve tables, immutable events, ledger
--    evidence, constraints, indexes, and RLS for audit and safe re-application.
revoke execute on function public.apply_v100_rank_ledger_event(jsonb, jsonb) from service_role;
