# v104.0.0-formal.2 正式部署檢查表

## v104正式邊界

- v104成為唯一Active；主預測使用已核准v104防鎖邊策略，副預測權重、門檻與方向Gate完整沿用v102。
- 先停用v104 Shadow新寫入並保留全部歷史，再套用`frontend/supabase/schema_v104_formal.sql`。
- 正式Runtime只讀`daily_prediction_results`中的v104 immutable issuance／Final；不得讀v103／v104 Shadow資料校準正式輸出。
- Frontend、Proxy、Worker、Push Protocol、策略與監控身分統一為v104（Worker build `104`）。
- 正式E2E完成前保留v102 RPC EXECUTE；完成後才執行`finalize_v104_cutover.sql`。
- 回滾採application-first，執行`rollback_v104_to_v102.sql`原子恢復v102 Active與RPC權限，保留v104歷史證據。
- v103 Shadow可繼續觀察；v104 Shadow升正式後強制disabled且不得再次發行。

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
- Database：Supabase，部署後只允許v104正式策略新寫入
- Worker資料鏈：每5秒主動HTTPS Push到`/api/cloud-ingest/snapshot`

## Database

Fresh install依序套用歷史Baseline與正式migration，最後套用v104：

```text
frontend/supabase/schema_v100_baseline.sql
frontend/supabase/schema_v101_latest_only.sql
frontend/supabase/schema_v102_latest_only.sql
frontend/supabase/schema_v103_shadow.sql
frontend/supabase/schema_v104_shadow.sql
frontend/supabase/disable_v104_shadow.sql
frontend/supabase/schema_v104_formal.sql
```

既有正式環境先在同一交易中依序套用：

```text
frontend/supabase/disable_v104_shadow.sql
frontend/supabase/schema_v104_formal.sql
```

此步保留v102 RPC權限。待v104 Proxy、Worker、10桌、Push ACK、Queue與DB前進全部驗證後，才套用：

```text
frontend/supabase/finalize_v104_cutover.sql
```

回滾只使用：

```text
frontend/supabase/rollback_v104_to_v102.sql
```

要求：

- `ai_strategy_versions`只能有一筆`v104:active`
- 所有Public Schema函式不得授權`PUBLIC`、`anon`或`authenticated`
- DB migration階段`service_role`同時保有v102/v104 RPC EXECUTE；正式E2E後finalize撤除v102 EXECUTE
- Frontend只讀Proxy，不持有service role或DB連線

## Proxy（Render）

必要後端設定：

```text
DEPLOY_MODE=cloud
CAPTURE_SOURCE=cloud_browser
V100_RELEASE_ENABLED=true
V103_SHADOW_ENABLED=true
V104_SHADOW_ENABLED=false
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

要求：Release commit精確相符、`/health`為v104、`/api/status`只顯示v104、`/api/tables`只有核准10桌。

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

## v104.0.0-formal.2 完成標準

- Proxy、Worker、Frontend皆對應同一個Git commit及`v104.0.0-formal.2` Tag
- 10桌依序為BAG01、BAG02、BAG03、BAG03A、BAG05、BAG06、BAG07、BAG08、BAG09、BAG10
- Push ACK成功且Queue排空
- DB v104 Final筆數持續增加，部署後v102歷史筆數不再前進
- Frontend可讀到與Proxy相同桌號、靴、局
- 唯一保留的監控為抓牌3分鐘中斷自動復原警告
