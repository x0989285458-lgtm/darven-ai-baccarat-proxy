# VM 主動推送 Snapshot 到 Render

## 架構與正式流量

VM 的 cloud-browser-worker 每 5 秒取得本機既有 snapshot，以 HTTPS `POST` 到 Render 的 `/api/cloud-ingest/snapshot`。Render 驗證金鑰、timestamp、sequence、payload 與 tables 後，沿用既有 cloud capture state／Supabase 寫入流程。

正式環境不再設定 `CLOUD_BROWSER_URL` 指向 Quick Tunnel。Quick Tunnel 僅在人工診斷 VM `/snapshot` 時短暫開啟，不能列為正式依賴。

## Render 設定

在 Render proxy 設定下列環境變數，值只存放於 Render Secret 管理介面：

```env
INGEST_KEY=<由維運人員建立的高強度隨機值>
```

若暫時未設 `INGEST_KEY`，endpoint 會相容使用既有 `WORKER_ADMIN_KEY`。正式環境建議使用獨立 `INGEST_KEY`。部署後 endpoint 只接受 `x-worker-key`，不接受 query string 金鑰。

## VM 啟用

1. 將 repo 放在 `/opt/darven`，確認 `cloud-browser-worker/deploy/vm` 路徑存在。
2. 複製 `worker.env.example` 為 `worker.env`，權限設為 `600`；只在 VM 填入真實 `MT_LOGIN_URL`、`WORKER_ADMIN_KEY`、`INGEST_KEY` 與 Render HTTPS URL。
3. 確認 VM 可對 Render 送出 TCP 443，且本機 8787 只綁定 `127.0.0.1`。
4. 安裝 systemd 範本並啟用：

```bash
sudo cp darven-cloud-browser-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now darven-cloud-browser-worker
```

5. 檢查本機 worker 與服務日誌：

```bash
curl -fsS http://127.0.0.1:8787/health
sudo systemctl status darven-cloud-browser-worker
docker compose logs --tail=100 cloud-browser-worker
```

6. 在 Render `/api/status` 與 `/api/tables` 確認 tableCount、lastMessageAt 與桌資料持續更新。

## 中斷與恢復

Render 或網路短暫失效時，worker 僅保留 `/app/data/latest-snapshot.json` 一筆最新狀態，不會累積無限 queue。傳送採指數退避，最長 60 秒；連線恢復後送出最新 snapshot 並移除 queue 檔。

若需回復診斷拉取，才可臨時啟動 Quick Tunnel 指向 VM 的 8787，並以 `WORKER_ADMIN_KEY` 讀取 `/snapshot`。診斷完成立即關閉 Tunnel；不要把 Tunnel URL 寫回正式 `CLOUD_BROWSER_URL`。
