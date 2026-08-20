import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import manifest from '../../release/v106-formal-v10-main-release-manifest.json' with { type: 'json' }
import { runV106ProductionCutover } from '../../scripts/run-v106-production-cutover.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const tree = () => execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()

test('Formal.17 bound cutover authorizes exact HEAD, proves public identity, then and only then starts producer', async () => {
  const events = []
  const result = await runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async (options) => {
      events.push(['readiness', options.url, options.expectedCommit, options.attempts])
      return { verdict: 'PASS', consecutive: 2 }
    },
    startProducer: async (identity) => {
      events.push(['producer', identity.commit])
      return { ok: true }
    },
  })
  assert.equal(result.verdict, 'PASS')
  assert.deepEqual(events, [
    ['readiness', manifest.canonicalPublicProxyUrl, head(), 30],
    ['producer', head()],
  ])
})

test('Formal.17 bound cutover never calls producer when exact public readiness blocks', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => { const error = new Error('blocked'); error.code = 'PUBLIC_PROXY_READINESS_BLOCK'; throw error },
    startProducer: async () => { producerCalls += 1; return { ok: true } },
  }), (error) => error?.code === 'PUBLIC_PROXY_READINESS_BLOCK')
  assert.equal(producerCalls, 0)
})

test('Formal.17 bound cutover rejects an authorized commit that is not exact checked-out HEAD before probing or producer start', async () => {
  let sideEffects = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: 'f'.repeat(40) }),
    verifyReadiness: async () => { sideEffects += 1; return { verdict: 'PASS', consecutive: 2 } },
    startProducer: async () => { sideEffects += 1; return { ok: true } },
  }), /production_cutover_head_commit_mismatch/)
  assert.equal(sideEffects, 0)
})
