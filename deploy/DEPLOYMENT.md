# v041 正式雲端前後台部署檢查表

## 1. Supabase

1. 先在 Supabase SQL Editor 套用：

```text
frontend/supabase/schema_v039_cloud_capture.sql
```

2. 確認 RLS 已啟用，backend service role 才能寫入：

```text
cloud_capture_status
cloud_table_snapshots
cloud_table_rounds
cloud_strategy_reports
cloud_strategy_adjustment_stats
```

## 2. Backend API

部署 `proxy/` 為 Node web service。

必要後端環境變數：

```text
DEPLOY_MODE=cloud
CAPTURE_SOURCE=cloud_browser
PUBLIC_FRONTEND_ORIGIN=https://app.your-domain.com
CLOUD_BROWSER_URL=https://cloud-worker.example/snapshot
CLOUD_CAPTURE_POLL_MS=2000
SUPABASE_URL=https://gscfexhsqxvtpyxudtza.supabase.co
SUPABASE_SERVICE_ROLE_KEY=後端專用，不可放前台
SUPABASE_DB_CONNECTION_STRING=後端專用，可選
```

Smoke check：

```text
GET  /health
GET  /api/status
GET  /api/tables
GET  /api/cloud-capture/status
POST /api/cloud-capture/tick
POST /api/cloud-capture/start
POST /api/cloud-capture/stop
```

## 3. Frontend / 後台

部署 `frontend/` 為靜態網站。

正式前台環境變數：

```text
VITE_DRAVEN_API_MODE=cloud
VITE_DRAVEN_CLOUD_API_URL=https://api.your-domain.com
VITE_SUPABASE_URL=https://gscfexhsqxvtpyxudtza.supabase.co
VITE_SUPABASE_ANON_KEY=Supabase anon public key
```

前台不可放：

```text
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_DB_CONNECTION_STRING
MT_TOKEN
CHROME_CAPTURE_URL
```

## 4. Cloud worker

`CLOUD_BROWSER_URL` 指向雲端抓取 worker 的 snapshot endpoint。

worker 應回傳：

```json
{
  "connected": true,
  "authenticated": true,
  "sessionId": "cloud-session-1",
  "tables": [],
  "rounds": []
}
```

## 5. v042 smoke 實測

沒有正式 worker 前可先啟動本機 mock worker：

```text
cd proxy
npm.cmd run mock:cloud-worker
```

正式 API / worker 上線後執行：

```text
cd proxy
set DRAVEN_API_BASE_URL=https://api.your-domain.com
set CLOUD_BROWSER_URL=https://cloud-worker.example/snapshot
npm.cmd run smoke:cloud
```

通過時會輸出：

```json
{"ok":true,"failures":[]}
```

## 6. 上線判定

完成以下檢查才算正式可用：

- `/health` 回 `version: 041`。
- `/api/cloud-capture/status` 顯示 `workerConfigured: true`。
- `/api/cloud-capture/tick` 能觸發 worker。
- `cloud_capture_status` 有更新。
- `cloud_table_snapshots` 有最新 snapshot。
- 前台以 `VITE_DRAVEN_API_MODE=cloud` 開啟。
- 後台登入/授權功能正常。
- 若 MT 雲端 IP 被擋，不可假裝成功；改接登入 session flow 或保留 local bridge 備援。
