import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cliModule = await import('../scripts/activate-formal-memory.mjs').catch(() => ({}))
const manifest = JSON.parse(readFileSync(new URL('../../release/v105-formal-release-manifest.json', import.meta.url), 'utf8'))

test('memory activation CLI accepts only clean E2E evidence for the exact manifest release', async () => {
  assert.equal(typeof cliModule.runFormalMemoryActivation, 'function', 'formal memory activation CLI is not implemented')

  const strategyWrites = []
  const reportWrites = []
  const onlineCoreClient = {
    async upsertStrategyVersion(input) {
      strategyWrites.push(input)
      return { ok: true, row: input }
    },
    async upsertFormalReleaseReport(input) {
      reportWrites.push(input)
      return { ok: true, row: input }
    },
  }
  const files = new Map([
    ['manifest.json', JSON.stringify(manifest)],
    ['mismatch.json', JSON.stringify({ releaseVersion: 'v105.0.0-formal.9', passed: true, verifiedTables: 10, completedAt: '2026-07-24T12:00:00.000Z' })],
    ['secret.json', JSON.stringify({ releaseVersion: 'v105.0.0-formal.12', passed: true, verifiedTables: 10, completedAt: '2026-07-24T12:00:00.000Z', token: 'must-not-be-accepted' })],
    ['passed.json', JSON.stringify({ releaseVersion: 'v105.0.0-formal.12', passed: true, verifiedTables: 10, completedAt: '2026-07-24T12:00:00.000Z', finalRows: 917, checks: { proxy: true, database: true, queue: true, cursor: true, frontend: true } })],
  ])
  const readFileImpl = async (path) => {
    if (!files.has(path)) throw new Error(`missing evidence file: ${path}`)
    return files.get(path)
  }

  await assert.rejects(
    cliModule.runFormalMemoryActivation({ manifestPath: 'manifest.json', e2eEvidencePath: 'mismatch.json', onlineCoreClient, readFileImpl }),
    /release version/i,
  )
  await assert.rejects(
    cliModule.runFormalMemoryActivation({ manifestPath: 'manifest.json', e2eEvidencePath: 'secret.json', onlineCoreClient, readFileImpl }),
    /sensitive/i,
  )
  assert.equal(strategyWrites.length, 0)
  assert.equal(reportWrites.length, 0)

  const result = await cliModule.runFormalMemoryActivation({ manifestPath: 'manifest.json', e2eEvidencePath: 'passed.json', onlineCoreClient, readFileImpl })

  assert.equal(result.ok, true)
  assert.equal(strategyWrites.length, 1)
  assert.equal(reportWrites.length, 1)
  assert.equal(strategyWrites[0].releaseVersion, 'v105.0.0-formal.12')
  assert.deepEqual(strategyWrites[0].metrics, { verifiedTables: 10, e2ePassed: true })
  assert.equal(reportWrites[0].releaseVersion, 'v105.0.0-formal.12')
  assert.equal(reportWrites[0].strategyVersion, 'v105')
  assert.equal(reportWrites[0].finalRows, 917)
})


test('memory activation CLI rejects non-durable strategy or release-report writes', async () => {
  const readFileImpl = async (path) => JSON.stringify(path === 'manifest.json' ? manifest : {
    releaseVersion: 'v105.0.0-formal.12',
    passed: true,
    verifiedTables: 10,
    completedAt: '2026-07-24T12:00:00.000Z',
  })
  let reportWrites = 0
  await assert.rejects(
    cliModule.runFormalMemoryActivation({
      manifestPath: 'manifest.json',
      e2eEvidencePath: 'passed.json',
      readFileImpl,
      onlineCoreClient: {
        async upsertStrategyVersion() { return { skipped: true } },
        async upsertFormalReleaseReport() { reportWrites += 1; return { ok: true } },
      },
    }),
    /strategy.*durable/i,
  )
  assert.equal(reportWrites, 0)

  await assert.rejects(
    cliModule.runFormalMemoryActivation({
      manifestPath: 'manifest.json',
      e2eEvidencePath: 'passed.json',
      readFileImpl,
      onlineCoreClient: {
        async upsertStrategyVersion() { return { ok: true } },
        async upsertFormalReleaseReport() { return { skipped: true } },
      },
    }),
    /report.*durable/i,
  )
})
