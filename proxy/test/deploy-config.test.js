import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('deployment examples keep frontend public-only and backend secrets server-side', () => {
  const frontend = readFileSync(new URL('../../frontend/.env.production.example', import.meta.url), 'utf8')
  const backend = readFileSync(new URL('../.env.production.example', import.meta.url), 'utf8')
  const render = readFileSync(new URL('../deploy/render.yaml', import.meta.url), 'utf8')

  assert.match(frontend, /VITE_DRAVEN_API_MODE=cloud/)
  assert.match(frontend, /VITE_DRAVEN_CLOUD_API_URL=/)
  assert.doesNotMatch(frontend, /SERVICE_ROLE|DB_CONNECTION|MT_TOKEN|CHROME_CAPTURE_URL/)

  assert.match(backend, /DEPLOY_MODE=cloud/)
  assert.match(backend, /CAPTURE_SOURCE=cloud_browser/)
  assert.match(backend, /SUPABASE_SERVICE_ROLE_KEY=/)
  assert.match(backend, /CLOUD_BROWSER_URL=/)

  assert.match(render, /type: web/)
  assert.match(render, /runtime: image/)
  assert.match(render, /ghcr\.io\/x0989285458-lgtm\/darven-ai-baccarat-proxy:v105-v10-main\.26/)
  assert.match(render, /fromRegistryCreds:\s*\n\s*name: darven-ghcr/)
  assert.doesNotMatch(render, /buildCommand:|startCommand:|runtime: node/)
  assert.match(render, /CAPTURE_OUTBOX_CONSUMER_ENABLED\s*\n\s*value: ["']false["']/)
})
