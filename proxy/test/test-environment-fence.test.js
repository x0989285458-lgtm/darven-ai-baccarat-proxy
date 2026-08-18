import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const runner = readFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8')
const workerRunner = readFileSync(new URL('../../scripts/run-worker-tests-scrubbed.mjs', import.meta.url), 'utf8')
const scrubber = readFileSync(new URL('../../scripts/test-env-scrub.mjs', import.meta.url), 'utf8')
const requiredScrubbedKeys = [
  'SUPABASE_DB_CONNECTION_STRING', 'DATABASE_URL', 'DIRECT_DATABASE_URL', 'POSTGRES_URL',
  'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSERVICE',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_ANON_KEY',
  'MT_TOKEN', 'WORKER_ADMIN_KEY', 'INGEST_KEY', 'CLOUD_BROWSER_URL', 'CHROME_CAPTURE_URL',
  'PROXY_CONTROL_TOKEN', 'MEMBER_SESSION_SECRET', 'ADMIN_SESSION_SECRET',
  'MT_SESSION_PATH', 'PORTAL_CREDENTIALS_FILE', 'MT_BACKUP_SESSION_TOKEN_FILE',
  'CLOUDFLARE_API_TOKEN', 'RENDER_API_KEY', 'SUPABASE_ACCESS_TOKEN',
]

test('canonical proxy test runner scrubs every production-capable database, runtime, and deploy credential', () => {
  assert.match(runner, /buildScrubbedTestEnv/)
  assert.match(runner, /shell:\s*false/)
  assert.match(workerRunner, /buildScrubbedTestEnv/)
  assert.match(workerRunner, /shell:\s*false/)
  assert.match(scrubber, /delete env\[key\]/)
  for (const key of requiredScrubbedKeys) assert.match(scrubber, new RegExp(`['"]${key}['"]`), key)
})

test('canonical runner child process receives no production write authority', () => {
  for (const key of requiredScrubbedKeys) assert.equal(process.env[key], undefined, key)
  assert.equal(process.env.NODE_ENV, 'test')
})
