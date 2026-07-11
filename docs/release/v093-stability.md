# v093 穩定性強化

本版基於 v092（`v092-穩定抓牌真牌去重` / `0731105`）追加穩定性與安全強化；未調整預測規則、權重、門檻，也未變更既有前台版面結構。

## 內容

1. 監控腳本
   - 新增 `proxy/scripts/v093-health-monitor.mjs`。
   - 可本機執行 `cd proxy && npm run monitor:v093`。
   - 檢查後端 `/api/status`、`/api/tables`、`/api/cloud-data/status`、Worker `/snapshot`，輸出繁中摘要。
   - Worker key 僅由環境變數帶入 header，不會列印 token。

2. 前台資料過期標示
   - 前台依 `sourceUpdatedAt` 與 API 狀態文字判斷資料是否過期。
   - 只在既有 header meta 旁新增「資料過期」badge，不改主版面。
   - 過期資料會顯示為等待更新，不再當成即時同步狀態。

3. Supabase/API 降頻
   - 前台 SSE 備援輪詢預設由 3 秒降為 5 秒。
   - SSE watchdog 新鮮窗口放寬為 15 秒，避免 heartbeat 正常時重複打 `/api/tables`。
   - 後台/前台 online core 狀態輪詢由 5 秒降為 15 秒。
   - proxy SSE 廣播輪詢由 1.5 秒降為 3 秒。
   - cloud worker snapshot 拉取預設由 2 秒降為 5 秒。

4. 控制 API 權限
   - `/api/cloud-capture/tick|start|stop` 支援 `PROXY_CONTROL_TOKEN`（或沿用 `WORKER_ADMIN_KEY`）驗證。
   - 支援 `CONTROL_ALLOWED_ORIGIN` 限制來源。
   - token 僅允許 `X-Control-Token` header 或 Bearer 傳入，不接受 URL query/body，也不移到前端。

5. Worker 權限
   - `/snapshot` 維持既有可讀需求：未設定 key 時相容公開讀；設定 key 時需授權。
   - `/reload` 控制操作設定 key 時只接受 header，不接受 query token，避免控制 token 出現在 URL。
   - token 比對改為 constant-time。

## 驗證

- frontend：新增 stale badge 與輪詢節流測試。
- proxy：新增控制 API 權限與 cloud capture 預設降頻測試。
- cloud-browser-worker：新增控制操作 query token 拒絕測試。
