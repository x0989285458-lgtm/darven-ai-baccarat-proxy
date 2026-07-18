import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('hosted deployment checklist covers Supabase, backend, frontend, and worker smoke checks', () => {
  const doc = readFileSync(new URL('../deploy/DEPLOYMENT.md', import.meta.url), 'utf8')
  for (const required of [
    'schema_v100_baseline.sql',
    '/health',
    '/api/status',
    '/api/tables',
    'V100_RELEASE_ENABLED=true',
    'SUPABASE_SERVICE_ROLE_KEY',
    'WORKER_INGEST_KEY',
  ]) {
    assert.match(doc, new RegExp(required.replace(/[/.]/g, '\\$&')))
  }
})
