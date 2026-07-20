# v102.0.0 正式雲端部署檢查表

## 單一正式拓撲

- Frontend：Cloudflare Pages `darven-ai-baccarat.pages.dev`
- Proxy：Render `darven-ai-baccarat-proxy.onrender.com`
- Worker：GCP台灣VM `darven-mt-taiwan-worker-5`，由systemd管理Docker
- Database：Supabase，部署後只允許v102正式策略新寫入
- Worker資料鏈：每5秒主動HTTPS Push到`/api/cloud-ingest/snapshot`

## Database

Fresh install依序套用歷史整合Baseline、v101正式migration，再套用v102 additive migration：

```text
frontend/supabase/schema_v100_baseline.sql
frontend/supabase/schema_v101_latest_only.sql
frontend/supabase/schema_v102_latest_only.sql
```

既有正式環境先套用經審查的：

```text
frontend/supabase/schema_v102_latest_only.sql
```

此步保留v101 RPC權限，避免仍在運行的v101 Proxy於DB-first切換期間中斷。待v102 Proxy、Worker、10桌、Push ACK、Queue與DB前進全部驗證後，才套用：

```text
frontend/supabase/finalize_v102_cutover.sql
```

回復時只使用：

```text
frontend/supabase/rollback_v102_to_v101.sql
```

要求：

- `ai_strategy_versions`只能有一筆`v102:active`
- 所有Public Schema函式不得授權`PUBLIC`、`anon`或`authenticated`
- DB migration階段`service_role`同時保有v101/v102 RPC EXECUTE；正式E2E後finalize只保留v102
- Frontend只讀Proxy，不持有service role或DB連線

## Proxy（Render）

必要後端設定：

```text
DEPLOY_MODE=cloud
CAPTURE_SOURCE=cloud_browser
V100_RELEASE_ENABLED=true
PUBLIC_FRONTEND_ORIGIN=https://darven-ai-baccarat.pages.dev
SUPABASE_URL=後端設定
SUPABASE_SERVICE_ROLE_KEY=後端專用
SUPABASE_DB_CONNECTION_STRING=後端專用
WORKER_INGEST_KEY=後端與Worker共用，禁止輸出
```

正式驗證：

```text
GET /health
GET /api/status
GET /api/tables
```

要求：Release commit精確相符、`/health`為v102、`/api/status`只顯示v102、`/api/tables`只有核准10桌。

## Worker（GCP VM）

Worker使用：

```text
cloud-browser-worker/deploy/vm/darven-worker.service
/etc/darven-worker/worker.env
/etc/darven-worker/release.env
/var/lib/darven-worker:/app/data
```

切換前後必須驗證：

- systemd為`active`
- 連線及驗證成功
- 10桌完整
- Cursor high-water不倒退
- 既有未ACK Queue head仍在Queue或進入ACK Cursor
- Queue最終排空
- DB Final資料持續前進

## Frontend（Cloudflare Pages）

只發布完整測試與Production Build產生的`frontend/dist`。正式環境不可包含：

```text
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_DB_CONNECTION_STRING
WORKER_INGEST_KEY
MT_TOKEN
```

Canonical URL：

```text
https://darven-ai-baccarat.pages.dev/login
https://darven-ai-baccarat.pages.dev/admin-login
```

## v102.0.0 完成標準

- Proxy、Worker、Frontend皆對應同一個Git commit及`v102.0.0-formal.1` Tag
- 10桌依序為BAG01、BAG02、BAG03、BAG03A、BAG05、BAG06、BAG07、BAG08、BAG09、BAG10
- Push ACK成功且Queue排空
- DB v102 Final筆數持續增加，部署後直接前版v101歷史筆數不再前進
- Frontend可讀到與Proxy相同桌號、靴、局
- 唯一保留的監控為抓牌3分鐘中斷自動復原警告
