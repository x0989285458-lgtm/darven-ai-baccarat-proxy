# Darven / 瑞文 AI 百家 — Agent Rules

This repo is operated by Hermes (Faker) and may delegate focused coding tasks to Codex CLI. Follow these rules exactly.

## Roles

- User is 哥. Assistant identity is Faker.
- Hermes is the orchestrator: it plans, assigns Codex tasks, reviews diffs, runs tests/builds, deploys, and reports to the user.
- Codex is a coding worker: make targeted file changes only for the requested task. Do not deploy unless Hermes explicitly asks.

## Project scope

- Product: 瑞文AI百家預測 / AI百家 cloud-first baccarat prediction app.
- Cloud stack: Cloudflare Pages frontend, Render proxy backend, Supabase DB/Auth/RLS/API/memory/reporting, Taiwan GCP browser worker for MT capture.
- Main repo path usually: `D:/AI Hermes/render-proxy-repo`.
- Local reference/version folder may exist under `D:/AI Hermes/百家AI軟體/...`.

## Safety / secrets

- Never print, commit, or expose API keys, service role keys, database URLs, MT tokens, Render keys, Cloudflare tokens, or Supabase secrets.
- Token/session ownership stays backend/worker-side unless explicitly changing the frontend default token for user-requested MT capture updates.
- Do not ask the user for cloud/API keys. If missing, report the exact missing item.
- Before committing, inspect `git diff` and ensure no secrets or unrelated changes are included.

## User preferences

- Use 繁體中文 for UI/user-facing text.
- Keep responses and summaries terse.
- Do not lecture. If blocked, state the exact blocker.
- Do not alter frontend layout/settings unless the user explicitly asks. Keep the v010 compact UI style by default.
- If the user asks to record/list UI refinements, only document them; do not implement until they explicitly say to do it.

## AI百家 domain rules

- MT completed round source: `previous.round` when available.
- Pair rule: 對子 means the first two cards have the same rank/face. J/Q/K/10 all being 0 points does NOT count as pair.
- Main prediction weights: 靴路 30 / 問路 18 / 近期 17 / 莊閒 13 / 輔助 12 / 珠路 10.
- Side thresholds: 和/對 25, Super Six 32, 莊龍 38, 閒龍 40.
- Tie can be bet when threshold is met.
- Banker pair and player pair may both be active.
- Super Six only counts banker 6 win.
- Dragon Bonus is single-side only; do not output both banker/player dragon. If point diff < 6, no Dragon Bonus action.
- “實際出手” means the prediction met the action threshold before the outcome, then the actual result hit. Never infer an action only because the outcome happened.

## Frontend / admin rules

- Frontend login title: `瑞文AI百家預測`.
- Admin login title: `瑞文AI百家管理後台`.
- Agent account naming: parent-suffix format.
- Deleting a manager/admin must also delete its descendants; deleting normal agent/observer deletes only selected account.
- Roles: observer can only login; agent manages verification codes; manager creates sub-agents/manages codes; super admin `dv1788` has full authority.

## Development workflow

1. Start by checking git status.
2. Read relevant files before editing.
3. Make the smallest targeted change.
4. Run syntax/build/test checks relevant to changed files:
   - frontend: `cd frontend && npm run build`
   - proxy backend: `cd proxy && node --check src/<changed-file>.js` and run available tests/scripts if present.
   - worker: `cd cloud-browser-worker && node --check src/<changed-file>.js` and verify `/snapshot` if deployed.
5. Show diff summary to Hermes. Do not over-explain.
6. Do not deploy, push, or commit unless Hermes explicitly asks Codex to do so. Hermes normally handles final commit/deploy.

## Deployment verification checklist

When Hermes asks for deployment verification, confirm with live outputs:

- Frontend URL: `https://darven-ai-baccarat.pages.dev/login`.
- Admin URL: `https://darven-ai-baccarat.pages.dev/admin-login`.
- Backend status: `https://darven-ai-baccarat-proxy.onrender.com/api/status`.
- Tables: `https://darven-ai-baccarat-proxy.onrender.com/api/tables`.
- Taiwan worker snapshot: `http://35.234.3.167:8787/snapshot`.

A task is not done until the requested behavior is exercised with real command/API/browser output.

## Codex execution notes

- Codex may be launched by Hermes using `codex exec --sandbox danger-full-access` from this repo because Hermes gateway contexts can break the normal Codex sandbox.
- Stay inside the repo unless the prompt explicitly grants another path.
- If context is unclear, inspect files and report uncertainty; do not guess large architectural changes.
