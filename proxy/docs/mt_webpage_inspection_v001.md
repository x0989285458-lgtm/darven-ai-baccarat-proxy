# MT 網頁封包檢查紀錄

檢查來源：哥提供的 MT 網址。

> 安全註記：完整 token 不寫入此檔，只記錄遮罩版本。

## 1. 網頁載入結果

使用終端請求網頁 HTML 可取得主程式資源：

```text
主 JS：/assets/index-B3m8yflb.js
主 CSS：/assets/index-BKTqlq7m.css
播放器：/NodePlayer-simd.min.js
```

使用真實 Chrome/CDP 嘗試載入時，來源站回傳：

```text
HTTP 403
頁面標題：⚠️ 訪問受限制
IP：203.176.140.138
位置：KH / Phnom Penh
訊息：所在地不在服務允許範圍內
```

因此目前在此執行環境無法取得真實瀏覽器 WebSocket Frames；頁面在進入遊戲前已被地區/IP 阻擋。

## 2. 從主 JS 找到的 WebSocket URL

遊戲資料 WebSocket：

```text
wss://a1.ofalive99.net/game/ws
```

聊天室 WebSocket：

```text
wss://a2.ofalive99.net/chat/ws
```

不同網域對應：

```text
mtsuper99 → a1.ofalive99.net / a2.ofalive99.net
mtx55     → a1.mtx55.net / a2.mtx55.net
mtx66     → a1.mtx66.net / a2.mtx66.net
mtx77     → a1.mtx77.net / a2.mtx77.net
mtx88     → a1.mtx88.net / a2.mtx88.net
```

哥提供的網域 `gsa.ofalive99.net` 走預設：

```text
a1.ofalive99.net/game/ws
```

## 3. 遊戲 WebSocket 流程

### 連線開啟後先送 authenticate

```json
{
  "method": "POST",
  "action": {
    "name": "/api/v1/authenticate"
  },
  "body": {
    "type": 3,
    "token": "<MT_TOKEN>"
  }
}
```

### authenticate 回覆成功後

原始 JS 邏輯：

```text
如果 /api/v1/authenticate 回覆 err == 0：
1. memberMeApi()
2. getGameTablesApi()
3. 每 5 秒送 Game_ping()
```

### member me

```json
{
  "method": "POST",
  "action": {
    "name": "/api/v1/member/me",
    "lang": "zhtw"
  }
}
```

### tables request

```json
{
  "method": "GET",
  "action": {
    "name": "/api/v1/gametype/*/game/*/room/*/tables",
    "data": {
      "gametype_id": 3,
      "game_id": 1,
      "room_id": 1
    }
  }
}
```

### ping

```json
{
  "method": "POST",
  "action": {
    "name": "/api/v1/ping"
  }
}
```

## 4. 其他有用 API 名稱

```text
/api/v1/gametype/*/game/*/room/*/join
/api/v1/gametype/*/game/*/room/*/leave
/api/v1/gametype/*/game/*/record
/api/v1/member/me/balance
/api/v1/member/me/table/betinfo
```

## 5. 桌台資料欄位

主 JS 會處理：

```text
table_type = BAC / BAS / DT
trend.bead_plate2
trend.big2
trend.big_eye2
trend.small2
trend.cockroach2
trend.next_banker2
trend.next_player2
```

目前我們代理伺服器第一版先抓：

```text
BAC / BAS
bead_plate2
big2
current_round
current_shoe
banker/player/tie count
```

## 6. 現在卡住的原因

目前不是封包找不到，而是來源站在真實瀏覽器環境直接顯示：

```text
訪問受限制 / HTTP 403 / 地區 IP 不允許
```

所以後端代理伺服器從此環境連 MT WebSocket 也會被拒絕。

## 7. 下一步建議

建立：

```text
Draven_代理_版本_002_MT封包流程修正
```

修正方向：

1. 代理伺服器不要一開 WebSocket 就立刻送 tables。
2. 改成 authenticate 成功 `err == 0` 後，再送 `member/me` 與 `tables`。
3. 加上每 5 秒 ping。
4. 加入更明確的 403/IP 限制狀態回報。
5. 若哥本機可正常開網頁，需在哥本機抓 CDP/DevTools 的真實 WebSocket Frames，因為此環境被地區限制擋住。
