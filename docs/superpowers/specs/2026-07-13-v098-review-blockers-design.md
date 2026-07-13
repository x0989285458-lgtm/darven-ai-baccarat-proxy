# v098 Review Blockers Design

## Goal

Close the seven evidence-backed release blockers without changing the approved v097 prediction rules, the v010 layout, public protocol versions, or existing successful behavior.

## Chosen approach

Use a bounded, compatibility-preserving repair. Each defect receives a focused regression test that fails on commit `5c1e7d6`, followed by the smallest production change that makes it pass. Avoid broad refactors and keep database, Proxy, Worker, and report changes independently reviewable.

## Design

- Atomic settlement: a duplicate database identity is durable only when the stored row is byte-for-byte equivalent to the attempted immutable payload. A conflicting payload raises and rolls back both writes.
- Strategy gate: production predictions and configured persistence require an explicitly verified, non-degraded v097 runtime. Missing configuration or runtime status fails closed. Tests and explicitly local callers may disable the server gate.
- Live empty state: once the live source has supplied any snapshot, an explicit empty table list is authoritative. Supabase fallback is allowed only before the first live snapshot.
- Member SSE: sessions retain opaque license identity, not the verification password. Revalidation uses a lightweight session-status method that does not create login-audit rows.
- Bounded memory: successful prepared writes are removed; duplicate and expired prediction tombstones are bounded/pruned without weakening same-round idempotency.
- Worker recovery: every completed round that is not explicitly acknowledged enters the durable FIFO, including the first retained snapshot. Backend idempotency handles safe replay.
- Stable reports: only the approved v097 strategy is counted, and the settlement identity excludes strategy version so cross-strategy duplicates cannot double-count a round.

## Error handling and compatibility

All uncertain production states fail closed. Failed persistence retains retry material. No secret, production database, deployment, push, prediction weight, threshold, Dragon Bonus rule, or frontend layout changes are permitted.

## Verification

For every item, run its targeted test in RED and GREEN states. Then run all Proxy, Worker, and Frontend tests, the Frontend build, syntax checks, dependency audits, `git diff --check`, and an independent read-only review by 小馬.
