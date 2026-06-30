import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v041 hosted deployment checklist covers Supabase, backend, frontend, and worker smoke checks', () => {
  const doc = readFileSync(new URL('../deploy/DEPLOYMENT.md', import.meta.url), 'utf8')
  for (const required of [
    'schema_v039_cloud_capture.sql',
    '/health',
    '/api/cloud-capture/status',
    '/api/cloud-capture/tick',
    'VITE_DRAVEN_API_MODE=cloud',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CLOUD_BROWSER_URL',
  ]) {
    assert.match(doc, new RegExp(required.replace(/[/.]/g, '\\$&')))
  }
})
