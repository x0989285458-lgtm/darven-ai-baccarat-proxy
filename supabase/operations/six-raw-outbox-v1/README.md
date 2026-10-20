# six-raw-outbox-v1：離線準備，不是 DB runner

**僅 OFFLINE_COMPILER／STATIC_SQL 候選。未連接任何 DB（含本機）、未執行 export／HOLD／reversal、未證明 PostgreSQL 語法、ACL、交易、鎖或 SQL 成效。沒有 COMMIT 選項。**

本目錄不依賴歷史 cache／424 列清單。舊盤點不是 fresh authority。所有正式 DB、只讀 export、服務停止及部署仍須主 Owner 分別授權；此包不授權它們。

## 輸入與編譯契約

1. 未來取得授權後，獨立確認所有 Producer、Receiver callback、Consumer、claims、replay/backfill 與自動重啟已停止／fence，等待 in-flight 工作確實結束。停 Worker／poll=0／timeout 不等於 quiescence。
2. 對明確目標取得新的 `export.sql` 單一 JSON text 結果，以 UTF-8 保存為 `freeze.json`，不要 psql 標題、換行折疊、BOM 或重新格式化內嵌 row text。export 是 REPEATABLE READ READ ONLY + ROLLBACK，但本輪未執行。它需要讀 pg_control_system 的權限；缺權限即 BLOCK，不用自行補值代替。
3. 另由獨立目標盤點提供 `expected-identity.json`：database、database_oid、system_identifier、server_address、server_port（整數）、role、role_oid、server_version。其餘 numeric identity 為 decimal text。不得從未驗 freeze 直接複製成「已認證」身份。不能使用 secret／DSN 作身份檔。
4. 使用 Python 3.12+ stdlib：

   `python -B build_packet.py --freeze <fresh-freeze.json> --expected-identity <independent-identity.json> --output <new-absent-directory>`

   所有輸出檔須在使用者授權的本機目錄。目錄須不存在；既有目錄、symlink／junction 祖先、失敗後殘留均拒絕／保留，不覆寫、不自動清理重試。編譯無 DB／網路能力。
5. 交付 `freeze.json` 原 bytes、`hold.sql`、`reverse.sql`、`manifest.json`。manifest 綁全部產物 SHA-256、compiler/export source SHA-256、DB identity、target count、全 inventory count 與操作 UUID。相同 freeze bytes 產生相同 UUID／receipt 名；不同 freeze 得不同 UUID。不是操作授權或簽章。

Freeze 必須包含完整 Outbox 每列：PG 原生 `to_jsonb(row)::text` 的 before/after text、UTF-8 SHA-256、完整非 target inventory digest、catalog 原生 text/hash 和 DB identity。Python 不重建 PG 的 canonical text；它驗證 hash 及 status-only JSON 語意，實際 SQL 再比對原生 text/hash。這會保守拒絕序列化不一致。freeze／SQL／receipt 都含 payload，視為敏感資料，勿入一般 Git、公開 CI artifact 或日誌。compiler 不設定 Windows 檔案 ACL；Owner 必須提供私人目錄。

只有精確 BAG01/02/03/03A/05/06/07/08/09/10 pending 可以 HOLD；round_keys 不可空／重複／未知／混 BAV，payload.rounds 必須逐一對應且 source=ofalive99，nested table_id／BAV 也保守拒絕。全部 processing/error、未知 status、非空 claim_token 拒絕；completed/dead_letter 非 target 全列保護，**不刪除、不改名、不完成、不 reset session/sequence**。

## 交易及反向契約（僅靜態，未執行）

- SQL 設 UTC、pg_catalog search_path、row_security=off、lock_timeout=3s、statement_timeout=30s、idle_in_transaction_session_timeout=60s。先取得 Outbox SHARE ROW EXCLUSIVE（與 DML conflict）鎖，再作 identity/catalog/全列 preimage guards；反向另鎖 receipt。
- catalog fingerprint 包含 relation identity/owner/ACL/RLS、columns、constraints/index definitions、policies 及 public pg_proc。拒絕 Outbox 任一 trigger/rule、partition/inheritance。它不是全資料庫 catalog、跨表依賴或外部 writer 停止證明；fresh catalog 仍需獨立審查。
- `hermes.six_cutover_quiesced=yes` 是操作者的外部聲明，**不是身份認證，也不能證明服務已停止**。SQL 不會自行設定這個聲明。DB 身份由原生 identity readback 精確比較；角色必須是表 owner。
- HOLD 建立全新 receipt 表；先 ENABLE RLS，明確 REVOKE PUBLIC/anon/authenticated/service_role，再檢查 table/column ACL 無非 owner grants、無 policy/trigger/rule/inheritance。若其他 default ACL grant 仍存在即拋錯 rollback，而非默默洩露。owner／superuser 仍有管理權，不能把 RLS 宣稱成抵禦 DB 管理員。
- receipt 保留每 target 完整 before/after text/hash、operation_id、freeze hash、reversed。receipt INSERT 先於唯一 Outbox `SET status='dead_letter'`；全 inventory exact afterimage/hash/count 再核對。非 target 同樣全列比對，不只 count。
- reversal 要求同一操作 receipt 全部欄位、exact postimage 與全 inventory，且無 pending/processing/error；只恢復 status=pending，保留 receipt 並標 reversed=true。任何缺失／drift／active work 均 BLOCK。Consumer 仍須保持停止。
- **只有 HOLD 限制 export 後 15 分鐘內**，以真 DB clock 再檢查；compiler 也只能從 fresh freeze 建包。預先產生的 reversal 不以原 freeze 年齡拒絕：原始 freeze 是不可改寫的歷史前像，必須保留原 bytes/hash。反向執行前仍須當次 fresh、獨立的停寫／in-flight 終止與唯讀對帳證據，以及另行操作授權和 quiescence 聲明；同一交易鎖下的 DB identity、全 catalog、全部 inventory exact postimage/hash、非 target 全列、receipt proof、無 active work guards 完全不變。任一無法匹配仍 HOLD，不放寬或以更新 freeze 覆蓋歷史。
- 所有產物最後只有 `ROLLBACK;`，沒有 commit switch／runner。因此目前 HOLD rehearsal 結束後 receipt 不存在，單獨 reversal 會拒絕；不能聲稱測過兩段串接。未來正式要使用 COMMIT 必須另授權精確 SQL successor，不屬本包。
- 已持久化同名 receipt／已反向的重複操作會拒絕；**純 ROLLBACK 不留下 durable spend marker，因此不可能靠本包阻止另一場相同 rehearsal**。不要把 deterministic UUID 或 exclusive output directory 當成資料庫全域一次性授權。
- connection loss／unknown completion 僅允許另授權的唯讀對帳：同一 identity、receipt、全部 before/after/non-target/catalog；不得自動重送或自行判定 rollback。這個 compiler 沒有重連、重送或對帳 runner。

## 離線測試與證據邊界

測試資料明標 SYNTHETIC_NOT_A_REAL_DB／SYNTHETIC_NOT_PG_NATIVE，不是 fresh export 或正式資料。`test_build_packet.py` 裝 import fence 與 audit hook，拒絕 DB driver/network/process 路徑，並驗 compiler 的 imports。測試必須提供 `SIX_RAW_TEST_ROOT` 指向已授權 evidence 目錄；暫存輸出只在其中，離開測試即清理。

在清除 credentials 的子程序環境執行兩個 canonical gate（PATH/SystemRoot/WINDIR/TEMP/TMP/LOCALAPPDATA 白名單；另設 PYTHONDONTWRITEBYTECODE=1、PYTEST_DISABLE_PLUGIN_AUTOLOAD=1、SIX_RAW_TEST_ROOT）：

```
python -B -m unittest -v test_build_packet.py
python -B -m pytest -q -p no:cacheprovider -p no:junitxml test_build_packet.py
```

測試涵蓋 contract RED→GREEN、完整 compiler/CLI 輸出與 hash readback、覆寫拒絕、scope/UUID/hash/preimage/時間/空 targets/active work/混桌拒絕、SQL injection hex encoding、鎖與 guard 順序、receipt privacy、status-only/reversal/static SQL contract。兩個 runner 是同一批測試，不相加計數。離線測試不構成 PG parse/compile／role ACL／並行 DML／SQL effect／部署驗收；獨立 reviewer 尚須審查 exact source。

### 額外隔離真 PostgreSQL 回歸（需獨立明示授權）

`real_pg_regression.py` 僅建立新的 loopback 合成庫，不接受 DSN／正式憑證；不重啟或覆寫既有 cluster。先清除生產環境變數，使用有 psycopg 的 Python 3.11+ 執行，compiler interpreter 須 Python 3.12+。以下各路徑及空埠須替換成已核准的本機值；evidence root 必須不存在：

```text
<driver-python> -B real_pg_regression.py --synthetic-disposable-only --evidence-root <new-absolute-root> --pg-bin <approved-pg-bin> --compiler-python <python312> --driver-path <psycopg-site-packages> --psutil-path <psutil-site-packages> --port <vacant-loopback-port> --expected-head <exact-head> --git <git-exe>
```

runner 複製並綁定當次工作樹五個工具的原始 bytes；fixture 表 DDL 則取固定雜湊的 immutable migration Git blob，不把 checkout CRLF 當作不同 schema。建立 DB 前比對實際管理連線與本機 control identity。正向 HOLD 失敗即停止相依矩陣；成功後驗預設 rollback、全列/non-target、ACL/RLS/default grants、漂移、重複、雙連線 Lock/55P03、歷史 reversal 與完整回復。COMMIT 僅在合成庫以末尾 `ROLLBACK;` 的精確替換執行，產品 CLI 無 COMMIT 選項。保留結果、來源／SQL hashes、原錯誤及正常 pg_ctl stop／子程序退出／control／PID／port 讀回；任何失敗均非零退出。這只證明合成 fixture，不是完整正式 schema、外部停寫證明或部署授權。
