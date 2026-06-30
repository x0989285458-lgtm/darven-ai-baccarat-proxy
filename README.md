# Draven 本機整合運行版 版本 001 第一版正式版

本版本把目前的正式前後台與 MT Chrome 背景抓取代理整合成同一個本機運行資料夾。

## 版本位置

```text
C:\Users\童威仁\Desktop\百家AI軟體\Draven_本機整合運行版_版本_001_第一版正式版
```

## 來源版本

| 模組 | 來源 |
|---|---|
| 前台 / 登入 / 後台 | `AI百家\Darven_AI_正式版_001_前後台第一版` |
| MT 本機代理 | `Draven_代理_版本_004_Chrome背景抓取` |
| Supabase | `https://gscfexhsqxvtpyxudtza.supabase.co` |

## 啟動方式

雙擊：

```text
啟動Draven本機整合運行版.bat
```

啟動後會開啟：

| 頁面 | URL |
|---|---|
| 前台 | `http://127.0.0.1:5174/` |
| 登入 | `http://127.0.0.1:5174/login` |
| 後台 | `http://127.0.0.1:5174/admin` |
| 代理狀態 | `http://127.0.0.1:8787/api/status` |
| 桌況資料 | `http://127.0.0.1:8787/api/tables` |

## 設定檔

### 前台

```text
frontend\.env.local
```

包含 Supabase 與本機代理 API 設定：

```text
VITE_SUPABASE_URL=https://gscfexhsqxvtpyxudtza.supabase.co
VITE_DRAVEN_PROXY_API_URL=http://127.0.0.1:8787
```

### 代理

```text
proxy\.env
```

MT token 過期時，主要修改：

```text
CHROME_CAPTURE_URL=https://gsa.ofalive99.net/?token=你的新TOKEN&lang=zhtw
```

## 注意事項

- 本版本是「本機整合運行版」，不是雲端上線版。
- 目前仍需要本機已安裝 Node.js 與 Chrome。
- MT token 可能會過期；過期時需更新 `proxy\.env` 的 `CHROME_CAPTURE_URL`。
- 前台不再直接連 MT WebSocket，而是讀取本機代理 `http://127.0.0.1:8787/api/tables`。
- Supabase anon public key 保留在本機 `.env.local`，不可公開提交。
- Secret key / service role 不可放進前端。

## 停止方式

雙擊：

```text
停止Draven本機整合運行版.bat
```

或手動關閉啟動後出現的兩個黑色視窗。
