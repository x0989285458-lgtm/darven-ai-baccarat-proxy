import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v106 proxy package exposes cloud deployment smoke and mock worker commands', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'draven-mt-data-proxy-v106')
  assert.equal(pkg.version, '1.0.98')
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs')
  assert.equal(pkg.scripts['smoke:cloud'], 'node scripts/smoke-cloud-deploy.mjs')
  assert.equal(pkg.scripts['mock:cloud-worker'], 'node scripts/mock-cloud-worker.mjs')
  const runner = readFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8')
  const scrubber = readFileSync(new URL('../../scripts/test-env-scrub.mjs', import.meta.url), 'utf8')
  assert.match(runner, /buildScrubbedTestEnv/)
  assert.match(scrubber, /delete env\[key\]/)
  for (const key of ['SUPABASE_DB_CONNECTION_STRING', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'DATABASE_URL', 'POSTGRES_URL']) {
    assert.match(scrubber, new RegExp(`['"]${key}['"]`))
  }
})
