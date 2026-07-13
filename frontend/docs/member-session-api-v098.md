# v098 會員 Session 後端 API 介面規格

此前端只定義介面，不包含 proxy 實作。

## 1. 會員登入

`POST /api/online-license/member-login`

Request JSON：

- `memberAccount: string`
- `verificationPassword: string`
- `turnstileToken?: string`

成功 Response JSON：

- `ok: true`
- `memberSessionToken: string`：後端簽發的短效、不透明 token
- `sessionExpiresAt: string`：ISO 8601 到期時間
- `license?: object`

缺少 token 或到期時間時，前端視為登入失敗，不建立本機登入狀態。

## 2. Session 驗證

`POST /api/online-license/member-session`

Header：`Authorization: Bearer <memberSessionToken>`

成功 Response JSON：

- `ok: true`
- `sessionExpiresAt?: string`：後端可更新短效到期時間

失敗：HTTP 401/403，或 JSON `ok: false`。前端會清除 token、停止桌況讀取並回到登入狀態。

前端於啟動時驗證，登入期間每 60 秒重新驗證。

## 3. 受保護資料 API

下列請求必須帶同一個 Bearer token：

- `GET /api/tables`
- `GET /api/status`

前端不把 token 放入 URL，因此會員模式停用無法附加 Header 的原生 `EventSource`，改用帶 Header 的週期輪詢。

## 4. 安全與資料時效

- token 只存於 `sessionStorage`：`darven-member-session-token`。
- 到期時間存於 `darven-member-session-expires-at`。
- 不接受舊的 `darven-member-login=yes` 作為登入依據。
- `/api/tables` 每桌必須提供有效且未過期的 `sourceUpdatedAt`。
- `/api/status` 若回報 `stale` 或「過期」，前端清空可出手資料並停止出手。
- production cloud 模式必須提供 `VITE_DRAVEN_CLOUD_API_URL`；前端不回退 localhost，也不直接連 Supabase。
