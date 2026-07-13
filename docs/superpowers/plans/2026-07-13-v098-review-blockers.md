# v098 Review Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all seven confirmed v098 release blockers while preserving the approved v097 behavior.

**Architecture:** Add one regression test per observed failure and repair only the owning boundary: SQL RPC, Proxy strategy/table/auth lifecycle, writer caches, Worker FIFO, and saved-row reports. Production uncertainty remains fail-closed; local behavior is explicit.

**Tech Stack:** Node.js ESM and `node:test`, PostgreSQL PL/pgSQL, React/Vitest, npm.

## Global Constraints

- Preserve the approved v097 strategy identity, weights, thresholds, and Dragon Bonus behavior.
- Preserve v010 layout and public v098 protocol/build metadata.
- Do not access secrets or production databases; do not push or deploy.
- Every production change requires a failing regression test first.

---

### Task 1: Atomic settlement and strategy gate

**Files:**
- Modify: `frontend/supabase/schema_v098_snapshot_safety.sql`
- Modify: `proxy/src/server.js`
- Modify: `proxy/src/supabase-writer.js`
- Test: `proxy/test/v098-persistence-atomicity.test.js`
- Test: `proxy/test/v098-active-strategy.test.js`

- [ ] Add tests proving conflicting duplicate payloads are rejected and missing/unverified production strategy state emits no prediction or persistence.
- [ ] Run the focused tests and confirm the expected assertions fail.
- [ ] Make SQL conflict success conditional on exact stored payload equality and require verified runtime readiness.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Authoritative empty tables and safe SSE sessions

**Files:**
- Modify: `proxy/src/server.js`
- Modify: `proxy/src/license-admin.js`
- Test: `proxy/test/v098-second-review.test.js`
- Test: `proxy/test/v098-member-session.test.js`

- [ ] Add tests proving `setTables([])` cannot resurrect a cloud snapshot and SSE revalidation neither retains a password nor calls login validation.
- [ ] Run the focused tests and confirm the expected assertions fail.
- [ ] Treat post-live empty state as authoritative and add license-identity session validation without login-audit writes.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Bounded lifecycle caches

**Files:**
- Modify: `proxy/src/server.js`
- Modify: `proxy/src/supabase-writer.js`
- Test: `proxy/test/v098-second-review.test.js`
- Test: `proxy/test/v098-persistence-atomicity.test.js`

- [ ] Add tests that exercise cache cleanup through observable retry/idempotency behavior.
- [ ] Run the focused tests and confirm the expected assertions fail.
- [ ] Remove prepared payloads after durable success and bound/prune tombstones while retaining failed retry payloads.
- [ ] Re-run the focused tests and confirm they pass.

### Task 4: First-snapshot FIFO recovery

**Files:**
- Modify: `cloud-browser-worker/src/snapshot-pusher.js`
- Test: `cloud-browser-worker/test/snapshot-pusher.test.js`

- [ ] Change the baseline expectations to require delivery and explicit acknowledgement of first-seen retained rounds.
- [ ] Run the focused tests and confirm they fail on the current baseline behavior.
- [ ] Enqueue every first-seen unacknowledged completed round through the existing durable FIFO.
- [ ] Re-run Worker snapshot tests and confirm they pass.

### Task 5: Approved-strategy stable reports

**Files:**
- Modify: `proxy/src/stable-report.js`
- Modify: `proxy/src/license-admin.js`
- Test: `proxy/test/v098-stable-report-contract.test.js`
- Test: `proxy/test/v098-admin-side-actions.test.js`

- [ ] Add rows from legacy and duplicate cross-strategy settlements and assert they are unavailable/invalid rather than counted.
- [ ] Run the focused tests and confirm they fail.
- [ ] Filter the approved v097 strategy at both aggregation and database-query boundaries and deduplicate by physical settlement identity.
- [ ] Re-run the focused tests and confirm they pass.

### Task 6: Full release verification

**Files:**
- Verify all modified files and tests.

- [ ] Run `npm --prefix proxy test` and require zero failures.
- [ ] Run `npm --prefix cloud-browser-worker test` and require zero failures.
- [ ] Run `npm --prefix frontend test` and `npm --prefix frontend run build` and require zero failures.
- [ ] Run syntax checks, `npm audit` for all packages, and `git diff --check`.
- [ ] Send the final Git range to 小馬 for read-only review and resolve only evidence-backed findings through another RED/GREEN cycle.
