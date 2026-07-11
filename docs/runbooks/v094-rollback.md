# v094 部署回滾 Runbook

本文件只提供本機檢查與人工回滾步驟；不自動部署、不自動切流量、不列印 secrets。

## 回滾前確認

1. 確認目前 repo 有 v093 tag：`git tag --list '*v093*'`。
2. 確認本機沒有未保存的人工修改：`git status --short`。
3. 若要演練 DB 還原，來源只設定 `SUPABASE_DB_URL` 或 `DATABASE_URL`；還原目標另設 `V094_RESTORE_DB_URL`，不得與來源相同，也不要把值貼到終端輸出或文件。

## 前端 Cloudflare Pages

1. 在 Cloudflare Pages 後台選擇上一個穩定部署（v093 commit `fa68ca2` 或 reviewer 指定部署）。
2. 只用 Pages 的 rollback/retry 功能，不改前端版面、不改環境變數。
3. 本機檢查：`cd proxy && npm run rollback-check:v094`，確認前端首頁可讀。

## Render proxy

1. 在 Render 後台選擇 v093 對應 commit/deploy 重新部署。
2. 確認環境變數維持原值，特別是 Supabase/Worker/control token，不要搬到前端。
3. 本機檢查：`cd proxy && npm run rollback-check:v094`，確認 `/api/status`、`/api/tables` 正常。

## Cloud browser worker

1. 若 v094 worker 異常，回到 v093 worker image/commit 或 Render/GCP 上一個穩定啟動指令。
2. 若設定 `WORKER_ADMIN_KEY`，檢查只用 header，不用 query token。
3. 本機檢查：`DRAVEN_WORKER_URL=<worker snapshot url> cd proxy && npm run rollback-check:v094`。

## Supabase migration/資料

1. v094 migration 是 additive/idempotent：新增 `schema_migration_versions`、`cloud_operational_events`、metadata 欄位與索引，不刪既有資料。
2. 回滾應優先停用讀寫新事件表的應用版本；通常不需要刪表。
3. 若要還原演練：
   - 備份：`cd proxy && npm run backup:v094`
   - 還原：先設定獨立的 `V094_RESTORE_DB_URL`、`V094_RESTORE_FILE` 與 `V094_ALLOW_RESTORE=確認還原`，再執行 `cd proxy && npm run restore:v094`
   - 演練：先設定獨立的 `V094_RESTORE_DB_URL` 與 `V094_ALLOW_RESTORE=確認還原`，再執行 `cd proxy && node scripts/supabase-v094-backup-restore.mjs drill`
4. 還原目標必須由人工確認，避免覆蓋正式資料。

## 完成條件

- 前端頁面可讀。
- proxy `/api/status` 回 200。
- proxy `/api/tables` 回 200，資料新鮮時有桌況；無桌況時錯誤訊息不含 secret。
- worker `/snapshot` 回 200 或明確授權錯誤；不得出現 token/service key。
- Supabase 寫入異常會分層為 `write_error`，worker 失聯為 `capture_error`，stale 為 `monitor_error`，控制 API 未授權為 `control_error`。
