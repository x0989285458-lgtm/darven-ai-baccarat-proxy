import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Main33 keeps the V9 construction contract but retires its independent server runtime', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  const main = await readFile(new URL('../src/v105-v10-main-strategy.js', import.meta.url), 'utf8')
  const v10 = await readFile(new URL('../src/v105-shadow-v10-contract.js', import.meta.url), 'utf8')
  for (const token of ['v105-shadow-v9-runtime', 'V105_SHADOW_V9_ENABLED', 'v105ShadowV9Runtime', 'issueV105ShadowV9Prediction']) {
    assert.equal(server.includes(token), false, token)
  }
  assert.match(main, /v105-shadow-v10-contract\.js/)
  assert.match(v10, /v105-shadow-v9-contract\.js/)
})
