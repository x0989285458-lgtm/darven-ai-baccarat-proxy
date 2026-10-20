# Origin HTTPS 操作與驗證

本檔只管理傳輸層，不啟動六 raw Worker/Consumer，不改 DB，不部署 Pages。

## 已驗證邊界

- 主機：既有 `darven-mt-taiwan-worker-5`，GCP project `project-fdf510b8-6df7-494d-a36`，zone `asia-east1-b`。
- 固定 HTTPS endpoint：`https://35.189.177.125.sslip.io`。IP 是 2026-10-20 VM metadata 讀回，不是永久靜態 IP 保證；若 IP 改變，先取得新端點的有效憑證並通過相同 Gate，再改候選，不可 fallback HTTP。
- `darven-origin-tls.service` 是唯一 TLS container owner，映像固定 `caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`。
- 公網 Pages Edge → Origin 443 為驗證憑證的 TLS；TLS terminator → `127.0.0.1:80` nginx guard → `127.0.0.1:8792` 是同 VM loopback。**不是宣稱整個程序內每一 hop 均 TLS**；機密不經公網明文。
- Caddy 不寫 access log，不設定任何 origin secret，不關閉 CA 驗證；nginx 沿用已有 `X-Darven-Edge-Secret` guard。ACME 僅 TLS-ALPN-01、禁止 HTTP challenge，不搶佔原有 80 listener。
- 憑證／ACME key 持久化在 `/var/lib/darven-origin-tls/data`，config state 在 `/var/lib/darven-origin-tls/config`；不得放 Git、下載或輸出。Caddy 自動續期，systemd 開機啟動／失敗重啟。未新增 Watchdog。
- 2026-10-20 外部預設 CA+hostname 驗證為 TLSv1.3、Let's Encrypt YE2；憑證有效期至 2027-01-18。無 secret 回 403；VM 持原有 secret 的 HTTPS `/api/status` 回 200、`/health` 回 503 `capture_unavailable`。後者反映抓牌未恢復，不是 TLS 失敗。
- **正式 Pages Edge 尚未切換**；它仍是原部署。只有候選 `_worker.js` 已改為 HTTPS。不得把本次通道驗證當成正式登入流量已修復或產品已上線。

## 安裝（須精確授權；首次建立已經完成）

安裝前先檢查服務名、443/admin 埠、CPU/RAM/disk、現行 network/firewall/routing；若有同名資產或未知 listener，不覆寫。這台 VM 已有 `https-server` tag 與 allow tcp443，故本次不改 firewall/routing，也不停止既有 Proxy/nginx/Worker。

在 VM 本機、以已審查 checkout 為工作目錄執行；遠端傳輸需驗源檔和目標 SHA-256：

```sh
sudo docker pull caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
sudo install -d /etc/darven/origin-tls /var/lib/darven-origin-tls/data /var/lib/darven-origin-tls/config
sudo install -m 0644 deploy/six-raw-origin/Caddyfile /etc/darven/origin-tls/Caddyfile
sudo install -m 0644 deploy/six-raw-origin/darven-origin-tls.service /etc/systemd/system/darven-origin-tls.service
sudo docker run --rm --network none --mount type=bind,src=/etc/darven/origin-tls/Caddyfile,dst=/etc/caddy/Caddyfile,readonly caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now darven-origin-tls.service
```

此映像沒有可假設的 `caddy` entrypoint，必須顯式 `caddy validate`／`caddy run`。`issuer acme` URL 欄位是 `dir`（不是 tls shortcut 的 `ca`）。前兩次 pre-start validation 錯誤已保留，沒有啟動或改動舊 Proxy；最終實際 bytes 已驗證。

## Readback 與負向 Gate

1. `systemctl show darven-origin-tls.service -p ActiveState -p SubState` 應 active/running；docker Config.Image 必須等於上述 digest，Config.Cmd 為 `caddy run ...`，host network、192m RAM、0.5 CPU、mounts 與本 unit 一致。
2. 對照兩個遠端 config SHA-256 與 checkout；這不是 hash 自我宣告，需遠端獨立讀回。只讀 nginx config 的 hash，不能將含 secret 正文輸出。
3. 從外部用預設 CA trust 驗 hostname、TLS、有效期；不得 `curl -k`、`rejectUnauthorized=false` 或自簽跳過。無 secret `/health` 必須 403。
4. 用 VM 已有 secret 在記憶體發 HTTPS status GET，僅輸出 status/version/reason，絕不把 secret 放命令列/log。不要為了通道測試呼叫 DB、登入、發牌或寫入 API。
5. 候選 edge 的離線測試涵蓋登入 body、Authorization、origin header、SSE、靜態資產、網路/TLS失敗、缺 secret、HTTP incoming、301/302/303/307/308。錯誤不得 fallback HTTP；redirect 不得傳回可導致憑證重送的 Location。
6. 本輪沒有把含真實密碼的 login POST 發給正式 API。候選 body/headers 轉送是離線 test-only 值證據；TLS 真通道另有實測。正式登入 E2E 留待另行核准的 Pages 部署後。

## 失敗與回滾

- 取得憑證或 TLS 驗證未過：不切 Pages、不啟 Producer、不改原80入口、不改 DB；保留日誌查明原因。不得改成 HTTP 或關閉驗證來過 Gate。
- 本次傳輸新增的回滾方式為 `sudo systemctl disable --now darven-origin-tls.service`；保留 `/var/lib/darven-origin-tls` 憑證及 config，不刪唯一證據。該動作仍須另行授權。verify service inactive/container absent、原 Proxy/nginx identity 未變。
- **上述回滾僅適用尚無正式 HTTPS Edge 依賴時。** 一旦 Pages 切換 HTTPS，停止 TLS 會讓 API fail closed；必須先 fence admission並提供另一個已驗證加密入口，或保留TLS。禁止恢復已知明文舊 Edge 當成安全回滾。
- 未改動原 nginx、Proxy、憑證 secret、Worker state 或 DB，故本次沒有那些元件的 restore/replay 操作。後續六 raw 回滾依 `docs/six-raw-operations.md`，不可套用本傳輸回滾冒充產品回滾。
