import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEnvText, maskToken } from '../src/config.js'

test('parses local env text for token without committing secrets into code', () => {
  const env = parseEnvText('PORT=8787\nAUTO_CONNECT=true\nMT_TOKEN=abc123\n')
  assert.equal(env.PORT, '8787')
  assert.equal(env.AUTO_CONNECT, 'true')
  assert.equal(env.MT_TOKEN, 'abc123')
})

test('masks changing MT tokens for logs and status messages', () => {
  assert.equal(maskToken('73c7e78a7b767d688443bec335515182'), '73c7…5182')
})
