# v100 GCP VM部署、回滾與驗證

正式VM：`darven-mt-taiwan-worker-5`（`asia-east1-b`）。正式服務：`darven-worker.service`。正式Queue／Cursor：`/var/lib/darven-worker`。

## 部署前Gate

在VM執行，只確認設定存在，不輸出值：

```bash
set -euo pipefail
sudo test "$(sudo stat -c '%a' /etc/darven-worker/worker.env)" = 600
sudo test "$(sudo stat -c '%u:%g' /etc/darven-worker/worker.env)" = 0:0
for key in MT_LOGIN_URL WORKER_ADMIN_KEY INGEST_KEY PUSH_TARGET_URL; do
  sudo sh -eu -c "grep -Eq '^${key}=.+' /etc/darven-worker/worker.env"
done
sudo test -d /var/lib/darven-worker
sudo test "$(sudo stat -c '%a' /var/lib/darven-worker)" = 700
```

以不可變Image ID記錄回滾點，並保存部署前Queue／Cursor狀態：

```bash
set -euo pipefail
PREVIOUS_IMAGE_ID="$(sudo docker inspect darven-worker --format '{{.Image}}')"
test -n "$PREVIOUS_IMAGE_ID"
printf '%s\n' "$PREVIOUS_IMAGE_ID" | \
  sudo install -o root -g root -m 600 /dev/stdin /etc/darven-worker/previous-image-id
sudo test "$(sudo stat -c '%u:%g:%a' /etc/darven-worker/previous-image-id)" = 0:0:600
sudo python3 /opt/darven-v100-<sha7>/cloud-browser-worker/deploy/vm/verify-state-continuity.py \
  capture --evidence /tmp/darven-worker-state-before.json
```

## 建立不可變Image

從已審核Commit的repo root建置；lockfile不一致時`npm ci`必須讓Build失敗：

```bash
set -euo pipefail
cd /opt/darven-v100-<sha7>
sudo docker build --pull \
  -t darven-worker:v100-<sha7> \
  -f cloud-browser-worker/Dockerfile .
test "$(sudo docker image inspect darven-worker:v100-<sha7> \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}}')" = v100
sudo systemd-analyze verify cloud-browser-worker/deploy/vm/darven-worker.service
```

## 切換與自動回滾Gate

下列區塊任一步失敗會以部署前Image ID回滾；不刪除Queue／Cursor：

```bash
set -euo pipefail
PREVIOUS_IMAGE_ID="$(sudo cat /etc/darven-worker/previous-image-id)"
rollback() {
  printf 'WORKER_IMAGE=%s\n' "$PREVIOUS_IMAGE_ID" | \
    sudo install -o root -g root -m 600 /dev/stdin /etc/darven-worker/release.env
  sudo systemctl daemon-reload
  sudo systemctl restart darven-worker.service
}
trap rollback ERR

sudo install -m 0644 \
  /opt/darven-v100-<sha7>/cloud-browser-worker/deploy/vm/darven-worker.service \
  /etc/systemd/system/darven-worker.service
printf '%s\n' 'WORKER_IMAGE=darven-worker:v100-<sha7>' | \
  sudo install -o root -g root -m 600 /dev/stdin /etc/darven-worker/release.env
sudo test "$(sudo stat -c '%u:%g:%a' /etc/darven-worker/release.env)" = 0:0:600
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/darven-worker.service
sudo systemctl restart darven-worker.service
sudo systemctl is-active --quiet darven-worker.service

test "$(sudo docker inspect darven-worker --format '{{.Config.Image}}')" = 'darven-worker:v100-<sha7>'
test "$(sudo docker inspect darven-worker --format '{{.State.Running}}')" = true
sudo systemctl show darven-worker.service -p ExecStart -p ExecStop --no-pager

curl -fsS http://127.0.0.1:8787/health |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);if(!x.ok||x.buildVersion!=='100')process.exit(1)})"

sudo sh -eu -c '
  set -a
  . /etc/darven-worker/worker.env
  set +a
  payload="$(curl -fsS -H "x-worker-admin-key: $WORKER_ADMIN_KEY" http://127.0.0.1:8787/snapshot)"
  printf "%s" "$payload" | python3 -c '\''import json,sys; x=json.load(sys.stdin); assert x.get("connected") is True; assert x.get("authenticated") is True; assert len(x.get("tables") or []) == 10'\''
  test "$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/snapshot?adminKey=invalid")" = 401
'

sudo python3 /opt/darven-v100-<sha7>/cloud-browser-worker/deploy/vm/verify-state-continuity.py \
  verify --evidence /tmp/darven-worker-state-before.json
trap - ERR
```

再由Render `/api/status`與正式DB確認：

- Proxy buildVersion=`v100`、Worker protocol=`v100`。
- tableCount=`10`、connected/authenticated=true。
- Persistence正常，Final持續寫入。
- Rank Ledger失敗不ACK；未ACK Queue仍保留。
- 新結算只寫`strategy_version=v100`、`settlement_final=true`。

不得執行`docker system prune --volumes`，不得刪除`/var/lib/darven-worker`。

## 手動回滾

```bash
set -euo pipefail
PREVIOUS_IMAGE_ID="$(sudo cat /etc/darven-worker/previous-image-id)"
test -n "$PREVIOUS_IMAGE_ID"
printf 'WORKER_IMAGE=%s\n' "$PREVIOUS_IMAGE_ID" | \
  sudo install -o root -g root -m 600 /dev/stdin /etc/darven-worker/release.env
sudo test "$(sudo stat -c '%u:%g:%a' /etc/darven-worker/release.env)" = 0:0:600
sudo systemctl daemon-reload
sudo systemctl restart darven-worker.service
sudo systemctl is-active --quiet darven-worker.service
```

回滾使用不可變Image ID，不依賴可能被重新指向的Tag；只切Image，不刪除Queue／Cursor，不重建`worker.env`。
