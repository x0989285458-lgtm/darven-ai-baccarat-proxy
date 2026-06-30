# Darven Cloud Browser Worker v047

Render 上的雲端瀏覽器抓牌 worker。它會打開 `MT_LOGIN_URL`，攔截頁面 JSON / WebSocket / localStorage 內容，整理成 proxy 需要的 `/snapshot` 格式。

## Render 建立方式

1. 把這個版本推到 GitHub。
2. Render → **New +** → **Web Service**。
3. 選 GitHub repo。
4. Root Directory 填：

```text
cloud-browser-worker
```

5. Runtime 選 **Docker**。
6. Service name：

```text
darven-cloud-browser-worker
```

7. Environment 新增：

```env
MT_LOGIN_URL=https://gsa.ofalive99.net/?token=你的MT_TOKEN&lang=zhtw
HEADLESS=true
SNAPSHOT_PATH=/snapshot
INITIAL_SETTLE_MS=5000
PAGE_TIMEOUT_MS=45000
```

8. Deploy。

## 部署成功後

Render 會給 worker 網址，例如：

```text
https://darven-cloud-browser-worker.onrender.com
```

測試：

```text
https://darven-cloud-browser-worker.onrender.com/health
https://darven-cloud-browser-worker.onrender.com/snapshot
```

`snapshot` 應回傳：

```json
{
  "connected": true,
  "authenticated": true,
  "sessionId": "darven-cloud-browser",
  "tables": [],
  "rounds": []
}
```

如果 `tables` 還是空，代表 worker 已開網頁，但尚未攔到 MT 桌台資料；先保持服務運行 1-2 分鐘再刷新 `/snapshot`。

## 接回 proxy

到原本後端 `darven-ai-baccarat-proxy` 的 Render Environment：

```env
CAPTURE_SOURCE=cloud_browser
CLOUD_BROWSER_URL=https://darven-cloud-browser-worker.onrender.com/snapshot
```

按 Save Changes，等 Render 重新部署。

## 本機驗證

```bash
npm install
npm test
PORT=8798 npm start
curl http://127.0.0.1:8798/health
curl http://127.0.0.1:8798/snapshot
```

## 注意

- `MT_LOGIN_URL` 含 token，不要貼到公開 GitHub、截圖、群組。
- 這版不改前端 UI。
- 這版只新增 worker；原 proxy 已經支援 `CLOUD_BROWSER_URL`。
