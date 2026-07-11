# v094 穩定性強化

本版基於 v093（`v093-監控過期降頻權限` / `fa68ca2`）追加維運穩定性；未調整預測規則、權重、門檻，也未變更既有 UI 版面。

## 內容

1. 備份還原
   - 新增 `proxy/scripts/supabase-v094-backup-restore.mjs`。
   - 支援 `backup`、`restore`、`drill`；還原必須指定與來源不同的 `V094_RESTORE_DB_URL` 並明確確認，不列印連線字串或 secret。
   - 預設備份關鍵雲端抓牌、預測結果、策略報表、事件分層與 migration 版本表。

2. Migration
   - 新增 `frontend/supabase/schema_v094_stability.sql`。
   - idempotent 建立 `schema_migration_versions`、`cloud_operational_events`、必要 metadata 欄位與索引。
   - 僅新增/補齊，不刪資料、不改既有預測資料結構。

3. 部署回滾
   - 新增 `docs/runbooks/v094-rollback.md`。
   - 新增 `proxy/scripts/v094-rollback-check.mjs` 與 `npm run rollback-check:v094`。
   - 涵蓋前端 Cloudflare Pages、Render proxy、worker、Supabase migration/資料檢查；僅本機檢查，不部署。

4. 固定依賴
   - 前端移除 `latest`，固定目前已安裝版本。
   - proxy 依賴移除 floating range，固定目前已安裝版本。
   - 產生 npm lockfile，避免後續安裝飄版。

5. 事件分層
   - 新增 `proxy/src/event-layer.js`。
   - worker 失聯/快照錯誤記為 `capture_error`。
   - Supabase 寫入錯誤記為 `write_error`，且不把新鮮 worker 資料誤標為斷線。
   - stale data 記為 `monitor_error`。
   - 控制 API 未授權/來源拒絕記為 `control_error`。
   - 事件與錯誤訊息會遮罩 token/secret。

6. 故障測試
   - 新增 `proxy/test/v094-failure-events.test.js`。
   - 覆蓋 worker 失聯、Supabase 寫入失敗、stale data、未授權控制 API。

## 驗證

- `cd proxy && node --test test/v094-failure-events.test.js`
- `cd proxy && npm test`
- `cd cloud-browser-worker && npm test`
- `cd frontend && npm test -- --runInBand`（若 vitest 不支援此參數，改 `npm test`）
- `cd frontend && npm run build`
