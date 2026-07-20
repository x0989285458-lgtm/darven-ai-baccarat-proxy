# v102 Active / v103.0.0-shadow.1 / v104.0.0-shadow.1 影子候選部署檢查表

## v104 shadow 邊界

- v102 維持唯一 Active；v103.0.0-shadow.1 繼續運行，新增 v104.0.0-shadow.1 與兩者並行。
- 依序套用 `frontend/supabase/schema_v103_shadow.sql`、`frontend/supabase/schema_v104_shadow.sql`，Proxy 分別設定 `V103_SHADOW_ENABLED=true` 與 `V104_SHADOW_ENABLED=true`。
- v104 僅使用 `v104_shadow_issuances`、`v104_shadow_settlements`、`v104_shadow_history` 與專屬 RPC；不得寫 v102/v103 表、正式統計、副預測或 ACK Queue。
- 方向與信心分離：近期校正只調信心；連續第 5 次起若支援不足，靴偏移退出方向；直接路單與衍生問路衝突時以直接路單為主，不強制反向。
- 重啟必須取最新 10,000 筆history、恢復未結算immutable issuance，且同桌並發發行需串行，避免重算或虛增連邊。
- 只有 control token 可讀 `/api/v104-shadow/status`；公開 `/api/status` 與正式 `/health` 仍只反映 v102，不因 v104 故障降級。
- 停用 v104 使用 `frontend/supabase/disable_v104_shadow.sql`，只停止新 issuance/settlement，保留歷史證據且不影響 v102/v103。
- Frontend 與 Worker build identity 不變；本文件不代表已部署。

## v103 shadow 邊界

- Active build、策略、會員前台、Worker protocol、正式統計與校準全部維持 `v102`。
- 先套用 `frontend/supabase/schema_v103_shadow.sql`，再只於 Proxy 設定 `V103_SHADOW_ENABLED=true`；Frontend 與 Worker 不變。
- migration 後確認 `ai_strategy_versions` 仍只有 `v102:active`，且 anon/authenticated 對 v103 tables/view 無 DML/SELECT、對 v103 RPC 無 EXECUTE。
- v103 只寫 `v103_shadow_issuances` / `v103_shadow_settlements`，只讀 `v103_shadow_history`；不得寫 `daily_prediction_results` 或副預測 action。
- 只有帶 control token 的 `/api/v103-shadow/status` 可觀察 `v103Shadow`；公開 `/api/status` 與 `/health` 都不得暴露 shadow，正式 health 也不得因 shadow 失敗而 degraded。
- 非破壞停用套用 `frontend/supabase/disable_v103_shadow.sql`：只停新 issuance/settlement，保留既有 500/1000 局驗證證據。
- 本文件不代表已部署；真 DB 必須另驗 migration 重跑、ACL、duplicate/conflict、Final summary/show_win、show_poker 拒絕與 PUSH。

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
V103_SHADOW_ENABLED=true
V104_SHADOW_ENABLED=true
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
