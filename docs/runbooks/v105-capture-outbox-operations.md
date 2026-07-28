# V105 Capture Outbox Operations

本 runbook 只描述候選版操作順序；不得用於未授權部署。

## 發布順序

1. DB-first 套用 `20260729043000_v105_capture_settlement_outbox.sql`。
2. 讀回 table、function signature、ACL 與固定 `search_path`，再確認 PostgREST schema cache 已能呼叫五個 outbox RPC。
3. 啟動新 consumer，確認 `get_v105_capture_outbox_health()` 可觀測 pending、error、processing、dead_letter 與 alert。
4. 僅在 pending=0、error=0、processing=0、dead_letter=0 時通過 release gate。

## 告警與 poison row

- `dead_letter > 0` 或 `alert=true` 必須告警並阻擋發布／回滾。
- 保存 `session_id`、`sequence`、`attempts`、`lease_generation`、隔離時間與已遮蔽錯誤；不得直接刪列。
- poison row 進入 dead_letter 後，同 session 下一 sequence 應可繼續；仍需人工調查與明確重放計畫。

## 回滾 fence

舊 Proxy 回滾前必須再次確認 pending=0、error=0、processing=0、dead_letter=0。任一數量非零時，保留新 consumer，禁止先切回不認得 outbox 的舊 Proxy。

Worker 收到 `persist_v105_capture_envelope` ACK 後，該 Final 已成為 DB durable work。必須保留新 consumer 直到 drain=0，確保已 ACK Final 不遺失；不得以 Proxy process restart 或 memory cache 狀態作為完成證據。

Shutdown 時先停止新的 drain wakeup，等待 in-flight work 完成或 deadline/fail RPC 收斂，再停止 process。回滾後重新讀取 outbox health；只有四種未完成／隔離狀態皆為零才可結案。
