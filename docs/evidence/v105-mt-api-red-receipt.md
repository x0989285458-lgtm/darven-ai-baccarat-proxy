# v105 MT API RED receipts

基線：`b1cd90d2bdb0cc1bea38f63066002eef62136bcd`

本檔只記錄無敏感值的 TDD RED 命令與預期錯因；不含 Token、Session、Cookie 或正式環境識別資料。

## Systematic Debugging Phase 1 / Record evidence

- 唯讀來源：`C:/tmp/mt-pure-api-observer.mjs`、`C:/tmp/api-observer-vm-session-short.json`、`C:/tmp/mt-browser-protocol-result.json`、`C:/tmp/mt-protocol-sanitized.json`、`C:/tmp/mt-browser-protocol-probe.mjs`。
- Artifact receipt：Game 與 Chat authenticate 各成功一次；單一 join；90 秒內 10 桌 Tables 完整 9 次、22 個合法 summary；Record 送出 22 次、在截止前收到 21 次，`nonempty=0`、`valid=0`、無 observer error。
- 已觀察 action：`GET /api/v1/gametype/*/game/*/record`；probe payload 把 `summary.room_id` 放入 `table_id`，另帶 `shoe`、`round`。這不是已驗證的正式 contract。
- Bundle probe：目前 Artifact 只到 `ACCESS RESTRICTED` 頁，沒有可用 MT bundle 或 Record 呼叫鏈；因此 endpoint 以外的 payload 與前置狀態維持 `unverified`。
- 結論：不得宣稱 Record 已可補局；程式採 fail-closed 可插拔 provider，第二獨立 Session Journal 保留 `second_independent_session_token_required` Live Gate，禁止同 Token 熱備。

## RED-01 Source owner / lease / fence

- 命令：`cd cloud-browser-worker && node --test test/worker-source-owner.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，尚無 `src/worker-source-owner.js`，因此 API 唯一 owner、Browser 冷接管、epoch/fence 防舊 owner 行為尚不存在。

## RED-02 Durable atomic lease store

- 命令：`cd cloud-browser-worker && node --test test/worker-source-owner.test.js`
- Exit：`1`
- 預期錯因：`createFileLeaseStore` 尚未匯出，Lease 還不能跨程序原子競爭或由新 reader 恢復。

## RED-03 MT API dual-channel owner

- 命令：`cd cloud-browser-worker && node --test test/mt-api-client.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，尚無 Game+Chat auth、精確十桌 join、Final gate 或 reconnect owner。

## RED-04 Append-only Final journal

- 命令：`cd cloud-browser-worker && node --test test/final-journal.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，尚無本機 Final journal、identity/hash 衝突封鎖、ACK cursor 或 restart replay。

## RED-05 Record parser / gap / replay gate

- 命令：`cd cloud-browser-worker && node --test test/gap-replay-record.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，尚無離線 Record parser、同靴/跨靴 gap detector、可插拔 replay provider 與第二獨立 Token gate。

## RED-06 Fenced durable delivery

- 命令：`cd cloud-browser-worker && node --test test/source-fenced-delivery.test.js`
- Exit：`1`
- 預期錯因：Pusher 尚未把 source mode/owner/epoch/fence 綁入 envelope，也沒有 exact fenced ACK callback，因此 tick fail-closed 為 `false`。

## RED-07 Proxy ingest source fence

- 命令：`cd proxy && node --test test/ingest-source-fence.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，Proxy 尚無 epoch/fence high-water 與 event source 一致性驗證。

## RED-08 Proxy fenced ingest integration

- 命令：`cd proxy && node --test test/ingest-source-fence.test.js`
- Exit：`1`
- 預期錯因：current epoch 請求的 ACK 沒有 exact source，證明 server 尚未接入 source fence；測試已先排除缺少 `node_modules` 的非語意錯誤。

## RED-09 Persisted portal session manager

- 命令：`cd cloud-browser-worker && node --test test/portal-session-manager.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，API 尚不能由 VM 既有 persisted session 取用一次性值或經既有 refresh owner 更新。

## RED-10 Durable event sequence allocator

- 命令：`cd cloud-browser-worker && node --test test/worker-source-owner.test.js`
- Exit：`1`
- 預期錯因：`nextEventSource is not a function`，事件 sequence 尚未與 Lease store 原子綁定或跨 owner recreation 恢復。

## RED-11 API-primary source runtime

- 命令：`cd cloud-browser-worker && node --test test/worker-source-runtime.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，尚無把 API owner、Final journal、gap/replay 與既有 durable delivery 接成單一 runtime 的垂直路徑。

## RED-12 Refresh handoff ordering

- 命令：`cd cloud-browser-worker && node --test test/mt-api-client.test.js`
- Exit：`1`
- 預期錯因：auth expiry 尚未先關閉 Game+Chat API sockets；refresh 前置斷言中止，未建立新 generation（預期 4 sockets，實際 2）。

## RED-13 Worker server API-owner wiring

- 命令：`cd cloud-browser-worker && node --test test/server-api-owner-wiring.test.js`
- Exit：`1`
- 預期錯因：server 仍直接呼叫 Browser `getSnapshot`，尚未預設 API owner、接入 persisted session/journal runtime 或把 durable ACK 回寫 journal。

## RED-14 Expired lease restart fencing

- 命令：`cd cloud-browser-worker && node --test test/worker-source-owner.test.js`
- Exit：`1`
- 預期錯因：`acquireOrRecover is not a function`，API process restart 尚不能只在 Lease 過期後以新 epoch/fence 恢復並封鎖 dead owner。

## RED-15 Lease renewal lifecycle

- 命令：`cd cloud-browser-worker && node --test test/worker-source-runtime.test.js`
- Exit：`1`
- 預期錯因：runtime 仍呼叫單次 `acquire`，沒有 recovery/renewal lifecycle；測試 stub 僅提供 `acquireOrRecover` 因而精準失敗。

## RED-16 Durable cursor monotonicity

- 命令：`cd cloud-browser-worker && node --test test/final-journal.test.js`
- Exit：`1`
- 預期錯因：較舊鞋號的延遲 ACK 把 cursor 從 `92:1` 倒退成 `91:70`，會製造假跨靴 gap。

## RED-17 Independent backup journal replay

- 命令：`cd cloud-browser-worker && node --test test/gap-replay-record.test.js`
- Exit：`1`
- 預期錯因：`ERR_MODULE_NOT_FOUND`，第二獨立 Session 的 append-only journal 尚無離線 authoritative replay reader 或 primary-owner 排除 Gate。

## RED-18 Backup gap completeness

- 命令：`cd cloud-browser-worker && node --test test/gap-replay-record.test.js`
- Exit：`1`
- 預期錯因：要求 `[8,9,10,11]` 時 provider 只回 `[8,9,10]` 卻未拒絕，違反補完前不得恢復 Live ACK。

## RED-19 Backup provider server wiring

- 命令：`cd cloud-browser-worker && node --test test/server-api-owner-wiring.test.js`
- Exit：`1`
- 預期錯因：server 尚未載入 `createBackupJournalReplayProvider` 或讀取 `MT_BACKUP_FINAL_JOURNAL_PATH`，Live Gate 後仍無可接線的獨立 Journal reader。

## RED-20 DB durable capture source fence

- 命令：`cd proxy && node --test test/v105-durable-source-fence.test.js`
- Exit：`1`
- 結果：初跑 `tests 6 / pass 1 / fail 5`；補入明示 Env Gate 後重跑為 `tests 7 / pass 1 / fail 6`。
- 預期錯因一：新的 additive migration 尚不存在，因此沒有 `public.v105_capture_source_fence`、`SECURITY DEFINER`／固定 `search_path` 的 `public.persist_v105_fenced_capture_envelope(p_capture jsonb)`、交易 advisory/row lock、嚴格 source 驗證、同交易 high-water advance→既有 envelope persistence、失敗 rollback，以及 service_role-only ACL contract。
- 預期錯因二：帶 source 的 writer 實際仍呼叫 `/rest/v1/rpc/persist_v105_capture_envelope`，尚未只走 fenced RPC；fenced RPC 失敗時「不得 fallback」contract 同步失敗。無 source 的 legacy compatibility 測試維持 PASS。
- 預期錯因三：共享 durable fake 已保留 epoch 5 後，以 fresh app 模擬跨 process／Render restart，舊 epoch 4 確實到達 DB fake 並被拒絕，但 HTTP 實際回 `503` 而非預期 `409`；證明 DB fence 錯誤尚未正規化，也尚未完成不得 ACK／不得寫 local state 的 HTTP contract。
- 預期錯因四：`REQUIRE_FENCED_INGEST=true` 在非 production app 實際仍接受無 source envelope（`200`，預期 `409 source_fence_invalid`），Env finalize Gate 尚未接線。
- 預期錯因五：DB-first → proxy compatible → new API worker → durable source readback → `REQUIRE_FENCED_INGEST=true` finalize，及 Browser 冷備必帶 `source.mode=browser` 的正式切換 Manifest 尚不存在。

## RED-21 Proxy-compatible fenced routing before finalize

- 命令：`cd proxy && node --test --test-name-pattern="proxy-compatible phase" test/v105-durable-source-fence.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：`REQUIRE_FENCED_INGEST=false` 時，新 API Worker envelope 已帶合法 source，但 server 傳給 durable writer 的 `source` 實際為 `undefined`；證明 proxy-compatible 階段會錯走 unfenced legacy RPC。正確 contract 是「source 存在即 fenced persistence」，flag 只控制無 source 是否在 HTTP 層拒絕。

## RED-22 Fenced Direct DB writer path

- 命令：`cd proxy && node --test --test-name-pattern="preferred Direct DB path" test/v105-durable-source-fence.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：在已配置 Direct DB pool 時，新 fenced RPC 尚未列入 Direct DB dispatch，writer 錯誤落到 REST；測試以「Direct DB persistence must not use REST」精準失敗。正式 writer 應只送一次 `select public.persist_v105_fenced_capture_envelope($1::jsonb)`。

## RED-23 SQL NULL-safe strict source validation

- 命令：`cd proxy && node --test --test-name-pattern="additive migration defines" test/v105-durable-source-fence.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：四個 source field 型別檢查使用一般 `<>` 且與 object/key 檢查混在同一 `OR`，缺 key 時可能落入 SQL `NULL` 三值邏輯，測試實際取得 `IS DISTINCT FROM` 安全檢查 `0` 組、預期 `4` 組。應先獨立拒絕非 object，再以 NULL-safe 型別比較嚴格拒絕缺 key／多 key。

## RED-24 HTTP strict envelope source shape

- 命令：`cd proxy && node --test --test-name-pattern="HTTP source precheck" test/v105-durable-source-fence.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：空白 `ownerId` 與 envelope source 額外 key 在 DB 前置檢查仍得到 `200`（預期 `409 source_fence_invalid`）。envelope/snapshot source 必須精確只有 mode/ownerId/epoch/fence；event source 仍另允許必要的 sequence。

## RED-25 P1-1 Durable post-commit response reordering

- 命令：`cd proxy && node --test --test-name-pattern="cross-session responses" test/v105-durable-source-fence.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：兩個不同 session 的 durable persistence 都已成功，但 epoch 2 response 先完成並推進本機 cache 後，延遲返回的 epoch 1 又呼叫 `validateAndAdvance`，實際被改判 `409`（預期兩者皆 exact `200 ACK`）。Durable DB 必須是權威；post-commit cache observe 不得反轉已提交結果。

## RED-26 P1-2 Cross-shoe replay coverage

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="cross-shoe replay rejects" test/gap-replay-record.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：cursor `91/70`、live `92/3` 時，backup journal 只有 `92/2` 一筆 pending，provider 實際成功返回而未拒絕（`Missing expected rejection`）。任一 pending 不得冒充未知舊靴尾與新靴 `1..live-1` 的完整 coverage。

## RED-27 P1-3 Restart old-fence pending rebind

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="restart rebinds old-fence" test/worker-source-runtime.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：restart 取得 epoch 2 lease 後實際順序為 `lease → api`，缺少 `rebind`；epoch 1 pending Final 因而仍可能以 epoch 2 envelope 送出。新 owner 必須在新 Fence 後、開 socket 前逐筆配置新 sequence 並追加 rebind record。

## RED-28 P1-4 Orphan file lock with reused PID

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="recovers an orphan lock" test/worker-source-owner.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：lock metadata 的 PID 42 已被容器重用（start identity 由 old 變 new），但現行 store 不讀 owner identity，實際直到 `source_owner_lock_timeout`。只有可證明 owner 不存在或 identity 不匹配時才可清 orphan；其他狀態必須 fail-closed。

## RED-29 P1-5 Rollback manifest order and readback

- 命令：`cd proxy && node --test --test-name-pattern="non-destructive rollback order" test/v105-durable-source-fence.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：release manifest 尚無 `rollback` contract，測試讀取 `rollback.target` 即失敗。未固定 exact target、六步回退順序、readback/abort gates、Queue/Cursor/Journal 保存與 Cursor/Final 不倒退條件。

## RED-30 P1-6 Second-session boolean bypass

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="boolean cannot bypass" test/gap-replay-record.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：即使實際 token verifier 回報失敗，舊 `secondTokenAvailable=true` 仍讓 backup replay 實際回 `ok:true`。Live Gate 必須改由兩個實際 token 的 SHA-256 fingerprint 與 journal header/owner readback 決定，布林不得具有權威。

## RED-31 P1-7 Auth refresh close/reconnect race

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="real close events stay suppressed" test/mt-api-client.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：fake socket 的 `close()` 真正 emit `close` 後，refresh promise 尚未 release，socket 數已由 2 變 4（預期仍為 2）。close callback 在 refresh 前排了 reconnect，可能建立 stale-token generation。

## RED-32 SELF_CHECK P1-2 coverage commit ordering

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="coverage is not remembered" test/worker-source-runtime.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：第一筆 replay journal append 失敗後，第二次 delivery 實際未重呼 provider（`replayCalls=1`，預期 2），證明 coverage 在全部 append 成功前已被誤記。

## RED-33 SELF_CHECK P1-4 lock-construction cleanup

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="identity creation fails" test/worker-source-owner.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：新 lock 已以 `wx` 建立後，注入的 process identity provider 失敗；實際 `.lock` 仍存在，`access()` 未得到 ENOENT。建鎖全段失敗必須清理自身 lock。

## RED-34 Fresh round 2 P1-3 summary-before-join

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="summary and show_win stay blocked" test/mt-api-client.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：Game auth 後與雙 auth 但 join 只有送出、尚未收到兩邊 ACK 時，兩筆 Final 都被接受（實際 `2`，預期 `0`）；證明 current generation 沒有 exact join completion gate。

## RED-35 Fresh round 2 P1-1 API health truth

- 命令一：`cd cloud-browser-worker && node --test --test-name-pattern="health snapshot reports real" test/mt-api-client.test.js`
- 命令二：`cd cloud-browser-worker && node --test --test-name-pattern="runtime delivery health is derived" test/worker-source-runtime.test.js`
- Exit：兩者皆 `1`。
- 預期錯因：client 在 socket 尚未 open 時回 `connected:true`，且缺 `authenticated/lastMessageAt`；runtime 在 API 明示斷線時仍固定回 `connected:true/authenticated:true`。這是 health 臆造，不是 fixture 問題。

## RED-36 Fresh round 2 P1-2/P1-4 backup journal producer wiring

- 命令一：`cd cloud-browser-worker && node --test test/backup-journal-runtime.test.js`
- 命令二：`cd cloud-browser-worker && node --test --test-name-pattern="backup-journal role separate" test/server-api-owner-wiring.test.js`
- Exit：兩者皆 `1`。
- 預期錯因：正式 `backup-journal-runtime.js` 不存在；server 沒有 `MT_CAPTURE_ROLE=backup-journal`、也無只讀 producer 與 canonical pusher/Lease/Browser 分離接線。缺第二 token 時無可執行的 fail-closed runtime，`writeHeader/closeShoe` 仍只有測試手工 caller。

## RED-37 Fresh round 2 P1-5 persistent push queue restart rebind

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="epoch2 restart atomically rebinds" test/source-fenced-delivery.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：epoch 1 queue 落盤後以 epoch 2 runtime restart，第二次 `tick()` 實際為 `false`；fetch 前讀回的 queue 仍是 epoch 1，回 epoch 2 ACK 也無法匹配。現行只 rebind Final journal，沒有在送出前原子重寫 Queue/journal/checkpoint 與每局 event source。

## RED-38 Fresh round 2 P1-6 browser cold fallback renewal

- 命令：`cd cloud-browser-worker && node --test test/browser-source-runtime.test.js`
- Exit：`1`；`ERR_MODULE_NOT_FOUND`。
- 預期錯因：Browser cold takeover 只有 server 內單次 `takeover`，沒有正式 renewal lifecycle，也沒有可驗證的 stop ordering；15 秒後 Fence 會過期而 `nextEventSource` fail closed。

## RED-39 Fresh round 2 P1-7 exact release binding

- 命令：`cd proxy && node --test test/v105-mt-api-release-binding.test.js`
- Exit：`1`；`ERR_MODULE_NOT_FOUND`。
- 預期錯因：沒有可執行的 release binding verifier；manifest 未凍結明確排除自參照檔的 implementation path set、migration SHA-256、Proxy/Worker build input digest，也無外部 immutable commit/tag attestation 與 image digest readback mismatch abort contract。

## RED-40 SELF_CHECK P1-1 exact unique ten-table readiness

- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="runtime delivery health is derived" test/worker-source-runtime.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：十筆重複 `BAG01` 被算成 `tableCount=10`（預期 `1`），可冒充 exact ten-table readiness。正式 runtime 必須依 canonical table identity 去重，不能只算 array length。

## Fresh round 2 GREEN receipts

- P1-1/P1-3：`node --test test/mt-api-client.test.js` → `8/8 PASS`；`runtime delivery health is derived` → `PASS`，含 duplicate table identity 負例。
- P1-2/P1-4：`node --test test/backup-journal-runtime.test.js` → `2/2 PASS`；缺 token 在 client/socket 建立前拒絕，真 token header/final/continuous shoe marker 由 runtime caller 產生。
- P1-5：`node --test test/source-fenced-delivery.test.js` → `2/2 PASS`；epoch 2 fetch 前已從磁碟讀回新 queue source/event sequence/checkpoint。
- P1-6：`node --test test/browser-source-runtime.test.js` → `2/2 PASS`；20 秒續租後仍可 next event，stop order 為 renew → socket → lease。
- P1-7：`node --test test/v105-mt-api-release-binding.test.js` → `3/3 PASS`；self-reference exclusion、source mutation、image digest mismatch abort 均為 executable contract。
- 上輪 P1 精確 focused：9 個既有反例全部 PASS（postcommit ACK 亂序、cross-shoe、old journal rebind/coverage commit ordering、orphan lock/cleanup、rollback、actual token fingerprint、refresh race）。
- Worker full：`node --test --test-reporter=dot` → exit `0`，`155/155 PASS`。
- Proxy full：`node --test --test-reporter=dot` → exit `0`，`947/947 PASS`。
- Frontend：`npm run build` → exit `0`，TypeScript + Vite build PASS。
- Final dirty checks：35 changed files；30 JS/MJS `node --check` PASS；trailing whitespace `0`；strong secret hits `0`；forbidden UI/V6-V9/weight/threshold paths `0`；release binding digest readback `true`。
- 正式狀態：未 commit/tag/push/deploy，未碰正式 DB/VM/網路；外部 immutable attestation、image digest readback、第二獨立 MT 帳號 token 與 Live E2E 均未執行，正式 verdict 維持 BLOCK。

## RED-41 Fresh final Tree P0 live cursor continuity before append

- Reviewer 反例：durable cursor `BAG01/91/7` 直接收到 summary Final `BAG01/91/9`；另以 cursor `91/8` 收到未知跨靴 `92/1`。兩者都必須在 journal append、delivery、ACK 與 cursor advance 前 fail-closed；同 cursor 已 ACK duplicate 與 `cursor+1` 維持可接受。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P0" test/worker-source-runtime.test.js`
- Exit：`1`；`tests 2 / pass 0 / fail 2`。
- 預期錯因：兩個反例皆為 `Missing expected rejection`；現行 `worker-source-runtime.onFinal()` 直接 `journal.append(event)`，沒有逐筆以 durable cursor 檢查 live Final 連續性。

## RED-42 Fresh final Tree P1 Join/Tables race

- Reviewer 反例：current generation 在 Game+Chat 雙 join ACK 前先收到一份完整且唯一的 10 桌 Tables；第二個 join ACK 後必須精確交付一次。reconnect generation 必須清掉舊 cache，只交付新 generation 的最新 10 桌。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P1 Join/Tables" test/mt-api-client.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：第二個 join ACK 後 `delivered.length` 仍為 `0`（預期 `1`）；現行 client 在 join 未完成時直接丟棄早到 Tables，沒有 generation-local cache 或 join 後 re-request。

## RED-43 Fresh final Tree P1 durable ACK crash atomicity

- Reviewer 反例一：Proxy exact ACK 後、journal ACK 前 crash；restart 必須先用 queue 內完整 receipt 完成 journal ACK 與 queue removal，禁止 source read/rebind/re-push。
- Reviewer 反例二：journal ACK 後、queue delete 前 crash；restart 必須 idempotent 收斂，Final journal 只留一筆 ACK，且 `stateInvalid=false`。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P1 ACK crash" test/source-fenced-delivery.test.js`
- Exit：`1`；`tests 2 / pass 0 / fail 2`。
- 預期錯因：兩個反例的第一輪 `tick()` 都回 `true`（預期 crash 後 `false`）；現行 pusher 不接受 crash injection，也未在 journal callback 前 checkpoint `remote_ack_pending` receipt。

## RED-44 Fresh final Tree P1 MT summary-only Final parser

- Reviewer 反例：雙 join 完成後依序送 exact10 `show_poker`、exact10 `show_win`、exact10 `summary`；MT 正式 parser 只能產生一筆 summary Final。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P1 summary-only" test/mt-api-client.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：實際產生 `2` 筆 Final（預期 `1`）；`finalActionName()` 仍把 `/show_win` 分類成 Final。此反例只約束 MT API parser，不改共享 DB 歷史來源判讀。

## RED-45 Fresh final Tree P1 production runtime scope enforcement

- Reviewer 反例：runtime-config 與真 `server.js` 啟動路徑分別注入 browser source、backup-journal role、殘留 backup journal path、殘留 backup token path；全部必須在 listen/source 建立前拒絕。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P1 runtime scope|Reviewer P1 server wiring" test/runtime-config.test.js test/server-api-owner-wiring.test.js`
- Exit：`1`；`tests 2 / pass 0 / fail 2`。
- 預期錯因：runtime-config 因缺少 `validateReleaseRuntimeScope` export 直接 RED；真 server 則走到本機 `listen(-1)` 才因 `ERR_SOCKET_BAD_PORT` 退出，沒有先拒絕越界 runtime env。

## RED-46 Fresh final Tree P1 Rollback Gate

- Reviewer 反例：rollback 必須依序 drain unfinished work、checkpoint Queue/Cursor/Journal、readback 四項 count 全零與保存狀態，之後才可 rollback proxy/worker；pending/processing/error/dead-letter 任一為 `1` 都要 executable abort。
- 命令：`cd proxy && node --test --test-name-pattern="Reviewer P1 Rollback Gate" test/v105-durable-source-fence.test.js`
- Exit：`1`；test file import RED。
- 預期錯因：release verifier 尚未 export `verifyRollbackReadiness`，manifest 也仍設定 `requireAllUnfinishedCountsZero=false`，沒有可執行的四 count fail-closed Gate。

## RED-47 Fresh final Tree P1 attestation exact tag/index-tree binding

- Reviewer 反例：四 Digest 與 image digest 全相同時，舊 tag `v105-mt-api-primary.0` 仍須拒絕；attestation tree 不是本次 `git write-tree` 的 candidate index tree 也須拒絕；正確動態 tree 與 manifest tag 才可通過單元 Gate。
- 命令：`cd proxy && node --test --test-name-pattern="Reviewer P1 attestation exact binding" test/v105-mt-api-release-binding.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：old tag case 為 `Missing expected exception`；現行 verifier 只要求 tag 非空，且沒有把 attestation tree 綁到 current index `write-tree` 結果。

## RED-48 SELF_CHECK P0 unknown older Final is not an idempotent duplicate

- Reviewer 反例：durable cursor 為 `BAG01/91/7`，但 journal ACK history 完全沒有 `BAG01/91/6`；收到 round 6 不能因 `round<=cursor` 被當成 duplicate，必須在 append 前阻擋。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="older same-shoe Final" test/worker-source-runtime.test.js`
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 預期錯因：`Missing expected rejection`；第一版 continuity Gate 對所有同靴 `round<=cursor+1` 放行，沒有讀回 exact durable ACK identity。

## Fresh final Tree SELF_CHECK GREEN receipts

- P0/P1 focused Worker：`node --test --test-reporter=dot test/worker-source-runtime.test.js test/final-journal.test.js test/mt-api-client.test.js test/source-fenced-delivery.test.js test/runtime-config.test.js test/server-api-owner-wiring.test.js` → exit `0`，`36/36 PASS`。
- P1 focused Proxy/release：`node --test --test-reporter=dot test/v105-durable-source-fence.test.js test/v105-mt-api-release-binding.test.js` → exit `0`，`20/20 PASS`。
- Worker full：`node --test --test-reporter=tap` → exit `0`，`162/162 PASS`，fail `0`。
- Proxy full：`node --test --test-reporter=tap` → exit `0`，`948/948 PASS`，fail `0`。
- Frontend：`npm run build` → exit `0`，TypeScript 與 Vite build PASS；application version `1.0.26`。
- Static：35 個候選 JS/MJS `node --check` PASS；`git diff --check HEAD` PASS；strong secret hits `0`；本輪 unstaged UI/V6-V9/strategy/weight/threshold path hits `0`。
- Release binding readback：implementation `68ea50407aeead765f0b5f1890997758e279395b8f315a034de1384eb5b1dd76`；migration `aa4730458d093c08275eaa4c0d3e9b87b2088de3da9b302890615edf0b7dbc89`；proxy `dbe4fc2fcdf959a80bbd0b48f693619501f1de4900b56b394e0435ac70b18239`；worker `9a3d734204d691a87f20055f9a2482e59f101bfe62471f11c9bd3e5b5c0afd9f`；verifier `ok:true`。
- 版本與 scope：三套 package 與 manifest 都維持 `1.0.26`；manifest tag 維持 `v105-mt-api-primary.1`；Browser/backup runtime 於 server startup fail-closed，future/rollback 模組只留 artifact。
- 限制：未 commit/tag/push/deploy，未碰正式 DB/VM/網路。Live E2E、外部 immutable attestation、image digest readback 與獨立 Reviewer 皆未執行；不得宣告 Live，正式 verdict 維持 `BLOCK`。

## RED-49 Reviewer P0 empty Journal baseline and exact-ACK bootstrap

- Candidate index tree：`db47143754f30164f5a36316c04dfa158594d7f5`。
- 反例矩陣：empty→BAG01/91/9 必須在 append/push/ACK/cursor 前 blocked；empty→round 1 可接受；snapshot-pusher exact ACK bootstrap 7 必須持久化後只允許 8、阻擋 9；bootstrap 不得偽造 Final/ACK；restart 必須保留 cursor；observed-only 與 malformed identity 必須拒絕。
- 命令：`cd cloud-browser-worker && node --test test/worker-source-runtime.test.js`。
- Exit：`1`；`tests 13 / pass 10 / fail 3`。
- 精確錯因：empty→9 為 `Missing expected rejection`；兩個 bootstrap cases 均為 `journal.bootstrapFromSnapshotPusherCursor is not a function`。合法 empty→1 已 PASS，證明測試未封死新鞋起點。

## RED-50 Reviewer P1 Join ACK socket binding

- 反例：Game socket 依序送 Game join ACK 與 Chat join ACK，之後再送 summary；`joined` 必須維持 false 且 Final count 必須為 0。真 Game+Chat 各自 ACK 才可 joined=true。
- 命令：`cd cloud-browser-worker && node --test test/mt-api-client.test.js`。
- Exit：`1`；`tests 11 / pass 10 / fail 1`。
- 精確錯因：錯 socket 的 Chat ACK 被接受，實際 `joined=true`（預期 false）；真雙 socket ACK case 已 PASS。

## RED-51 Reviewer P1 canonical attestation path and Git index-tree digest

- Path 反例：Windows drive-letter case alias 與 realpath 後指回 repo 的 junction target 都必須拒絕；不存在／realpath 失敗必須 fail-closed。
- Digest 反例：staged tree A、working file B 時，Digest 必須仍等於 tree A 且 clean Gate 拒絕；index 改成 B 後，舊 candidate tree A 也必須拒絕。
- 命令：`cd proxy && node --test test/v105-mt-api-release-binding.test.js`。
- Exit：`1`；`tests 6 / pass 4 / fail 2`。
- 精確錯因：`assertExternalAttestationPath`、`computeGitTreePathSetDigest`、`assertCandidateIndexClean` 均不存在；既有 scope、manifest digest 與 tag/tree binding tests 仍 PASS。

## RED-49..51 semantic review

- RED 逐一映射現有正式邊界：`worker-source-runtime.onFinal/detectLiveFinalGap`、`final-journal.cursor`、`mt-api-client.handleMessage`、release verifier 的 path/digest/main Gate。
- 失敗不是錯字、import crash 或無效 ACK；合法 round 1、真雙 socket ACK 與既有 manifest/tag binding 同輪仍通過。
- GREEN 不得削弱：summary-only exact-ten Final、exact durable ACK、append-only journal、source fence、雙 socket authentication、manifest excludedPaths、`1.0.26`／`v105-mt-api-primary.1`／single-session scope。

## RED-52 Reviewer P0 bootstrap exact-ACK duplicate no-op

- 反例：journal 只有 `cursor_bootstrap BAG01:91:7`、沒有偽造 Final/ACK 時，再收到同 identity Final 7 必須視為 exact-ACK duplicate，不可 append 或重新 push；之後 Final 8 仍可接受。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="exact-ACK bootstrap 7" test/worker-source-runtime.test.js`。
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 精確錯因：`journal.pending()` 實際新增 `BAG01:91:7`（預期空陣列），證明 bootstrap duplicate 仍被重新 journal/push。

## RED-53 Reviewer P1 untracked working drift

- 反例：index 與 candidate tree B 完全一致後，在受建置範圍新增未追蹤 `src/untracked.js`；clean Gate 仍必須拒絕，避免 Docker/build context 使用未被 tree Digest 綁定的 bytes。
- 命令：`cd proxy && node --test --test-name-pattern="Git tree digest" test/v105-mt-api-release-binding.test.js`。
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 精確錯因：`Missing expected exception`；`git diff --quiet` 不會列出 untracked file，現行 helper 錯誤允許。

## Reviewer P0/P1 final candidate SELF_CHECK receipts

- TDD：RED-49..53 均先以缺少目標行為失敗，receipt 已於 GREEN 前追加；最終 focused 反例全數 GREEN。
- Worker full：`cd cloud-browser-worker && npm test` → exit `0`，`168/168 PASS`。
- Proxy full：`cd proxy && npm test` → exit `0`，`950/950 PASS`。
- Frontend full：`cd frontend && npm test` → exit `0`，`156/156 PASS`；`npm run build` → exit `0`。
- Final candidate pre-receipt tree：`3232ab95d842ed26818dcf21bdcc6906d667f9cc`；`assertCandidateIndexClean=true`。
- Git-tree Digest readback：implementation `6b979d03b8c8c3c9815272ad0f637605ed18457f385e458e3e49481434975981`；migration `aa4730458d093c08275eaa4c0d3e9b87b2088de3da9b302890615edf0b7dbc89`；proxy `dd659b345f7d10d4c0e7d1ae326d0c7e86a105edfe71694463c19b9665dee5b4`；worker `76f3b9de5c3b9fbb509506b9afe0f67ad1031080bc3cad3b9d2e8cb517c44c61`。
- Static：35 個 candidate JS/MJS `node --check` PASS；`git diff --check HEAD` PASS；unstaged tracked `0`；untracked `0`；strong secret hit files `0`；相對 `db47143754f30164f5a36316c04dfa158594d7f5` 的 UI/V6-V9/strategy/weight/threshold path hits `0`。
- Formal CLI negative Gate：未提供外部 attestation 時，先通過 clean/index-tree/digest 後以 `external_attestation_file_required`、exit `1` fail-closed。
- 版本與 scope：`1.0.26`、`v105-mt-api-primary.1`、`single-session-api-primary` 維持不變。
- 限制：只有本機 candidate SELF_CHECK；未 commit/tag/push/deploy，未碰正式 DB/VM/網路。未執行外部 immutable attestation、獨立 Reviewer 或 Live E2E，不得宣告 Live。

## RED-54 Reviewer P0 generation-global WebSocket message serialization

- 反例：同一 Game socket 連續收到 summary round 8／9，記憶體 `nextEventSource` 對 round 8 設 gate；gate 放行前 round 9 不得進入 source allocation，放行後兩筆才依序完成 journal observation 與 delivery。另以 50 筆 burst 固定單次 rejection 必須回報 `onError` 且不得產生 `unhandledRejection`。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P0 message serialization" test/mt-api-client.test.js`。
- 首輪 Exit：`1`；`tests 2 / pass 1 / fail 1`。補強 fail-closed/recovery assertion 後重跑 Exit：`1`；`tests 2 / pass 0 / fail 2`。
- 精確錯因：gate 尚未放行時 `sourceCalls` 實際為 `2`（預期 `1`），證明現行每個 message 各自啟動 `handleMessage`，round 9 可在 round 8 journal/delivery 完成前超車；單次 handler rejection 後 socket 數仍為 `2`（預期 fresh generation 的 `4`），證明只有 `onError`、沒有 fail-closed reconnect。
- 語意與不變量：失敗不是 import、fixture 或 ACK 錯誤；測試已完成雙 socket auth＋各自 join ACK。GREEN 不得削弱 summary-only、exact-ten、source fence、雙 socket join、同 generation 與 runtime fail-closed 契約。

## RED-55 Reviewer P1 per-kind join request correlation

- 反例：以四組獨立純記憶體 client 驗證同 socket pre-auth ACK、錯 socket ACK、該 kind join send 未成功卻收到 ACK 均須 protocol violation＋reconnect；只有 Game/Chat 各自成功 request 後的各自 ACK 才可 `joined=true`。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P1 join request correlation" test/mt-api-client.test.js`。
- Exit：`1`；`tests 1 / pass 0 / fail 1`。
- 精確錯因：第一個 same-socket pre-auth ACK 後 socket 數仍為 `2`（預期 fresh generation 的 `4`），證明舊碼未檢查 `authenticated[kind]` 與 per-kind request correlation 就保存 join ACK。
- 語意與不變量：真實成功路徑仍要求雙 auth、Game/Chat 各一 join request 與各一同 generation ACK；send 未成功不能由 ACK 補造 request state。

## RED-56 Reviewer P1 reconnect creation failure retry

- 反例一：第 1 次 token 建立初始 2 sockets，第 2 次 token 暫敗，第 3 次成功；必須只新增 fresh generation 的 2 sockets（總數 `2→4`）、兩者使用第 3 次 fresh token，並可重新 joined。
- 反例二：純記憶體手動 timer 讓 reconnect token 永久失敗；每輪只能有一個 active timer，delay 必須 `10→20→40→40` capped，health 維持 reconnecting/degraded，stop 後 timer 歸零且 token call 不再增加。
- 命令：`cd cloud-browser-worker && node --test --test-name-pattern="Reviewer P1 reconnect failure retry" test/mt-api-client.test.js`。
- Exit：`1`；`tests 2 / pass 0 / fail 2`。
- 精確錯因：暫敗案例 tokenCalls 實際停在 `2`（預期 `3`）；永久失敗第一次 timer 後 active timer 實際為 `0`（預期 `1`）。現行 catch 只清除 reconnecting 並回報錯誤，沒有重新排程。
- 語意與不變量：重試不得重疊，不得把失敗 generation 發布為 current；stop、refresh 或 generation 替換後舊 timer 必須失效，socket 建立半途失敗不可留下未追蹤 socket。
- Socket 建立補充 RED：撤回未先測的 partial-close 產品碼後執行 `node --test --test-name-pattern="Reviewer P1 reconnect failure retry closes" test/mt-api-client.test.js`，Exit `1`、`tests 1 / fail 1`；第 2 socket 建立暫敗後 tokenCalls 實際停在 `2`（預期 `3`），因 generation 在雙 socket 成功前已前移，舊 retry owner 失效，亦留下第 1 個 half-created socket。

## RED-57 Reviewer P1 rollback producer quiesce

- Pusher 反例：fake fetch 只在 AbortSignal abort 後 reject；要求 `stopAndWait({abortAfterTimeout:0})` 停 timer、abort 並等待 current tick settled，readback `inFlight=0/stopped=true`，之後 tick 不得再 collect pending。
- Shutdown 反例：純記憶體依賴記錄必須是 `api.stop → backup.stop → browser.stop → pusher.drain → pusher.stopAndWait → browser.close`，並由 server 真正 await coordinator。
- Rollback Gate 反例：manifest 必須先 stop intake/renewal、drain pusher、stopAndWait，再 checkpoint/readback zero；即使四個 count 都是 0，只要 `pusherStopped=false/inFlight=1` 仍必須拒絕。
- 命令與 Exit：pusher focused Exit `1`（`inFlight` 實際 `undefined`，預期 `1`；舊 fetch 直到 15 秒 timeout 才收斂）；coordinator focused Exit `1`（function `undefined`）；server wiring focused Exit `1`（未 await coordinator）；proxy Rollback Gate focused Exit `1`（manifest 第一項仍是 `drain-unfinished-work`，且 `stop-api-owner` 位於 proxy rollback 後）。
- 語意與不變量：測試不連 DB/VM/網路，fetch/timer/runtime 均為記憶體 double；abort 後 queue 必須保留，不能把 in-flight 偽裝成 zero，checkpoint/readback 之前不得 disable fence 或切 artifact。

## RED-58 Reviewer P1 independent trusted image evidence

- 核心反例：A trusted build receipts 綁 commit/tree/buildInput/imageRef/imageDigest/builder receiptId；B 只能由注入的 `trustedReadback` 或固定 candidate-tree adapter取得。缺 build receipt、同 provenance、同 receiptId、錯 commit/tree/input/ref/digest、缺欄位全部 fail closed；獨立 fixture 才 PASS。
- Adapter/CLI反例：固定 adapter 必須 `shell:false`、固定 `docker buildx imagetools inspect --raw <validated-ref>` argv、4 MiB raw bound、自算 manifest digest、拒絕 secret-shaped JSON與 shell metachar ref；CLI 必須同時要求 `--attestation` 與獨立 `--build-receipts`，拒絕任意 `--registry-readback` JSON，manifest phase 為 `post-build-pre-cutover`。
- 命令：`cd proxy && node --test --test-name-pattern="Reviewer P1 trusted image evidence|Reviewer P1 fixed trusted registry adapter" test/v105-mt-api-release-binding.test.js`。
- Exit：`1`；`tests 2 / pass 0 / fail 2`；核心函式與 adapter 均為 `undefined`。
- External-only 補充 RED：`node --test --test-name-pattern="Reviewer P1 attestation exact binding" ...` Exit `1`；自報 worker image readback 不同仍由 `verifyExternalReleaseAttestation` 丟 `worker_image_digest_readback_mismatch`，證明 Git attestation verifier 尚錯誤信任同檔 image 欄位。
- 語意與不變量：所有成功期望皆為手寫 literal；adapter fixture不連 registry。External attestation 保留 immutable Git/tag/tree與四 Digest驗證，但不得再批准 image；正式缺檔屬 post-build-pre-cutover phase Gate，不列為 code P1。
- Candidate-tree protection 補充 RED：`node --test --test-name-pattern="Reviewer P1 trusted image evidence" ...` Exit `1`；`verifyTrustedEvidenceContract` 為 `undefined`。反例要求 adapter path 從 implementationTree digest scope 移除或 `arbitraryReadbackJsonRejected=false` 時立即拒絕。

## RED-54..58 GREEN candidate SELF_CHECK

- P0 WebSocket serialization：focused `2/2 PASS`；gate 放行前 round 9 未進 source allocation，放行後 round 8/9依序 journal/delivery；handler rejection 回報、fail-closed reconnect且50筆 burst無 `unhandledRejection`。
- P1 Join correlation：join-focused `8/8 PASS`；pre-auth、wrong-socket、unsent-kind ACK皆拒絕並 reconnect，真 Game/Chat各自 request→ACK 才 joined。
- P1 Reconnect retry：focused `3/3 PASS`；token第2次暫敗、第3次 fresh token成功且 sockets `2→4`；永久失敗單 timer capped `10→20→40→40`；partial socket關閉；stop取消。
- P1 Rollback producer quiesce：pusher `1/1 PASS`、server/coordinator `2/2 PASS`、manifest/verifier `1/1 PASS`；producer stop→drain→async stop/abort/settle→checkpoint/readback zero→disable/rollback順序已固定。
- P1 Trusted image evidence：focused `3/3 PASS`；External只驗Git/四Digest，獨立 build receipts＋固定 registry adapter exact match，same provenance/receiptId與錯 commit/tree/input/ref/digest全拒絕。
- Worker full：`npm test` Exit `0`，`176/176 PASS`。
- Proxy full：並行高負載首輪 `950/952`（兩個既有wall-clock outbox反例）；精確重跑 `2/2 PASS`，Proxy獨立 fresh full Exit `0`，`952/952 PASS`。
- Frontend full：`npm test` Exit `0`，`156/156 PASS`；`npm run build` Exit `0`。
- Git-tree Digest：implementation `7877f5c59a856a8d22e02180c52b7a221febae2a0c1a1ac24bcf12075900f615`；migration `aa4730458d093c08275eaa4c0d3e9b87b2088de3da9b302890615edf0b7dbc89`；proxy `dd659b345f7d10d4c0e7d1ae326d0c7e86a105edfe71694463c19b9665dee5b4`；worker `eb52fd3ea0f44d2416f1ce7fa273407c3454b5fa4e3e6c358333fea3e5133c84`。
- Static：38 個 candidate JS/MJS `node --check` PASS；`git diff --check HEAD` PASS；unstaged `0`、untracked `0`、strong secret hits `0`、相對 `bcbc24fb` 的 UI/V6-V9/strategy/weight/threshold path hits `0`。
- Formal CLI phase Gate：缺 external attestation 時 Exit `1`／`external_attestation_file_required`；只有 attestation、缺獨立 build receipts 時 Exit `1`／`build_receipts_file_required`。未執行 adapter真 registry readback。
- 限制：本輪是本機 candidate `SELF_CHECK`；未 commit/tag/push/deploy，未碰正式 DB/VM/網路，不宣告 Live。正式 post-build-pre-cutover evidence 與獨立 Reviewer仍是發布 Gate，不把缺檔列為 code P1。
