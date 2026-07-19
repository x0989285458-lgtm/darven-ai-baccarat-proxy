# 瑞文AI百家 Proxy v101.0.0

正式Proxy負責接收GCP台灣Worker的MT真牌Push、維護v101牌階Ledger、發行不可變預測、Final結算、授權及向Frontend提供API。

## 正式入口

```text
GET  /health
GET  /api/status
GET  /api/tables
POST /api/cloud-ingest/snapshot
```

Worker Push必須通過：

- `WORKER_INGEST_KEY`
- `protocolVersion=v101`
- `buildVersion=101`
- 核准10桌Allowlist
- Exact round keys與Final schema
- Durable DB write及精確ACK

## v101 Runtime

- 主策略：主預測靴內偏移去重版
- 副策略：沿用v100權重與校準，採核准的新出手門檻
- 固定8副牌牌階Ledger
- 正式策略身份：`v101`
- `V100_RELEASE_ENABLED=true`才啟用正式Runtime

## 安全

- Supabase Public函式只允許`service_role`執行。
- Secret不得寫入Frontend、Git、Log或Report。
- 未確認Final不得結算或ACK。
- 缺少策略、Ledger、身份或Durable ACK時fail closed。

## 開發驗證

```bash
npm ci
npm test
node --test test/v101-release-integrity.test.js test/v101-threshold-policy.test.js
```

部署與E2E標準見`deploy/DEPLOYMENT.md`。
