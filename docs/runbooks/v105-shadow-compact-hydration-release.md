# V105 Shadow Compact Hydration DB-first 發布

## 不可跨越邊界

本次只發布 V6/V7/V8/V9 Compact Hydration。禁止修改策略、權重、門檻、UI、MT API；禁止清除 Queue 或 Dead-letter。小溪的工作停在候選，正式 Supabase migration、Render deploy、Env 啟用由 Faker 執行與獨立驗證。

正式操作開始前，以下 7 個 Runtime Env 必須維持停用：

- V103_SHADOW_ENABLED=false
- V104_SHADOW_ENABLED=false
- V104_ITERATION_SHADOW_ENABLED=false
- V105_SHADOW_V6_ENABLED=false
- V105_SHADOW_V7_ENABLED=false
- V105_SHADOW_V8_ENABLED=false
- V105_SHADOW_V9_ENABLED=false

## 0. 凍結候選與前置 Gate

1. 記錄 exact commit、git write-tree、兩個 migration SHA-256、Render 前版 artifact ID，以及 Supabase CLI 版本。後續任何 tree 或 migration hash 改變都使本 Runbook 的 gate receipt 失效。
2. 驗證 Raw/Formal 10 桌健康，並確認上述 7 個 Env 的正式值皆為 false；設定檔或預期值不能代替正式 readback。
3. 固定一位 DB operator。不得平行執行 db push。
4. 使用已釘選且先在拋棄式／staging DB 驗過相同兩個 migration 的 Supabase CLI。CREATE INDEX CONCURRENTLY 不可放進明示交易；第一個 migration 無 BEGIN/COMMIT，第二個 RPC migration 自帶交易。

Supabase 官方流程以 supabase_migrations.schema_migrations 判斷已套版本，並由 db push 跳過已套項目；正式執行前必須先跑：

    supabase --version
    supabase migration list --linked
    supabase db push --dry-run

dry-run 必須只列出以下順序，否則 BLOCK：

1. 20260730010000_v105_shadow_compact_hydration.sql
2. 20260730010100_v105_shadow_compact_hydration_rpcs.sql

## 1. Ledger / Catalog 決策表

只讀查詢：

    select version, name
    from supabase_migrations.schema_migrations
    where version in ('20260730010000', '20260730010100')
    order by version;

    select indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'v105_shadow_v6_issuances_table_issued_idx',
        'v105_shadow_v7_issuances_table_issued_idx',
        'v105_shadow_v8_issuances_table_issued_idx',
        'v105_shadow_v9_issuances_table_issued_idx'
      );

| Ledger | Catalog | 判定 |
|---|---|---|
| 兩版皆無 | index/RPC 皆無 | PASS，可從第一版開始 |
| 只有 20260730010000 | 4 index 全部 valid/ready，RPC 無 | PASS，可由 CLI 繼續第二版 |
| 兩版皆有 | 4 index + 4 RPC 定義/ACL 全符 | 已套完成，禁止重做 |
| RPC ledger 在 index ledger 前 | 任意 | BLOCK |
| ledger 與 catalog 不一致 | 任意 | BLOCK，禁止自行 repair |
| ledger 無但同名 public 物件存在 | 任意 | BLOCK，先獨立調查 drift |

目前隔離 Gate 的正式只讀基線為兩版 ledger 皆無、public 候選 index/RPC 皆無。

## 2. DB-first 套用

保持 7 個 Runtime Env 全為 false。Supabase CLI 2.109.1 會以 pipeline 執行 migration，PostgreSQL 會拒絕 pipeline 內的 `CREATE INDEX CONCURRENTLY`，因此禁止直接對第一版執行 `supabase db push`。

由單一 DB operator 使用後端 transaction-pooler 連線，先驗證第一版 migration SHA-256 精確為 `a9251ab2e6367915923f3188bc6425e91de0783c6ed1c7e436bbda94675a66d4`，再將檔案中的 4 個白名單 `CREATE INDEX CONCURRENTLY` 逐條以獨立 autocommit Query 執行，不得放進 transaction 或 pipeline。四個 index 全部讀回 `indisvalid=true`、`indisready=true` 後，才執行：

    supabase migration repair 20260730010000 --status applied --db-url "$SUPABASE_DB_CONNECTION_STRING" --yes

Repair後再次執行 `supabase db push --dry-run`，必須只剩 `20260730010100_v105_shadow_compact_hydration_rpcs.sql`。第二版只含 4 個 RPC 與 ACL並自帶單一交易，此時才執行一次 `supabase db push --yes`。若任一步失敗，停止，不部署 Render。

Concurrent build 失敗可能留下 invalid index。立即讀回：

    select c.relname, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'v105_shadow_v6_issuances_table_issued_idx',
        'v105_shadow_v7_issuances_table_issued_idx',
        'v105_shadow_v8_issuances_table_issued_idx',
        'v105_shadow_v9_issuances_table_issued_idx'
      )
    order by c.relname;

必須恰有 4 列且全部 indisvalid=true、indisready=true。若有 invalid index，BLOCK；不得因 IF NOT EXISTS 直接重跑。由 DB owner 審核後，只能對精確 invalid 候選 index 使用 transaction 外的 DROP INDEX CONCURRENTLY，再由同一 CLI/ledger 流程重試。

然後讀回兩筆 ledger、4 個函式 signature、SECURITY DEFINER、固定 search_path=pg_catalog, public、ACL。service_role 必須可 EXECUTE；PUBLIC/anon/authenticated 必須不可 EXECUTE。以 service role 驗證四 RPC 各回 10 桌，每桌 60 Final + 最新 1 Pending，共 610；NULL/0/61 必須拒絕。

PostgREST schema cache 可見四 RPC 且 service-role smoke 通過後，DB Gate 才完成。

## 3. Render 部署與持續停用驗證

1. 部署候選 Render artifact 時仍維持 7 個 Runtime Env 全為 false。
2. 驗證 /api/status、/api/tables、Raw/Formal 10 桌健康，且 Queue/Dead-letter cardinality 未被修改。
3. 舊 V103/V104/V104-iteration 保持停用。
4. 依使用者最新指示，V6/V7/V8/V9 本次只部署修復、不啟用；四個 Env 全程維持 false，不做逐版啟用。
5. Render restart 完成後讀回四個 Env 仍為 false，並監測 Shadow issuance 計數不再增加；若任何一版產生新 issuance，立即 BLOCK 並回滾前版 artifact。
6. 在四版持續停用下執行正式 Raw/Formal Production E2E；部署成功或 /api/status ACTIVE 不能代替 E2E。Compact Hydration 的啟用驗證保留至使用者未來另行批准啟用時執行。

## 4. Rollback guard

任一 DB readback、Render startup、hydration 或正式 E2E 失敗：

1. 先將 V105_SHADOW_V6_ENABLED、V105_SHADOW_V7_ENABLED、V105_SHADOW_V8_ENABLED、V105_SHADOW_V9_ENABLED 全部設回 false，並確認正式 readback。
2. 等 Render restart 完成；確認 Raw/Formal 10 桌健康。
3. 回復前一個 Render artifact，仍保持全部 Shadow Env 停用；再次驗證正式 health。
4. DB 物件為 additive compatibility layer，不 Drop index/function、不刪 Shadow history、不改 migration ledger。
5. 禁止清 Queue 或 Dead-letter；禁止把 MT API 測試帶入 rollback。
6. 若 ledger/catalog 不一致、index invalid 或 PostgREST cache 不一致，維持 BLOCK，交由 DB owner 以新的、可稽核 migration 修復；不得手改 ledger 冒充已完成。

Rollback 完成條件是：V6–V9 正式 Env 全停、前版 Render artifact 運作、Raw/Formal 10 桌健康、Queue/Dead-letter 未清、ledger/catalog 狀態已記錄。DB additive 物件保留不代表 Runtime 仍啟用。
