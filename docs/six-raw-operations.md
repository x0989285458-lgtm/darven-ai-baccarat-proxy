# 六 raw 候選操作與回滾手冊

版本：`six-raw-operations.20261020.1`。配套：[機器可讀回滾矩陣](six-raw-rollback-matrix.json)。

> **PRECOMMIT ONLY／releaseAuthorized=false。** 本輪修候選與整理暫存區，不執行 DB、六 raw 產品部署、啟動抓牌、commit/tag/push 或監控變更。唯一追加授權是建立／驗證既有 VM 的 HTTPS 傳輸入口，已完成；不包含 Pages 部署。這不是 release ticket。舊十桌 RUNBOOK 是歷史文件，不得以它的十桌 gate、Dockerfile 或自動 restart trap 操作六 raw。

## 1. 精確身份與顯示映射

來源 namespace 固定 `ofalive99`，策略 `v105`；順序必須完全一致，不能只驗 count=6。

| 順序 | Raw／API／DB／history identity | UI display ID | UI 標題 | catalog key（不可入庫） |
|---|---|---|---|---|
| 1 | BAV01 | B01-L | MT 真人百家 第1桌 | BAV01_LIVE |
| 2 | BAV02 | B02-L | MT 真人百家 第2桌 | BAV02_LIVE |
| 3 | BAV03 | B03-L | MT 真人百家 第3桌 | BAV03_LIVE |
| 4 | BAV03A | B04-L | MT 真人百家 第4桌 | BAV03A_LIVE |
| 5 | BAV05 | B05-L | MT 真人百家 第5桌 | BAV05_LIVE |
| 6 | BAV06 | B06-L | MT 真人百家 第6桌 | BAV06_LIVE |

依據：`cloud-browser-worker/src/table-policy.js`、`frontend/src/App.tsx` 的 MEMBER_TABLE_IDS/memberTableLabels/memberTableDisplayId。BAV03A 不是 BAV04；B04-L 僅顯示，不是持久化身份。不得以 BAG、BAVxx_LIVE 或顯示 ID 改寫 raw。保留 BAG01/BAG02/BAG03/BAG03A/BAG05/BAG06/BAG07/BAG08/BAG09/BAG10 歷史，不轉名、不刪除、不當作新來源 replay。

## 2. 安全與本輪停點

原 Edge upstream 是 `http://35.189.177.125.sslip.io`；公網 HTTP 可能承載 Authorization、origin secret 與登入 body，不能由前端 HTTPS 推論鏈路已加密。主線於 2026-10-20 核對後經追加授權建立獨立 TLS listener；沒有改既有 nginx/Proxy/Worker。Worker systemd failed，Proxy/Edge active，不能稱抓牌恢復。

候選 endpoint：`https://35.189.177.125.sslip.io`。外部預設 CA/hostname 驗證 TLSv1.3、Let's Encrypt 憑證通過；無 secret 403，VM 既有 secret 的 HTTPS status 200／health 503 capture_unavailable。候選 Edge 保留登入 body、Authorization、origin header 與 SSE，但只走 HTTPS；拒絕 redirects、缺 secret、HTTP incoming，TLS 失敗不降級。完整部署／續期／回滾見 [TLS 手冊](../deploy/six-raw-origin/README.md)。**正式 Pages 尚未切換，正式登入 E2E 未執行；不可宣稱正式流量已加密。** TLS 通道 PASS 不授權六 raw 部署或啟動抓牌。

歷史 baseline 曾記錄 Worker active，不能覆蓋上述較新 failed 觀測；不得宣稱正式 capture 正常。所有下列有副作用步驟均是**未執行的未來程序**，須由主 Owner 另行核准精確範圍。

## 3. Fresh checkout 與發版前封存

1. 在完整 checkout 檢查本手冊、矩陣、兩支 SQL、`.github/workflows/trusted-release-six-raw.yml`、`cloud-browser-worker/Dockerfile.six-raw`、`proxy/Dockerfile.six-raw` 及全部候選 source/tests。現在 base HEAD 為 `796bd573fa39b71ba2d0061e555de92ad45276fd`，tree `818770a15310c5c24d5dbb507ba29933040e227a`，**不是 dirty 候選的 final tree**。
2. 分開 staged/unstaged/untracked；依完整顯式 allowlist 整合，不得 `git add .`。最終候選、CI、artifact、readback 必須綁同一 immutable commit/tree；每次改檔使舊審查失效。禁止借用本機 node_modules/cache 作唯一依賴；依各 package lock 執行 canonical npm ci/test，frontend build，使用六 raw 專用 Dockerfiles。此文件任務未重跑 suite/build。
3. trusted CI 產出 Worker/Proxy image@sha256 與 attestation 後才可填候選部署身份；不得填推測 digest 或以 v105/buildVersion=105 代替 exact identity。Frontend 記錄 Pages deployment ID、commit/tree、bundle hashes。未取得時維持 BLOCK。
4. 逐角色讀回真正 owner：systemd unit/drop-ins/EnvironmentFile、手動 container、provider replica、child consumer、cron/recovery owner；不要假設 external consumer 就是 Proxy 同一映像。對應矩陣缺口全部關閉，保存不含秘密的 config/mount/network/restart-policy 與 artifact preimage。

## 4. Quiescence：所有 writer 停止，不只 Worker

由主 Owner 建立帶時間與 exact identity 的 quiescence receipt，任一步未知即 HOLD：

- 先盤點自動恢復機制，安排另行核准的維護 fence，避免 stopped producer 被 restart policy/排程拉回。**本產品候選不修改或啟用 Watchdog**；若現行獨立 recovery 無法被安全協調，切換 BLOCK，而不是偷偷改監控。
- 停止／fence 唯一 Producer，以及所有備援、browser/API collector、replay/backfill 入口。Producer stop 不等於停止 Proxy cached observer、timer、reconcile、late callback。
- HTTP Parent 明確維持 `CAPTURE_OUTBOX_CONSUMER_ENABLED=false`、`CAPTURE_OUTBOX_POLL_MS=0`；停用並讀回外部 Formal Consumer、isolated child、其他 claim/settle/issuance/shadow writers。僅設 poll=0 或僅停 claim 不夠。
- fence Receiver admission 與所有可寫 callback，等 in-flight DB 工作終止並確認沒有待送／待 claim／late writer。不能以 Promise timeout、service failed 或 quiet log 當作已停止證據。
- 固定 quiet window 的長度必須覆蓋實際 lease/timeout/restart budgets，前後重讀 source lease、sequence、issuance 與 Outbox identity，確認沒有增加。缺實際 budget、writer inventory 或 quiet proof 即 BLOCK。
- 保存完整 Worker Queue state family（main、journal、sidecar/segments）、Final Journal、Cursor、Source Owner/epoch，從有效 env/bind mount 解析路徑；逐檔 checksum、權限與容量。禁止 prune volume、清空 queue、造 ACK 或改 attempted payload。失敗補償的預設是安全 HOLD，不是無條件自動啟動已知不相容舊 writer。

## 5. DB-before-runtime 與既有真 PG 證據

兩支 repo 內 SQL 是唯一 raw compatibility pair：

| 角色 | repo path | SHA-256 |
|---|---|---|
| forward | `supabase/migrations/20261019000100_v105_six_raw_table_compatibility.sql` | `dcbb2ee5c69449e643cf0de3b13a2bbc9aa4db98dfb62997958512d7129cf6e3` |
| rollback | `supabase/operations/rollback_20261019_v105_six_raw_table_compatibility.sql` | `44dd92dbbfdfd81a4b9e6d8c49f04b906f9a9d5c1e8884ea00f82209c39115f3` |

`2026-10-19T12:56:03.256Z` 至 `12:56:25.772Z` 的 `six-raw-real-pg-verification.json` 已接受這兩個 exact hashes：真 production PostgreSQL transaction，always ROLLBACK，無 committed fixture；驗 forward compile/predecessor guards、三個 definitions/owner/ACL/search_path、service_role recent、internal accumulator denied、raw 與錯誤 identity guards、rollback exact restore、fresh catalog predecessor readback。`integration-precommit/release-review.json` 明確接受且不重開。

**本輪 SQL bytes 不改、PG 不重跑、DB 不連線。** SQL 註解及早期 `db-six-raw-plan.json` 的「驗證 pending」是較舊時間點，以上 exact-hash receipt 補正驗證狀態；不是允許修改 SQL 註解而破壞已接受 hash。這份證據不等於正式 migration 已 commit，也不代表所有 daily/compact 報表路徑驗收完成。

未來操作順序（每一步須另獲授權及 fresh readback）：

1. 完成安全／artifact／quiescence／資料保全 gate，Producer 停寫、Consumer=false。
2. 在精確專案 `gscfexhsqxvtpyxudtza` 先驗 installed predecessors、owner/ACL/search_path、依賴、CHECK 與 trigger 狀態；任何 drift 不硬套舊腳本。不可啟用 `sync_v105_formal_compact_settlement`（維持 D），不可觸發 backfill。
3. 完成第 6 節的 Outbox gate；若未獲 exact HOLD 操作授權，保持原狀停止，不能略過 backlog。
4. **先**套用並讀回已核准 raw compatibility migration，**再**替換 runtime。不得讓六 raw writer 先進舊 DB。讀回 migration provenance、三個 function definitions、CHECK、ACL 與 trigger；不得以單一 CLI exit 0 代替。
5. 先 Receiver/Proxy（consumer=false）、再精確兼容的唯一 Consumer owner，驗加密 transport/admission 與 DB provenance；這一階段 Producer 仍停。若健康依賴 fresh Final，改驗不循環的 admission gate，不以一般 status 200 冒充。
6. 只在 fresh release authorization 成立後，啟動單一 lease-fenced Producer；Frontend 切換依 exact six raw API compatibility。首個 ACK/Final 與後續持續性、逐桌 raw ID、prediction/settlement、Outbox 收斂、零新增非預期 dead-letter、登入後 API/DOM 對帳皆要獨立證據；未完成不得稱正式上線。

## 6. Outbox HOLD、保留與回滾接管

**Fresh checkout 的安全預設可直接依本節執行決策：停止所有 writers、Consumer=false、完整保留資料、維持 HOLD。** 不需要外部 cache 才知道停止條件；但這不表示 checkout 已附可正式執行的 Outbox mutation package。該 package 尚缺版本化 SQL/精確 preimage 與新的授權，故 release BLOCK，不得從舊 cache 複製腳本直接 COMMIT。

歷史 freeze `2026-10-19T12:58:01.936Z` 有 424 個 exact BAG pending、13484 個既有 dead_letter，processing/error=0；未來隔離後計算基線 13908 只是該 freeze 的預期，**不是當前 live 計數或已提交結果**。`outbox-six-real-pg-verification.json` 的 `PASS_ROLLED_BACK` 只證明 rolled-back transaction 裡 424 全列保留、status-only HOLD/reversal、外層 rollback 後原列與無新 receipt table。不要混為 raw compatibility PG 或完整負向矩陣已通過。

未來 exact HOLD 包必須先進版本控制並獨立審查：

- 鎖定 fresh exact UUID 集合，不靠年齡、LIMIT、總數相等；保存每列完整 JSON text、payload、round_keys、hash、session/sequence、timestamps、lease、attempts、last_error 與逐列 SHA-256。old dead letters 不動。
- 所有 round keys 必須可驗為 BAG，空／unknown／混 BAG+BAV 直接 BLOCK；有 processing/error 也 BLOCK。確認 schema/claims、trigger、ACL 不變。
- 在能阻止併發變更的同一交易鎖下，比對完整 preimage、先寫 owner-only receipt，再僅做精確 pending→dead_letter；保留原 payload、錯誤、時間與 lease 欄。不得刪除、偽造 complete 或修改 claims 以繞過。
- rehearsal 預設 ROLLBACK。正式 COMMIT 需要另外授權；成功後 exact afterimages/receipt/hash/count 讀回並刷新新增 dead-letter 基線，才能討論 BAV admission。舊計數不可復用。
- reversal 先停所有 writers／claims，逐列驗 exact afterimage 與 receipt，再只對本次 exact 集合恢復原 pending；receipt 保留。任何身份／hash／列狀態 drift 都停止，不覆寫。恢復 pending 後仍 Consumer=false，直到已驗證的 predecessor-compatible owner 明確接管；不得把歷史 BAG 餵給六 raw consumer。
- 已 ACK 但未完成的 BAV 工作也不能刪除或交給不支援 BAV 的舊 consumer。停止 ingress，保存 exact BAV work/lease，選擇已核准的兼容 consumer drain 或保留 HOLD；不能藉 app rollback 失去唯一處理者。

歷史 HOLD forward hash 為 `d04ffa2a40e068ece3ae570783896e5a6b06694798ca5bb3067f362d62a2f35f`；已驗證 reversal `outbox-six-cutover-rollback.sql` 為 `be4029ec858925f95da2791a31495509b4fa3dec429c54174b8b2fdb727f15c0`。早期 plan.json 的 `rollback.sql` hash 不同，**不可互換**。版本化包與 fresh 完整凍結未取得前不提供可誤執行的 COMMIT 指令。

## 7. 不可變 rollback matrix 與順序

精確值與來源 hashes 見配套 JSON；以下是已實證的歷史身份，並非已驗證可立即恢復的健康組合：

| 元件 | commit | tree | 不可變 artifact |
|---|---|---|---|
| Worker main.92 | `796bd573fa39b71ba2d0061e555de92ad45276fd` | `818770a15310c5c24d5dbb507ba29933040e227a` | `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker@sha256:cebe686a6d862d98cb0406e292965420812b7119e039948a21df9a6290c2fae4` |
| Proxy main.91 | `a88bcf9d371841d9b9f16f57495cff7218ebcb86` | `6dbdff7cd08e1d71d23c6858dc88d1073407bd17` | `ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy@sha256:f330091c49c0b700fcc28b32bba568464754f6994dbace2d5add7caba128a5f9` |
| Frontend + Pages Edge origin recovery | `b842f12ff5afbc017ff44e400f4abc00cf8820b0` | `a3a8cc4f106381080a8bf1de38ffc6976b5b8afd` | Pages production deployment `b514e727-c429-4a9e-9b36-73239e391c91`；非 OCI，不造 image digest |
| 外部 Formal Consumer | 此 VM 未配置可回滾實例 | 不替換／保持停止 | 2026-10-20 docker ps -a／systemd darven* 無此角色；不得從磁碟映像或 Proxy digest 猜選。未來若發現外部 owner，先補其 exact identity 才准變更 |
| VM nginx Edge | 非 repo 應用 commit | 保持原config不替換 | `nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10`；config SHA256 `f2508209f638f334c8a896197638674415d55b1064df4ad92a9a71090ee5f743` 已遠端讀回，含secret正文不入Git |
| VM Origin TLS | 本次唯一獲追加授權的傳輸元件 | repo 內 config/unit | `caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`；TLS 回滾受正式 HTTPS Edge 依賴保護，見 TLS 手冊 |

Git objects 已證 Worker commit 的 parent 就是 Proxy commit；Frontend 是 origin-only recovery 分支身份，不能因此推論三者協議／Queue 兼容已驗證。Pages prior deployment `1e17d11e-0378-4c86-a401-ddbe6fc19d93` 只出現在舊 metadata，不能代替上表 production readback。其 `/health` 歷史為 503 capture_unavailable，captureRestored=false，且明文 origin 問題使此 Edge 不可無條件恢復。

回滾次序：

1. 停止新 admission、所有 writer/consumer 與自動拉回風險，保存 Queue/Outbox exact evidence，等 in-flight lease/write 確認終止。
2. 先決定已 ACK 的 BAG/BAV 工作歸屬；不能 drain 則 HOLD，不能直接替換掉唯一兼容 consumer。需要 Outbox reversal 時依第 6 節 exact receipt 操作，恢復後仍不啟用 consumer。
3. 在所有 BAV writer 停止下才允許 raw compatibility rollback，恢復 exact 三個 predecessor function definitions。若 `v105_formal_compact_settlements` 有任一 BAV row，**保留 widened BAG+BAV CHECK**；只在沒有 BAV compact rows 時才恢復原 BAG CHECK。不刪資料、不縮窄到非法、保持 disabled trigger 與 ACL。這是資料保留相容回滾，不是強迫 schema byte-identical reversal。
4. 按矩陣恢復已驗證且本次確實替換的 Receiver/Consumer/Frontend/Worker artifact 與有效 config；原未配置的 Consumer 保持停止、未改的 nginx 與 TLS 保留。若實際切換發現另一個 Consumer owner，必須先補其 exact rollback identity，缺失即 HOLD。Frontend 舊 deployment 的 HTTP Edge 是禁止恢復的已知缺陷：只能復原舊 UI bytes 並保留經驗證 HTTPS Edge，形成另行審查的回滾候選，不能直接回推整個舊 Pages deployment。不要以 mutable tag 或舊十桌 runbook 自動 restart。
5. 先讀回 exact image/config、encrypted public admission、DB/queue compatibility，再另行核准啟動唯一 predecessor writer；要求 predecessor ACK、Final 實增及使用者可見 E2E。無授權或 gate 缺失不得自動 resume。

## 8. Watchdog 明確移出本次產品提交

以下全部 **EXCLUDED_FROM_PRODUCT_COMMIT**，保持原檔不改、不 stage、不刪除：

- `scripts/ai_baccarat_data_watchdog_six_raw_candidate.py`
- `scripts/test_watchdog_six_raw_candidate.py`
- `scripts/watchdog-six-raw-candidate.json`
- `scripts/watchdog-six-raw-*.log`（包含 contract/red/green/inspect/public-status logs）

此隔離不靠 .gitignore 掩蓋，整合者須對最終提交 allowlist 與 index 逐檔檢查；候選目前 untracked 不是已提交成功的證據。Watchdog 將來若另案納入，必須處理 host-local gcloud path、portable fixture、狀態檔/權限與 recovery side effects，再走獨立授權；**本輪不加 CI、不修監控、不啟用監控**。cache、frontend/verification 與 transcript/log 不是 runtime dependencies，也不可盲目提交。

## 9. 交付檢查與仍未解 Gate

本文件包可離線核對 JSON、六 ID/display 映射、exact Git objects、SQL SHA-256、RUNBOOK 歷史正文保留及 Watchdog 不在 index；全部僅 SELF_CHECK，不代表 release PASS。外部 historical receipt 的 hashes 已收錄 JSON；它們提供來源追溯，以上安全流程不依賴 cache 路徑才能理解。

提交前四項關卡：候選安全轉送、操作／回滾文件、Watchdog 排除、精確暫存區／測試／獨立審查。最終結果由 repo 外綁定 Tree 的回條判定，不能由本文件自批 PASS。

下列是**未來部署 Gate，不是本輪已執行項目**：fresh runtime/Queue/DB provenance、版本化 exact Outbox HOLD/reversal 包與單獨授權、trusted images、正式 Pages HTTPS 切換與登入 E2E。未全過仍不可部署／宣稱正式上線；本輪只有額外核准的 TLS 傳輸設定已落地，沒有 DB、六 raw runtime、監控或 Git 發布副作用。
