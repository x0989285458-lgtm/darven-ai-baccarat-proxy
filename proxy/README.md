# Draven_代理_版本_001_MT資料代理伺服器測試

這是 MT 百家資料代理伺服器的第一個測試版本，放在哥指定的桌面資料夾：

```text
C:\Users\童威仁\Desktop\百家AI軟體\Draven_代理_版本_001_MT資料代理伺服器測試
```

## 目的

```text
MT百家 WebSocket
  ↓
Draven 代理伺服器
  ↓
整理成統一桌台資料
  ↓
提供 API 給後台 / 前台讀取
```

## 目前 v001 已完成

- 建立 MT 驗證封包。
- 建立 MT 桌台資料請求封包。
- 正規化 BAC / BAS 百家桌台資料。
- 建立記憶體狀態中心。
- 建立本機 HTTP API。
- 建立測試模式啟動檔。
- 建立連線模式啟動檔。
- 不把 MT_TOKEN 寫進 Git。

## 啟動測試模式

雙擊：

```text
啟動代理伺服器_測試模式.bat
```

測試模式不會連接 MT，只會啟動本機 API。

## API

| 用途 | URL |
|---|---|
| 健康檢查 | `http://127.0.0.1:8787/health` |
| 資料來源狀態 | `http://127.0.0.1:8787/api/status` |
| 桌台資料 | `http://127.0.0.1:8787/api/tables` |
| 完整快照 | `http://127.0.0.1:8787/api/snapshot` |

## 連線模式

連線模式需要先設定環境變數：

```bat
set MT_TOKEN=你的MT_TOKEN
```

再雙擊：

```text
啟動代理伺服器_連線模式.bat
```

## 測試

```bash
npm.cmd test
```

目前測試內容：

- MT 驗證封包。
- MT 桌台請求封包。
- MT 桌台資料正規化。
- 代理狀態中心。
- HTTP API。

## Token 會變動的影響

目前哥發現 MT 網址的 token 每次登入可能不同，這會有影響：

- token 若過期或換新，代理伺服器會無法驗證資料來源。
- token 不能寫死在前台，也不能提交到 Git。
- v001 先支援把 token 放在本機 `.env` 或環境變數 `MT_TOKEN`。
- 後續正式版建議做「後台更新 token」或「自動登入/自動刷新 token」流程。

## 本次實測狀態

使用哥提供的新 token 啟動代理後，本機 API 可以正常啟動：

```text
/health 正常回應
/api/status 正常回應
```

但 MT WebSocket 目前回傳：

```text
Unexpected server response: 403
```

代表目前來源站拒絕 WebSocket 連線；原因可能是 token 已失效、來源站限制 IP/地區、需要瀏覽器 session/cookie，或需要更完整的登入流程。v001 已把狀態寫到 `/api/status`，方便後台之後顯示。

## 注意

- 這版是伺服器測試版，還沒有接到正式後台 UI。
- 下一版可以把 `/admin` 改成讀取此代理 API 狀態。
- MT token 只能放後端環境變數，不能放前台。
