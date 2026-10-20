# 六 raw 正式發布準備包 v1

版本：`six-raw-release-preparation.20261020.1`。**離線準備，不是發布授權。**

本文件補充而不覆寫 `six-raw-operations.md` 及 `six-raw-rollback-matrix.json`。其「版本化 Outbox 工具尚缺」在本包通過獨立審查後由本新增工具補足；fresh 正式前像、真 PostgreSQL 演練、正式提交與部署仍未完成，不因此解除正式 Gate。

## 1. 精確範圍

- 已審產品基準 HEAD：`796bd573fa39b71ba2d0061e555de92ad45276fd`。
- 已審產品樹：`87699db91038b4b8f0d360da4d9c8c3c3d1e83aa`；該 77 檔候選不變。
- 本輪只新增 `supabase/operations/six-raw-outbox-v1/` 工具、離線測試與本發布準備文件；最終新增檔與合成候選樹由包外 hash 清單及獨立審查綁定，不把舊樹安全 PASS 當成新工具審查。
- 不執行 SQL，不連任何 DB，不操作正式服務，不 commit／tag／push／deploy，不啟用 Watchdog。Git 正式 index 保持前版；可在獨立 alternate index 計算交付樹。
- `README.md` 為離線工具的實際介面與限制；`export.sql` 為未來獲准後的快照格式，不是本輪已執行的查詢。合成測試資料只用來驗工具，不能當作正式前像。
- 交付包不是獨立應用或安裝程式。源碼／patch 須搭配指定 Git 基準使用；不能直接對正式 DB 執行包內測試產物。

## 2. 六桌唯一身份

順序固定：

1. `BAV01` → `B01-L`，MT 真人百家 第1桌。
2. `BAV02` → `B02-L`，MT 真人百家 第2桌。
3. `BAV03` → `B03-L`，MT 真人百家 第3桌。
4. `BAV03A` → `B04-L`，MT 真人百家 第4桌。
5. `BAV05` → `B05-L`，MT 真人百家 第5桌。
6. `BAV06` → `B06-L`，MT 真人百家 第6桌。

來源 `ofalive99`，主策略 `v105`。Raw/API/DB/history 一律保留 BAV；顯示代碼不是儲存身份。舊十 BAG 歷史原名保留、不轉名、不回灌新 Live。驗收需逐 ID、順序、局號、鞋號核對，count=6 不足。

## 3. Outbox 工具與未來操作邊界

工具輸入是**未來獲准後**從目標專案 `gscfexhsqxvtpyxudtza` 取得的 fresh 完整 freeze，絕不可復用歷史 424 筆清單或測試 fixture。操作資料／完整前像可能敏感，存於 repo 外 owner-only 目錄，不入 Git、不經聊天傳送，不列出 payload 或連線字串。

離線編譯器不接受 DB URL，不連 DB。產物為版本化、特定操作身份的 HOLD、reversal 與 hash manifest；演練 SQL 以 ROLLBACK 結束。**不是把產物交給 psql 就等於安全或已獲准。**

未來執行前必備：

- 精確使用者授權範圍、操作 ID、產品 commit/tree、操作腳本 SHA256、目標 project 身份與現行回滾成品。
- 獨立連線目標核對；SQL 中 project/session 設定僅是操作者聲明，不能認證 Supabase 專案。
- 完整停止所有 Producer／Receiver writes／Consumer／replay／backfill／影子 writes，包含 in-flight；維護 fence 防止 systemd、cron、watchdog 或 provider 自動重啟。
- quiet window 覆蓋當次實測 lease/timeout/restart 上限；前後 source lease、sequence、issuance、Outbox identity 不增。未取得預算不臆造秒數。
- 先保存 Worker Queue 全家族、Journal、Cursor、epoch、有效設定與 mounts，逐檔 checksum，核對容量、可還原性與權限。不能只備份主 JSON。
- fresh export 包含精確前像及非目標保護證據；過期、schema 不符、混 BAV／unknown、processing／error、未知 trigger/rule 等保持 HOLD。沒有待送列時不得造 fixture；另記 no-op readback，不把拒絕空集改成可寫空包。
- 新產物需在另獲准的隔離真 PostgreSQL 上驗前像漂移、postimage 漂移、非目標不變、receipt ACL、二連線 lock conflict、ROLLBACK 與 reversal。**本輪離線測試沒有證明 SQL 實際可執行或 DB 併發語意。** 歷史 SQL 的真 PG 回條不能移植到新 SQL。

### HOLD／reversal 不變量

HOLD 只把精確 pending BAG 目標改成 dead_letter，保存完整 before/after receipt 與 hash；不刪 payload，不改 round_keys、session、sequence、timestamps、lease、attempts、錯誤，不偽造 completed。既有 dead letters 與非目標列保持不變。receipt 必須 owner-only、RLS 且明確排除 PUBLIC／anon／authenticated／service_role 讀取；RLS 本身不防 service_role bypass。

reversal 僅由本次 exact receipt 還原本次列；要求所有 writers 已停且無 active work，完整 postimage／receipt hash 一致。若新 BAV pending 已存在、afterimage 被改或 receipt 缺失，拒絕，不刪除新工作以湊通過。恢復 BAG pending 後 Consumer 仍停；只有 predecessor-compatible owner 另行確認接管後才能啟用，不可交給六 raw consumer。

COMMIT 只能在另行授權、fresh 演練及 SQL delta 審查後選擇；本工具不提供 COMMIT CLI 開關。未來改交易終端須保留原演練 bytes/hash，單獨綁定正式 apply bytes/hash，禁止覆寫原證據。正式成功需獨立讀回精確 afterimages、receipt、非目標摘要、計數與新的 dead-letter baseline。

**結果未知處理：**連線中斷、逾時、COMMIT 回覆遺失皆不是「未執行」。維持所有 writers 停止，以新唯讀連線核對該操作 receipt＋每列原像／後像，分類完整未套用、完整已套用或不一致／未知。不自動重送，不以 receipt 缺失或 SQL exit code 單獨判定。無法確定時保持 HOLD，保留證據請主 Owner 仲裁。

## 4. 正式切換清單（全部未執行）

每步必須有時間、exact identity、核准人、結果與證據位置；缺任一前置條件即停，不跳步。以下不是一鍵部署腳本。

1. **授權與不可變成品**：獨立審查最終產品＋操作包；核准 Git 發布／可信 CI／各角色映像、DB 演練與寫入、服務切換、登入測試及測試資料清理範圍。候選映像 digest／Pages deployment ID 未產生就留空，不臆造。
2. **即時盤點與回滾身份**：重查實際 VM、Receiver、唯一 Consumer owner、DB installed definitions/ACL、Pages production_branch；記錄有效 unit/drop-ins/EnvironmentFile、container image ID/digest、network/mount/restart。歷史 matrix 只供候選定位，不當作當前健康回滾組合。
3. **停止所有寫入並保全**：依第 3 節完成 maintenance fence、in-flight 收斂及完整 Queue 保全。HTTP Parent consumer=false、poll=0；若獨立 Consumer 找不到 exact 身份，不猜 Proxy image、不啟動。
4. **fresh Outbox 凍結與交易演練**：輸出本次目標資料與所有保護證據；生成 exact packet、核對 hashes，完成新 SQL 真 PG 演練與負向 Gates。
5. **exact HOLD 提交及讀回**：只有已核准的目標集合；讀回 afterimages/receipt/非目標與新基線。HOLD 不表示歷史工作已完成。
6. **raw compatibility DB 提交及讀回**：套用既有 `20261019000100_v105_six_raw_table_compatibility.sql` 原 bytes；確認 predecessor、三個函式、owner/ACL/search_path、CHECK、migration provenance。`sync_v105_formal_compact_settlement` 維持 D，不開 backfill。DB 先於六 raw runtime。
7. **Receiver 與唯一 Consumer 就緒**：先 Receiver consumer=false，再核准且精確兼容的唯一 Consumer；Producer 仍停。驗 public HTTPS origin 憑證／hostname、Host pinning、無 HTTP fallback、DB provenance 與 admission。若業務 health 依賴 Final，採獨立不循環 preflight，不以一般 status=200 取代。
8. **單一 Producer 准入**：session 重登／續期可用、single-writer lease、exact image readback、短效 admission receipt 全過才啟動；真 source inventory 須完全等於六 BAV。第一筆 timeout/5xx、身份錯誤或 ACK 異常立即停止新 admission、保全，不持續製造 backlog。
9. **正式 Pages HTTPS 切換**：確認 production 而非 preview，部署精確 bundle/Edge，讀回 deployment ID/commit/bundle hashes。未取得登入後證據前不算 UI 交付。
10. **六桌跨局與持續容量驗收**：依第 6 節；失敗按第 5 節 HOLD／回滾，不以 image/build/health PASS 宣稱正式上線。

## 5. 各失敗點與回滾

- 正式寫入前：保持資料原狀、服務維護 fence，不自動 resume 已知 failed predecessor。
- HOLD 後、六 raw admission 前：需要恢復 BAG 時依 exact reversal，先驗 postimage、再恢復；Consumer 保持停直到可處理 BAG 的 owner 接管。
- DB compatibility 後：所有 BAV writers 停止才可用既有 rollback SQL；若存在 BAV compact rows，保留 widened BAG+BAV CHECK，不刪資料、不硬縮成 BAG-only。
- 已接收 BAV／已有 ACK：先保留 exact BAV work/lease；讓核准且兼容的 consumer drain，否則 HOLD。不能因要回滾便換掉唯一兼容 consumer、重播 BAG、清空 Queue 或造 ACK。
- Runtime／Pages：只回復此次實際替換且已重新核驗的 immutable artifact/config。未改 nginx/TLS 不重部署；不存在的 Consumer 不憑空新增。
- 舊 Pages recovery 使用 HTTP origin，**禁止整包直接回滾**。如需舊 UI，須另行審查保留 HTTPS Edge 的相容組合；無安全成品則停，不能 downgrade。
- 回滾完成也需 public encrypted admission、DB/Queue compatibility、單一 predecessor writer、新 ACK/Final 與登入後 E2E，否則只稱已停止／已恢復成品，不稱服務恢復。

## 6. 正式驗收證據表

下列都留待核准後實測，沒有預填 PASS：

- 身份：候選 commit/tree、逐角色 image@sha256／Pages deployment、有效設定與唯一 writer 相符。
- 傳輸：登入、Authorization、origin secret、API body、SSE 的 Edge→origin 使用驗證 HTTPS；無明文 fallback，測試不記錄秘密。
- 真牌：六 BAV 各有最新可信 Final、鞋／局連續與 exact ACK，DB 原始局、issuance、settlement 對帳。單有 heartbeat ACK 不足。
- 無前台流量窗：Consumer 仍自行形成下一局 issuance／後續 settlement，不能靠 Browser GET 偶然觸發掩蓋缺陷。
- 即時性：逐桌量測 Final→下一預測 durable、durable→登入後 DOM；記錄分布、最大值與測前核准的品質門檻，不用 response 快冒充預測快。
- 容量：至少 600 秒、涵蓋各桌真實跨局的同一觀察窗；比較到達／完成速率、Queue/Outbox 水位與最老年齡。新死信為零（排除本次有 exact receipt 的歷史 HOLD 基線），無持續正向積壓；樣本不足延長觀察，不補造。
- 前後台：真實登入後 protected API＋DOM＋截圖；逐桌對 ID、顯示代碼、鞋、局、預測與路單。管理端權限與資料持續更新；只看到登入頁不算。
- 恢復：有界斷線/恢復、安全 shutdown、無第二 writer，證明 Queue/ACK 與 Final/issuance 續增；未授權破壞性斷線則先取得該測試授權。
- 監控：本輪不啟用候選 Watchdog。未來只核對既有已核准監控與維護 fence 不衝突；不得偷恢復舊局數監控。
- 收尾：只清理本次 exact 測試帳號／資料，核對正式資料不變；留存部署／回滾／測試回條。Production E2E 未全過前不得稱正式可用。

## 7. 證據層級

離線 compiler/pytest PASS、獨立源碼審查、舊候選回條、真 PostgreSQL 演練、正式 commit/readback、Production E2E 是不同證據。此包只交付前兩者與可追溯的舊資料；完整真 PG／正式鏈路仍需後續明確核准及實測。
