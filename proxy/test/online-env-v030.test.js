import test from 'node:test'
import assert from 'node:assert/strict'
import { createLicenseAdminClient } from '../src/license-admin.js'

test('v030 license admin reads db connection from process env at create time', () => {
  const previous = process.env.SUPABASE_DB_CONNECTION_STRING
  process.env.SUPABASE_DB_CONNECTION_STRING = 'postgresql://example.invalid/postgres'
  try {
    const client = createLicenseAdminClient()
    assert.equal(client.configured, true)
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_DB_CONNECTION_STRING
    else process.env.SUPABASE_DB_CONNECTION_STRING = previous
  }
})
