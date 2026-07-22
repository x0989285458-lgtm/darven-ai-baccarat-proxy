# Darven Cloud Browser Worker v104

正式抓牌Worker部署於GCP台灣VM `darven-mt-taiwan-worker-5`，由systemd `darven-worker.service`與Docker維持。Worker攔截MT JSON／WebSocket／localStorage資料，保存未ACK FIFO Queue，並主動以HTTPS推送到Render Proxy。

## 正式架構

```text
GCP台灣VM Worker → HTTPS POST → Render Proxy → Supabase
```

- 正式Build：`104`
- Push Protocol：`v104`
- Image：每個Release使用不可變Tag `darven-worker:v104-<sha7>`
- Queue／Cursor：Host bind mount `/var/lib/darven-worker:/app/data`
- Runtime env：`/etc/darven-worker/worker.env`（mode 600）
- 入口帳密：GCP Secret Manager `darven-portal-username`／`darven-portal-password`；啟動時合成到tmpfs `/run/darven-worker-secrets/portal-credentials.json`（mode 400），唯讀掛載，停服即刪
- Release image pointer：`/etc/darven-worker/release.env`
- 正式桌台：BAG01、BAG02、BAG03、BAG03A、BAG05、BAG06、BAG07、BAG08、BAG09、BAG10
- Render Worker與Docker Compose正式路徑已停用；不得把Worker部署到無persistent storage的服務。

## GCP VM部署

依照：

```text
deploy/vm/RUNBOOK.md
```

正式systemd template：

```text
deploy/vm/darven-worker.service
```

VM的`worker.env`至少需要：

```env
MT_LOGIN_URL=後端安全設定
NODE_ENV=production
WORKER_ADMIN_KEY=後端安全設定
INGEST_KEY=後端安全設定
PUSH_TARGET_URL=https://darven-ai-baccarat-proxy.onrender.com/api/cloud-ingest/snapshot
HEADLESS=true
SNAPSHOT_PATH=/snapshot
INITIAL_SETTLE_MS=5000
PAGE_TIMEOUT_MS=45000
```

不得提交或輸出上述secret值。

## 發布驗證

1. 從已審核Commit建立不可變Image。
2. 保留現行Image tag作回滾點。
3. 更新`release.env`後restart `darven-worker.service`。
4. Container為running，systemd為active。
5. `/health`回`buildVersion: "104"`。
6. `/snapshot`只在帶`x-worker-admin-key`時可讀。
7. Proxy `/api/status`為`buildVersion: "v104"`、10桌、Persistence正常。
8. Worker取得精確`sequence`與`acceptedRoundKeys` ACK後才移除Queue head。
9. 重啟服務後未ACK Queue仍存在並優先重送。

## 安全與資料完整性

- `MT_LOGIN_URL`含token，不得貼到Git、聊天、截圖或log。
- 選用入口自動登入時，設定 `PORTAL_CREDENTIALS_FILE` 為容器內 Secret JSON 路徑，內容僅含 `{"username":"...","password":"..."}`；未設定即維持原有 `MT_LOGIN_URL` 行為。
- 輪替後的 MT storage state 原子寫入 `MT_SESSION_PATH`（預設 `./data/mt-session.json`），與 Queue/Cursor 分檔；候選 host 僅允許 `MT_LOGIN_URL` host 或 `MT_HOST_ALLOWLIST`。
- production缺少`WORKER_ADMIN_KEY`、`INGEST_KEY`或`PUSH_TARGET_URL`時拒絕啟動。
- `/snapshot`與`/reload`只接受Header，不接受query token。
- 只推送已驗證Final；`show_poker`不得占用同局Identity。
- 未收到成功且精確匹配的ACK前，完整Envelope持續保留在Durable FIFO。
- 不得刪除`/var/lib/darven-worker`；回滾只切Image，不清Queue／Cursor。
