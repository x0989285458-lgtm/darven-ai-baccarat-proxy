# 瑞文AI百家預測 v100.0.8

正式AI百家產品Monorepo。現行策略、Runtime、資料讀取與報表只使用`v100`。

## 正式元件

| 元件 | 位置 | 正式部署 |
|---|---|---|
| 前台／後台 | `frontend/` | Cloudflare Pages |
| Proxy API | `proxy/` | Render |
| MT真牌Worker | `cloud-browser-worker/` | GCP台灣VM＋systemd＋Docker |
| Database | `frontend/supabase/` | Supabase |
| Release Gate | `scripts/verify-v100-release.mjs` | 本機／CI |

## 正式資料鏈

```text
MT真牌 → GCP Worker → 每5秒HTTPS Push → Render Proxy → Supabase → Frontend
```

正式桌台固定：

```text
BAG01, BAG02, BAG03, BAG03A, BAG05, BAG06, BAG07, BAG08, BAG09, BAG10
```

## 安全界線

- Frontend只讀Proxy，不持有service role、DB連線、Worker ingest key或MT token。
- Proxy與Worker Secret只存在後端環境。
- Supabase Public Schema函式只允許`service_role`執行。
- 真牌只有驗證Final action可進正式Queue／ACK／結算；`show_poker`只視為暫定。
- 正式Runtime、校準與前台歷史只讀`v100`。

## Database檔案

只保留：

```text
frontend/supabase/schema_v100_baseline.sql
frontend/supabase/schema_v100_latest_only.sql
frontend/supabase/rollback_v100_latest_only.sql
```

## 驗證

```bash
cd proxy && npm test
cd ../frontend && npm test && npm run build
cd ../cloud-browser-worker && npm test
cd .. && node scripts/verify-v100-release.mjs
```

完整部署流程見`proxy/deploy/DEPLOYMENT.md`及`cloud-browser-worker/deploy/vm/RUNBOOK.md`。
