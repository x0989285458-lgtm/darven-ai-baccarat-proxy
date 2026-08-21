import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import manifest from '../../release/v106-formal-v10-main-release-manifest.json' with { type: 'json' }
import { runV106ProductionCutover } from '../../scripts/run-v106-production-cutover.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8')
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const tree = () => process.env.V106_CANDIDATE_INDEX_TREE || execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
const generation = '11111111-1111-4111-8111-111111111111'
const productionDbGate = async () => ({ ok: true, generation })
const stoppedProducer = async () => ({ ok: true, stopped: true, activeState: 'inactive' })

test('Formal.30 launchers transport decoded scripts without plink shell corruption and target the real worker unit', () => {
  const start = read('scripts/start-v106-formal-producer.py')
  const stop = read('scripts/stop-v106-formal-producer.py')
  assert.match(start, /base64\.b64encode\(remote_script\.encode\('utf-8'\)\)/)
  assert.match(stop, /base64\.b64encode\(remote_script\.encode\('utf-8'\)\)/)
  assert.match(start, /30-v106-formal3-image\.conf[\s\S]*WORKER_IMAGE/)
  assert.match(start, /127\.0\.0\.1:8787\/health/)
  assert.doesNotMatch(start, /127\.0\.0\.1:8790\/health/)
  assert.match(start, /endpointReachable/)
  assert.doesNotMatch(start, /'connected': source\.get/)
  assert.match(stop, /echo "STOP_IDENTITY:\$\{active\}\|\$\{sub\}\|\$\{running\}"/)
  assert.match(start, /remote = f'echo \{encoded\} \| base64 -d \| sudo bash'/)
  assert.match(stop, /remote = f'echo \{encoded\} \| base64 -d \| sudo bash'/)
})

test('Formal.23 binds an external trusted Python interpreter and strips import injection', async () => {
  const runner = await import('../../scripts/run-v106-production-cutover.mjs')
  assert.equal(typeof runner.loadTrustedPythonInterpreter, 'function')
  assert.equal(typeof runner.buildBoundPythonEnvironment, 'function')
  const trusted = runner.loadTrustedPythonInterpreter({ root })
  assert.equal(trusted.sha256, 'c5f556ec6491af96e925f149c8e81701103862ca4d686af5788ad3e1954ca081')
  assert.match(trusted.path.replaceAll('\\', '/'), /\/hermes-agent\/venv\/Scripts\/python\.exe$/i)
  const env = runner.buildBoundPythonEnvironment({ PYTHONPATH: 'attacker', PYTHONHOME: 'attacker', VIRTUAL_ENV: 'attacker', SAFE_VALUE: 'kept' })
  assert.equal(env.PYTHONPATH, undefined)
  assert.equal(env.PYTHONHOME, undefined)
  assert.equal(env.VIRTUAL_ENV, undefined)
  assert.equal(env.SAFE_VALUE, 'kept')
  assert.equal(env.PYTHONNOUSERSITE, '1')
})

test('Formal.26 DB gate is stdlib-only and calls one fixed service-role RPC', () => {
  const candidateIndexTree = tree()
  const source = execFileSync('git', ['show', `${candidateIndexTree}:scripts/verify-v106-production-db-gate.py`], { cwd: root, encoding: 'utf8' })
  assert.doesNotMatch(source, /import psycopg|psycopg\./)
  assert.match(source, /verify_v106_production_cutover_gate/)
  assert.match(source, /urllib\.request/)
  assert.match(source, /Authorization/)
  const gateSql = execFileSync('git', ['show', `${candidateIndexTree}:supabase/migrations/20260821010000_v106_formal24_isolated_runtime_gate.sql`], { cwd: root, encoding: 'utf8' })
  assert.match(gateSql, /20260821030000/)
})

test('Formal.23 production CLI cannot use PATH Python or injected Python environment', () => {
  const candidateIndexTree = tree()
  const source = execFileSync('git', ['show', `${candidateIndexTree}:scripts/run-v106-production-cutover.mjs`], { cwd: root, encoding: 'utf8' })
  assert.match(source, /const trustedPython = loadTrustedPythonInterpreter/)
  assert.match(source, /const boundPythonEnvironment = buildBoundPythonEnvironment\(process\.env\)/)
  assert.equal((source.match(/spawnSync\(trustedPython\.path, \['-I', '-S', '-c'/g) ?? []).length, 3)
  assert.doesNotMatch(source, /spawnSync\('python'/)
})

test('Formal.22 production CLI executes all Python launchers from exact-tree source bytes', () => {
  const candidateIndexTree = tree()
  const source = execFileSync('git', ['show', `${candidateIndexTree}:scripts/run-v106-production-cutover.mjs`], { cwd: root, encoding: 'utf8' })
  assert.match(source, /const producerStartSource = loadBoundPythonSource/)
  assert.match(source, /const producerStopSource = loadBoundPythonSource/)
  assert.match(source, /const productionDbGateSource = loadBoundPythonSource/)
  assert.match(source, /spawnSync\(trustedPython\.path, \['-I', '-S', '-c', producerStartSource\]/)
  assert.match(source, /spawnSync\(trustedPython\.path, \['-I', '-S', '-c', producerStopSource\]/)
  assert.match(source, /spawnSync\(trustedPython\.path, \['-I', '-S', '-c', productionDbGateSource\]/)
})

test('Formal.22 production launcher source is loaded from the exact candidate Git tree', async () => {
  const runner = await import('../../scripts/run-v106-production-cutover.mjs')
  assert.equal(typeof runner.loadBoundPythonSource, 'function')
  const candidateIndexTree = tree()
  const source = runner.loadBoundPythonSource({
    candidateIndexTree,
    relativePath: manifest.productionCutoverRunner.producerStopScript,
    expectedBlob: manifest.productionCutoverRunner.producerStopScriptGitBlobSha1,
    root,
  })
  const exact = execFileSync('git', ['show', `${candidateIndexTree}:${manifest.productionCutoverRunner.producerStopScript}`], { cwd: root, encoding: 'utf8' })
  assert.equal(source, exact)
})

test('Formal.22 blocks before producer start when the actual stop launcher blob drifts', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    resolveArtifactBlob: ({ relativePath }) => relativePath === manifest.productionCutoverRunner.producerStopScript
      ? '0'.repeat(40)
      : manifest.productionCutoverRunner.producerStartScriptGitBlobSha1,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: productionDbGate,
    startProducer: async () => { producerCalls += 1; return { ok: true, generation, workerImageId: manifest.productionCutoverRunner.producerImageId } },
    stopProducer: stoppedProducer,
  }), /production_cutover_producer_stop_blob_drift/)
  assert.equal(producerCalls, 0)
})

test('Formal.28 proves exact identity before start and strict service readiness after start', async () => {
  const events = []
  const result = await runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    resolveCurrentTree: () => tree(),
    stopProducer: stoppedProducer,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async (options) => {
      events.push(['readiness', options.mode, options.url, options.expectedCommit, options.attempts])
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
    ['readiness', 'identity', manifest.canonicalPublicProxyUrl, head(), 30],
    ['db', 'pre'],
    ['producer', head(), generation],
    ['readiness', 'service', manifest.canonicalPublicProxyUrl, head(), 30],
    ['db', 'post'],
  ])
})

test('Formal.28 post-start strict readiness failure stops producer before rejecting', async () => {
  const events = []
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async ({ mode }) => {
      events.push(`readiness:${mode}`)
      if (mode === 'service') throw new Error('service_not_ready')
      return { verdict: 'PASS', consecutive: 2 }
    },
    verifyProductionDb: productionDbGate,
    startProducer: async () => { events.push('start'); return { ok: true, generation, workerImageId: manifest.productionCutoverRunner.producerImageId } },
    stopProducer: async () => { events.push('stop'); return { ok: true, stopped: true, activeState: 'inactive' } },
  }), /service_not_ready/)
  assert.deepEqual(events, ['readiness:identity', 'start', 'readiness:service', 'stop'])
})

test('Formal.21 bound cutover blocks producer when production DB provenance is missing', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    stopProducer: stoppedProducer,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: async () => ({ ok: false }),
    startProducer: async () => { producerCalls += 1; return { ok: true } },
  }), /production_cutover_db_provenance_not_proven/)
  assert.equal(producerCalls, 0)
})

test('Formal.21 bound cutover rejects mutable-tag image substitution and generation drift', async () => {
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    stopProducer: stoppedProducer,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: productionDbGate,
    startProducer: async () => ({ ok: true, generation, workerImageId: 'sha256:' + '0'.repeat(64) }),
  }), /production_cutover_producer_start_failed/)

  let calls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    stopProducer: stoppedProducer,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: async ({ phase }) => ({ ok: true, generation: phase === 'pre' ? generation : '22222222-2222-4222-8222-222222222222' }),
    startProducer: async () => { calls += 1; return { ok: true, generation, workerImageId: manifest.productionCutoverRunner.producerImageId } },
  }), /production_cutover_db_generation_drift/)
  assert.equal(calls, 1)
})

test('Formal.21 post-start DB generation drift fail-stops and verifies producer shutdown before rejecting', async () => {
  const events = []
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: async ({ phase }) => ({ ok: true, generation: phase === 'pre' ? generation : '22222222-2222-4222-8222-222222222222' }),
    startProducer: async () => { events.push('start'); return { ok: true, generation, workerImageId: manifest.productionCutoverRunner.producerImageId } },
    stopProducer: async () => { events.push('stop'); return { ok: true, stopped: true, activeState: 'inactive' } },
  }), /production_cutover_db_generation_drift/)
  assert.deepEqual(events, ['start', 'stop'])
})

test('Formal.21 producer start exception still triggers fail-stop compensation', async () => {
  let stops = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: productionDbGate,
    startProducer: async () => { throw new Error('remote_start_failed_after_systemd_start') },
    stopProducer: async () => { stops += 1; return { ok: true, stopped: true, activeState: 'inactive' } },
  }), /remote_start_failed_after_systemd_start/)
  assert.equal(stops, 1)
})

test('Formal.21 rejects the compensation itself unless shutdown is positively read back', async () => {
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => tree(),
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: productionDbGate,
    startProducer: async () => ({ ok: false }),
    stopProducer: async () => ({ ok: true, stopped: false, activeState: 'active' }),
  }), /production_cutover_post_start_compensation_failed/)
})

test('Formal.21 bound cutover never calls producer when exact public readiness blocks', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    resolveCurrentTree: () => tree(),
    stopProducer: stoppedProducer,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => { const error = new Error('blocked'); error.code = 'PUBLIC_PROXY_READINESS_BLOCK'; throw error },
    verifyProductionDb: productionDbGate,
    startProducer: async () => { producerCalls += 1; return { ok: true } },
  }), (error) => error?.code === 'PUBLIC_PROXY_READINESS_BLOCK')
  assert.equal(producerCalls, 0)
})

test('Formal.21 bound cutover rejects post-readiness tree drift before producer start', async () => {
  let producerCalls = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', root,
    resolveCurrentTree: () => '0'.repeat(40),
    stopProducer: stoppedProducer,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: head() }),
    verifyReadiness: async () => ({ verdict: 'PASS', consecutive: 2 }),
    verifyProductionDb: productionDbGate,
    startProducer: async () => { producerCalls += 1; return { ok: true } },
  }), /production_cutover_post_readiness_identity_drift/)
  assert.equal(producerCalls, 0)
})

test('Formal.21 bound cutover rejects an authorized commit that is not exact checked-out HEAD before probing or producer start', async () => {
  let sideEffects = 0
  await assert.rejects(runV106ProductionCutover({
    manifest, candidateIndexTree: tree(), attestationPath: 'mock-attestation', url: 'https://example.test', root,
    resolveCurrentTree: () => tree(),
    stopProducer: stoppedProducer,
    authorizeRelease: async () => ({ releaseAuthorized: true, commit: 'f'.repeat(40) }),
    verifyReadiness: async () => { sideEffects += 1; return { verdict: 'PASS', consecutive: 2 } },
    verifyProductionDb: async () => { sideEffects += 1; return { ok: true, generation } },
    startProducer: async () => { sideEffects += 1; return { ok: true } },
  }), /production_cutover_head_commit_mismatch/)
  assert.equal(sideEffects, 0)
})
