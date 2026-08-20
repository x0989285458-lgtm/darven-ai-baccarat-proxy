import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import manifest from '../../release/v106-formal-v10-main-release-manifest.json' with { type: 'json' }
import { runV106ProductionCutover } from '../../scripts/run-v106-production-cutover.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const tree = () => execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
const generation = '11111111-1111-4111-8111-111111111111'
const productionDbGate = async () => ({ ok: true, generation })

test('Formal.20 bound cutover authorizes exact HEAD, proves public identity, then and only then starts producer', async () => {
  const events = []
  const result = await runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async (options) => {
      events.push(['readiness', options.url, options.expectedCommit, options.attempts])
      return { verdict: 'PASS', consecutive: 2 }
    },
    verifyProductionDb: async ({ phase }) => {
      events.push(['db', phase])
      return { ok: true, generation }
    },
    startProducer: async (identity) => {
      events.push(['producer', identity.commit, identity.generation])
      return { ok: true, generation, workerImageId: manifest.productionCutoverRunner.producerImageId }
    },
  })
  assert.equal(result.verdict, 'PASS')
  assert.deepEqual(events, [
    ['readiness', manifest.canonicalPublicProxyUrl, head(), 30],
    ['db', 'pre'],
    ['producer', head(), generation],
    ['db', 'post'],
  ])
})

test('Formal.20 bound cutover blocks producer when production DB provenance is missing', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: async () => ({ ok: false }),
    startProducer: async () => { producerCalls += 1; return { ok: true } },
  }), /production_cutover_db_provenance_not_proven/)
  assert.equal(producerCalls, 0)
})

test('Formal.20 bound cutover rejects mutable-tag image substitution and generation drift', async () => {
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: productionDbGate,
    startProducer: async () => ({ ok: true, generation, workerImageId: 'sha256:' + '0'.repeat(64) }),
  }), /production_cutover_producer_start_failed/)

  let calls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: async ({ phase }) => ({ ok: true, generation: phase === 'pre' ? generation : '22222222-2222-4222-8222-222222222222' }),
    startProducer: async () => { calls += 1; return { ok: true, generation, workerImageId: manifest.productionCutoverRunner.producerImageId } },
  }), /production_cutover_db_generation_drift/)
  assert.equal(calls, 1)
})

test('Formal.20 bound cutover never calls producer when exact public readiness blocks', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => { const error = new Error('blocked'); error.code = 'PUBLIC_PROXY_READINESS_BLOCK'; throw error },
    verifyProductionDb: productionDbGate,
    startProducer: async () => { producerCalls += 1; return { ok: true } },
  }), (error) => error?.code === 'PUBLIC_PROXY_READINESS_BLOCK')
  assert.equal(producerCalls, 0)
})

test('Formal.20 bound cutover rejects post-readiness tree drift before producer start', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => '0'.repeat(40),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: productionDbGate,
    startProducer: async () => { producerCalls += 1; return { ok: true } },
  }), /production_cutover_post_readiness_identity_drift/)
  assert.equal(producerCalls, 0)
})

test('Formal.20 bound cutover rejects an authorized commit that is not exact checked-out HEAD before probing or producer start', async () => {
  let sideEffects = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: 'f'.repeat(40) }),
    verifyReadiness: async () => { sideEffects += 1; return { verdict: 'PASS', consecutive: 2 } },
    verifyProductionDb: async () => { sideEffects += 1; return { ok: true, generation } },
    startProducer: async () => { sideEffects += 1; return { ok: true } },
  }), /production_cutover_head_commit_mismatch/)
  assert.equal(sideEffects, 0)
})
