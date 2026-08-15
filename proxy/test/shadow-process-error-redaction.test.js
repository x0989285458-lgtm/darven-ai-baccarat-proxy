import test from 'node:test'
import assert from 'node:assert/strict'
import { redactShadowErrorMessage } from '../src/shadow-process-error-redaction.js'

test('shadow IPC error redaction removes URI userinfo, JWTs, Supabase keys, and named secrets', () => {
  const jwt = `eyJ${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`
  const supabase = `sb_secret_${'x'.repeat(24)}`
  const syntheticUri = ['postgresql://', 'dbuser', ':', 'dbpass123', '@example.invalid/v9'].join('')
  const redacted = redactShadowErrorMessage(`connect ${syntheticUri} ${jwt} ${supabase} password=hunter2`)
  for (const secret of ['dbuser', 'dbpass123', jwt, supabase, 'hunter2']) assert.equal(redacted.includes(secret), false)
  assert.match(redacted, /\[REDACTED\]/)
  assert.ok(redacted.length <= 500)
})
