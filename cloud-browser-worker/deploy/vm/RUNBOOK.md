# v098 VM 部署、回滾與驗證

本文件只定義操作步驟；提交此版本時不得直接操作正式 VM。

## 部署前檢查

先進入 VM repo 的 `cloud-browser-worker/deploy/vm` 目錄。下列檢查只確認變數存在，不輸出值：

```bash
cd "$(git rev-parse --show-toplevel)/cloud-browser-worker/deploy/vm"
test "$(stat -c '%a' worker.env)" = 600
for key in MT_LOGIN_URL WORKER_ADMIN_KEY INGEST_KEY PUSH_TARGET_URL; do
  grep -Eq "^${key}=.+" worker.env || { printf 'missing %s\n' "$key" >&2; exit 1; }
done
grep -Eq '^NODE_ENV=production$' worker.env
```

記錄目前可回滾 revision，並以已審核的 commit 部署：

```bash
cd "$(git rev-parse --show-toplevel)"
git rev-parse HEAD > .previous-worker-revision
git fetch origin
: "${REVIEWED_COMMIT_SHA:?set REVIEWED_COMMIT_SHA to the reviewed commit SHA}"
git checkout --detach "$REVIEWED_COMMIT_SHA"
cd cloud-browser-worker/deploy/vm
docker compose build --pull
docker compose up -d
```

## 驗證

載入 VM 本機環境但不要列印變數：

```bash
cd "$(git rev-parse --show-toplevel)/cloud-browser-worker/deploy/vm"
set -a; . ./worker.env; set +a
curl --fail --silent http://127.0.0.1:8787/health |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);if(!x.ok||x.buildVersion!=='v098')process.exit(1);console.log(x.buildVersion)})"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H "x-worker-admin-key: $WORKER_ADMIN_KEY" http://127.0.0.1:8787/snapshot)" = 200
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:8787/snapshot?adminKey=invalid")" = 401
docker compose restart cloud-browser-worker
docker compose ps --status running cloud-browser-worker
```

重啟後確認 `/health` 仍為 `v098`，並從 Render/Supabase 的非敏感監控確認只新增 completed rounds；不得用正式資料做寫入測試或清除 queue/cursor volume。

## 回滾

```bash
cd "$(git rev-parse --show-toplevel)"
git checkout --detach "$(cat .previous-worker-revision)"
cd cloud-browser-worker/deploy/vm
docker compose build
docker compose up -d
```

回滾後重跑該 revision 的 health/snapshot 驗證。保留 `worker-push-state` volume，避免遺失未確認 envelope 與 ack cursor；除非事故指揮明確批准，不得執行 `docker compose down -v`。
