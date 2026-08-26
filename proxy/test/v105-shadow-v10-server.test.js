import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Main33 keeps the V10 strategy builder but retires its independent server runtime', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  const main = await readFile(new URL('../src/v105-v10-main-strategy.js', import.meta.url), 'utf8')
  for (const token of ['v105-shadow-v10-runtime', 'V105_SHADOW_V10_ENABLED', 'v105ShadowV10Runtime', 'issueV105ShadowV10Prediction']) {
    assert.equal(server.includes(token), false, token)
  }
  assert.match(main, /buildV105ShadowV10Prediction/)
  assert.match(main, /v105-shadow-v10-contract\.js/)
})
