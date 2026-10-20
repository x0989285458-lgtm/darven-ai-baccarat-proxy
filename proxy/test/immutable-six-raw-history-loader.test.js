import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHistoricalLoader, HISTORICAL_COMMIT, HISTORICAL_TREE } from './helpers/immutable-six-raw-history.mjs'
import { PRODUCTION_TABLE_IDS as CURRENT_IDS } from '../src/cloud-capture.js'

const HISTORICAL_IDS = ['BAG01', 'BAG02', 'BAG03', 'BAG03A', 'BAG05', 'BAG06', 'BAG07', 'BAG08', 'BAG09', 'BAG10']
const SIX_RAW_IDS = ['BAV01', 'BAV02', 'BAV03', 'BAV03A', 'BAV05', 'BAV06']

test('immutable history loader fails closed on invalid paths without materializing files', async () => {
  const loader = createHistoricalLoader()
  try {
    for (const path of ['../proxy/src/cloud-capture.js', '/proxy/src/cloud-capture.js', 'proxy/../proxy/src/cloud-capture.js', 'proxy\\src\\cloud-capture.js', 'file:///bad', 'proxy/src/cloud-capture.js?x']) {
      await assert.rejects(loader.importHistoricalModule(path), /path/i)
    }
    assert.equal(loader.root, null)
  } finally { loader.cleanup() }
})

test('immutable history loader rejects missing Git objects and wrong full commit/tree pins', async () => {
  for (const options of [
    { commit: '0'.repeat(40) },
    { tree: '0'.repeat(40) },
    { commit: HISTORICAL_COMMIT.slice(0, 12) },
  ]) {
    const loader = createHistoricalLoader(options)
    try {
      await assert.rejects(loader.importHistoricalModule('proxy/src/cloud-capture.js'))
      assert.equal(loader.root, null)
    } finally { loader.cleanup() }
  }
})

test('immutable ten-table graph and current six-raw graph coexist without pollution and clean up', async () => {
  const loader = createHistoricalLoader()
  try {
    const historical = await loader.importHistoricalModule('proxy/src/cloud-capture.js')
    assert.deepEqual(historical.PRODUCTION_TABLE_IDS, HISTORICAL_IDS)
    assert.deepEqual(CURRENT_IDS, SIX_RAW_IDS)
    assert.equal(loader.evidence.commit, HISTORICAL_COMMIT)
    assert.equal(loader.evidence.tree, HISTORICAL_TREE)
    for (const file of ['proxy/src/cloud-capture.js', 'proxy/src/normalize-table.js', 'proxy/src/event-layer.js']) {
      assert.ok(loader.evidence.loaded.includes(file), file)
    }
    assert.ok(existsSync(loader.root))
    await assert.rejects(loader.importHistoricalModule('proxy/src/not-in-pinned-tree.js'), /Unpinned/)
  } finally { loader.cleanup() }
  assert.equal(loader.evidence.removed, true)
  await assert.rejects(loader.importHistoricalModule('proxy/src/cloud-capture.js'), /closed/)
  assert.deepEqual(CURRENT_IDS, SIX_RAW_IDS)
})

test('immutable history loader rejects tampering even when the imported module is cached', async () => {
  const loader = createHistoricalLoader()
  try {
    await loader.importHistoricalModule('proxy/src/cloud-capture.js')
    const source = join(loader.root, 'proxy/src/normalize-table.js')
    writeFileSync(source, Buffer.concat([readFileSync(source), Buffer.from('\n// tampered\n')]))
    await assert.rejects(loader.importHistoricalModule('proxy/src/cloud-capture.js'), /integrity mismatch/)
  } finally { loader.cleanup() }
  assert.equal(loader.evidence.removed, true)
})
