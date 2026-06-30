# Darven_AI_版本_003_前台版面更新

React + Vite + TypeScript 製作的百家樂前台資料看板。前台只提供桌台路單、統計與 AI 資料分析呈現，**不包含下注或自動投注功能**。

## 直接開啟前台

請在專案根目錄雙擊 `開啟前台.bat`。它會自動切到專案資料夾；首次執行若尚未安裝依賴，會執行 `npm.cmd install`，再啟動前台並開啟 <http://127.0.0.1:5173/>。

## 開發與測試

```bash
npm.cmd install
npm.cmd run dev
npm.cmd test
npm.cmd run build
```

## 資料來源

Token 輸入框預設值為：

```
decd8bec9f968ef4f67a437f80430727
```

前台透過瀏覽器 WebSocket 連線 `wss://a1.ofalive99.net/game/ws`，先送出 authenticate 封包，再查詢 `gametype_id: 3 / game_id: 1 / room_id: 1` 的桌台。僅顯示 `BAC` 與 `BAS` 桌台。Cloudflare Turnstile 區塊保留作為正式登入驗證碼預留區。

## 路單規則

- 珠盤路最多顯示最近 36 筆，固定為六欄六列。
- 珠盤路每兩碼只讀取第二碼：`01`＝閒、`02`＝莊、`03`＝和。
- 莊對／閒對僅為附加資訊，不影響主結果，例如 `12`＝莊、`21`＝閒、`33`＝和。
- 大路維持原有解析邏輯，依每格末碼判定閒（`1`）或莊（`2`）。
