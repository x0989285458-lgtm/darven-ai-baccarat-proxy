# v098.23 Prediction Lifecycle Deployment

## Frozen contracts

- Proxy/frontend build contract: `098.23`.
- Worker protocol remains `v098`; do not redeploy or change worker protocol for this release.
- `strategyVersion` remains `v098.20_六階段權重門檻整合版`.
- Lifecycle is metadata only. Never guess outcomes and never rewrite prediction payloads, directions, features, results, hit flags, or settlement evidence during reconciliation.

## Deployment order

1. **SELECT-only dry-run (pre-migration)** — against the still-unmigrated `098.22` database, run `proxy/scripts/v09823-prediction-lifecycle-dry-run.sql` in a read-only session. The script never reads v098.23 lifecycle columns. For one authoritative live table, provide all four transaction-local settings `app.v09823_current_source`, `app.v09823_current_table`, `app.v09823_current_shoe`, and `app.v09823_current_visible_round`; otherwise leave all four unset and it deterministically uses each table's latest durable issuance (`prediction_issued_at`, then round and ID) as preview context. Review the proposed counts and `settled`, `abandoned_shoe_change`, `expired_no_final`, and `pending` classifications. Do not derive outcomes from missing roadmap rows.
2. **Apply migration** — after an external database backup, run `frontend/supabase/schema_v09823_prediction_lifecycle.sql` with service/admin privileges. The migration also copies every already-final row into `daily_prediction_results_v09823_settled_backup` before its explicit `settled` backfill. It does not classify unresolved historical rows without live context.
3. **Post-migration SQL verification** — run `proxy/scripts/v09823-prediction-lifecycle-post-migration-verification.sql` read-only. Confirm lifecycle totals are plausible, `final_status_mismatches` is zero, and preserve the output as release evidence. This is the first script in the order that reads `issuance_status`.
4. **Deploy proxy and frontend** — deploy proxy first, verify `/health` reports `buildVersion: "098.23"`, then deploy the frontend `098.23` artifact. Old `098.22` tabs fail closed until refreshed. No cloud-browser-worker change is part of this release.
5. **Verify lifecycle** — confirm one reconcile ACK per accepted `{table, shoe, visible round}`, exact ACK identity, bounded calls for all ten current tables after restart, rejection of same-shoe round regression and old-shoe replay, and `persistenceStatus:error` on RPC failure without fake settlement. Check `/api/cloud-data/status.lifecycleStats`; `activePending` must exclude expired and abandoned rows. Deliver a delayed authoritative Final fixture and verify the same prediction ID transitions from expired/abandoned to `settled`.
6. **App-first rollback** — roll proxy/frontend back to `098.22` first and verify no instance calls `reconcile_v09823_prediction_lifecycle`; only then run `frontend/supabase/rollback_v09823_prediction_lifecycle.sql`. The rollback revokes the new RPC and preserves columns, backup rows, lifecycle evidence, v098.21 issue/settle RPCs, and all prediction/settlement data.

## Release evidence

- Focused lifecycle, v098.21 compatibility, and v098.22 round-identity suites pass.
- Full proxy and frontend suites pass.
- Frontend production build succeeds.
- No production DB, network, or deployment command is executed from the preparation worktree.
