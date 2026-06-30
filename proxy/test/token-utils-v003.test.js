import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTokenFromMtUrl, buildEnvTextWithToken } from '../src/token-utils.js'

test('v003 extracts MT token from full MT URL', () => {
  const token = extractTokenFromMtUrl('https://gsa.ofalive99.net/?token=599fe2ec6ec9becd0883107c8366cc8e&lang=zhtw')
  assert.equal(token, '599fe2ec6ec9becd0883107c8366cc8e')
})

test('v003 accepts raw token and rejects invalid token text', () => {
  assert.equal(extractTokenFromMtUrl('599fe2ec6ec9becd0883107c8366cc8e'), '599fe2ec6ec9becd0883107c8366cc8e')
  assert.throws(() => extractTokenFromMtUrl('https://gsa.ofalive99.net/?lang=zhtw'), /token/i)
})

test('v003 updates env text while preserving existing settings', () => {
  const env = buildEnvTextWithToken('PORT=8787\nAUTO_CONNECT=false\nMT_TOKEN=old\n', '599fe2ec6ec9becd0883107c8366cc8e')
  assert.match(env, /PORT=8787/)
  assert.match(env, /AUTO_CONNECT=false/)
  assert.match(env, /MT_TOKEN=599fe2ec6ec9becd0883107c8366cc8e/)
  assert.equal((env.match(/^MT_TOKEN=/gm) ?? []).length, 1)
})
