import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyV106Attestation, verifyV106PublicReadinessContract, resolveAnnotatedTagCommit } from './verify-v106-formal-release.mjs'
import { verifyV106PublicReadiness } from './verify-v106-public-readiness.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXTERNAL_TRUST_POLICY_PATH = 'D:/AI Hermes/release-trust/v106-production-policy.json'

export function loadTrustedPythonInterpreter({ root = repoRoot } = {}) {
  const candidateRoot = realpathSync(root)
  const policyPath = realpathSync(EXTERNAL_TRUST_POLICY_PATH)
  const policyRelative = path.relative(candidateRoot, policyPath)
  if (policyRelative === '' || (!policyRelative.startsWith('..') && !path.isAbsolute(policyRelative))) {
    throw new Error('external_python_trust_policy_required')
  }
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
  if (policy.pythonIsolatedModeRequired !== true || policy.pythonNoSiteRequired !== true || !/^[a-f0-9]{64}$/.test(policy.pythonInterpreterSha256 ?? '')) {
    throw new Error('trusted_python_policy_invalid')
  }
  const interpreterPath = realpathSync(policy.pythonInterpreterPath)
  const interpreterRelative = path.relative(candidateRoot, interpreterPath)
  if (interpreterRelative === '' || (!interpreterRelative.startsWith('..') && !path.isAbsolute(interpreterRelative))) {
    throw new Error('trusted_python_must_be_external')
  }
  const actualSha256 = createHash('sha256').update(readFileSync(interpreterPath)).digest('hex')
  if (actualSha256 !== policy.pythonInterpreterSha256) throw new Error('trusted_python_sha256_mismatch')
  return { path: interpreterPath, sha256: actualSha256, policyPath }
}

export function buildBoundPythonEnvironment(baseEnvironment = {}) {
  const environment = {}
  for (const [key, value] of Object.entries(baseEnvironment)) {
    const upper = key.toUpperCase()
    if (upper.startsWith('PYTHON') || upper === 'VIRTUAL_ENV') continue
    environment[key] = value
  }
  return { ...environment, PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
}

export function loadBoundPythonSource({ candidateIndexTree, relativePath, expectedBlob, root = repoRoot } = {}) {
  if (!/^[a-f0-9]{40}$/.test(candidateIndexTree ?? '') || !/^[a-f0-9]{40}$/.test(expectedBlob ?? '')) {
    throw new Error('bound_python_source_identity_invalid')
  }
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('..')) {
    throw new Error('bound_python_source_path_invalid')
  }
  const actualBlob = execFileSync('git', ['rev-parse', `${candidateIndexTree}:${relativePath}`], { cwd: root, encoding: 'utf8' }).trim()
  if (actualBlob !== expectedBlob) throw new Error('bound_python_source_blob_mismatch')
  return execFileSync('git', ['show', `${candidateIndexTree}:${relativePath}`], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })
}

export async function runV106ProductionCutover({
  manifest,
  candidateIndexTree,
  attestationPath,
  authorizeRelease = (options) => verifyV106Attestation(options),
  verifyReadiness = verifyV106PublicReadiness,
  startProducer,
  stopProducer,
  verifyProductionDb,
  resolveCurrentTree = ({ root: currentRoot }) => execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: currentRoot, encoding: 'utf8' }).trim(),
  resolveArtifactBlob = ({ relativePath, root: currentRoot }) => execFileSync('git', ['hash-object', relativePath], { cwd: currentRoot, encoding: 'utf8' }).trim(),
  onProbe = () => {},
  root = repoRoot,
} = {}) {
  if (typeof startProducer !== 'function') throw new Error('producer_start_callback_required')
  if (typeof stopProducer !== 'function') throw new Error('producer_stop_callback_required')
  if (typeof verifyProductionDb !== 'function') throw new Error('production_db_gate_callback_required')
  verifyV106PublicReadinessContract({ manifest, candidateIndexTree, root })
  const authorization = await authorizeRelease({ manifest, candidateIndexTree, attestationPath, root })
  if (authorization?.releaseAuthorized !== true || !/^[a-f0-9]{40}$/.test(authorization?.commit ?? '')) {
    throw new Error('production_cutover_release_not_authorized')
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (head !== authorization.commit) throw new Error('production_cutover_head_commit_mismatch')
  const gate = manifest.publicReadinessGate
  const readiness = await verifyReadiness({
    url: manifest.canonicalPublicProxyUrl,
    expectedRelease: manifest.releaseVersion,
    expectedPackage: manifest.applicationVersion,
    expectedCommit: authorization.commit,
    consecutive: gate.requiredConsecutive,
    attempts: gate.boundedAttempts,
    intervalMs: gate.intervalMs,
    requestTimeoutMs: gate.requestTimeoutMs,
    onProbe,
  })
  if (readiness?.verdict !== 'PASS' || readiness?.consecutive < gate.requiredConsecutive) {
    throw new Error('production_cutover_public_readiness_not_proven')
  }
  const postReadinessHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const postReadinessTree = resolveCurrentTree({ root })
  const producerScript = manifest.productionCutoverRunner.producerStartScript
  const producerStopScript = manifest.productionCutoverRunner.producerStopScript
  const productionDbGateScript = manifest.productionCutoverRunner.productionDbGateScript
  const producerBlob = resolveArtifactBlob({ relativePath: producerScript, root })
  const producerStopBlob = resolveArtifactBlob({ relativePath: producerStopScript, root })
  const productionDbGateBlob = resolveArtifactBlob({ relativePath: productionDbGateScript, root })
  if (postReadinessHead !== authorization.commit || postReadinessTree !== candidateIndexTree) {
    throw new Error('production_cutover_post_readiness_identity_drift')
  }
  if (producerBlob !== manifest.productionCutoverRunner.producerStartScriptGitBlobSha1) {
    throw new Error('production_cutover_producer_blob_drift')
  }
  if (producerStopBlob !== manifest.productionCutoverRunner.producerStopScriptGitBlobSha1) {
    throw new Error('production_cutover_producer_stop_blob_drift')
  }
  if (productionDbGateBlob !== manifest.productionCutoverRunner.productionDbGateScriptGitBlobSha1) {
    throw new Error('production_cutover_db_gate_blob_drift')
  }
  const preDbGate = await verifyProductionDb({ phase: 'pre', releaseVersion: manifest.releaseVersion, packageVersion: manifest.applicationVersion })
  if (preDbGate?.ok !== true || !/^[0-9a-f-]{36}$/.test(preDbGate?.generation ?? '')) {
    throw new Error('production_cutover_db_provenance_not_proven')
  }
  let producer
  try {
    producer = await startProducer({
      releaseVersion: manifest.releaseVersion,
      packageVersion: manifest.applicationVersion,
      commit: authorization.commit,
      generation: preDbGate.generation,
      readiness,
    })
    if (producer?.ok !== true
        || producer?.generation !== preDbGate.generation
        || producer?.workerImageId !== manifest.productionCutoverRunner.producerImageId) {
      throw new Error('production_cutover_producer_start_failed')
    }
    const postDbGate = await verifyProductionDb({ phase: 'post', releaseVersion: manifest.releaseVersion, packageVersion: manifest.applicationVersion })
    if (postDbGate?.ok !== true || postDbGate?.generation !== preDbGate.generation) {
      throw new Error('production_cutover_db_generation_drift')
    }
    return { verdict: 'PASS', releaseAuthorized: true, commit: authorization.commit, readiness, preDbGate, producer, postDbGate }
  } catch (error) {
    let stopped
    try {
      stopped = await stopProducer({
        releaseVersion: manifest.releaseVersion,
        packageVersion: manifest.applicationVersion,
        commit: authorization.commit,
        generation: preDbGate.generation,
        reason: error?.message ?? 'post_start_gate_failed',
      })
    } catch (stopError) {
      throw new Error('production_cutover_post_start_compensation_failed', { cause: stopError })
    }
    if (stopped?.ok !== true || stopped?.stopped !== true || stopped?.activeState !== 'inactive') {
      throw new Error('production_cutover_post_start_compensation_failed', { cause: error })
    }
    error.compensation = stopped
    throw error
  }
}

async function main() {
  const args = process.argv.slice(2)
  const get = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const attestationPath = get('--attestation')
  if (!attestationPath) throw new Error('attestation_required')
  if (args.includes('--producer-start-script')) throw new Error('producer_start_script_override_forbidden')
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'release', 'v106-formal-v10-main-release-manifest.json'), 'utf8'))
  const trustedPython = loadTrustedPythonInterpreter({ root: repoRoot })
  const assertTrustedPythonUnchanged = () => {
    const current = loadTrustedPythonInterpreter({ root: repoRoot })
    if (current.path !== trustedPython.path || current.sha256 !== trustedPython.sha256) throw new Error('trusted_python_identity_drift')
  }
  const boundPythonEnvironment = buildBoundPythonEnvironment(process.env)
  const producerStartScript = path.resolve(repoRoot, manifest.productionCutoverRunner.producerStartScript)
  const producerStopScript = path.resolve(repoRoot, manifest.productionCutoverRunner.producerStopScript)
  const productionDbGateScript = path.resolve(repoRoot, manifest.productionCutoverRunner.productionDbGateScript)
  if (producerStartScript !== path.join(repoRoot, 'scripts', 'start-v106-formal-producer.py')) {
    throw new Error('bound_producer_start_script_mismatch')
  }
  if (producerStopScript !== path.join(repoRoot, 'scripts', 'stop-v106-formal-producer.py')) {
    throw new Error('bound_producer_stop_script_mismatch')
  }
  if (productionDbGateScript !== path.join(repoRoot, 'scripts', 'verify-v106-production-db-gate.py')) {
    throw new Error('bound_production_db_gate_script_mismatch')
  }
  const tagCommit = resolveAnnotatedTagCommit({ tagName: manifest.gitTag, root: repoRoot })
  const candidateIndexTree = execFileSync('git', ['rev-parse', `${tagCommit}^{tree}`], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const producerStartSource = loadBoundPythonSource({ candidateIndexTree, relativePath: manifest.productionCutoverRunner.producerStartScript, expectedBlob: manifest.productionCutoverRunner.producerStartScriptGitBlobSha1, root: repoRoot })
  const producerStopSource = loadBoundPythonSource({ candidateIndexTree, relativePath: manifest.productionCutoverRunner.producerStopScript, expectedBlob: manifest.productionCutoverRunner.producerStopScriptGitBlobSha1, root: repoRoot })
  const productionDbGateSource = loadBoundPythonSource({ candidateIndexTree, relativePath: manifest.productionCutoverRunner.productionDbGateScript, expectedBlob: manifest.productionCutoverRunner.productionDbGateScriptGitBlobSha1, root: repoRoot })
  const result = await runV106ProductionCutover({
    manifest, candidateIndexTree, attestationPath, root: repoRoot,
    onProbe: (probe) => process.stdout.write(`${JSON.stringify({ type: 'public-readiness-probe', ...probe })}\n`),
    verifyProductionDb: async (identity) => {
      assertTrustedPythonUnchanged()
      const child = spawnSync(trustedPython.path, ['-I', '-S', '-c', productionDbGateSource], {
        cwd: repoRoot, encoding: 'utf8', env: {
          ...boundPythonEnvironment,
          V106_RELEASE_VERSION: identity.releaseVersion,
          V106_PACKAGE_VERSION: identity.packageVersion,
          V106_DB_GATE_PHASE: identity.phase,
        },
      })
      const lines = String(child.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const payload = lines.length ? JSON.parse(lines.at(-1)) : null
      if (child.status !== 0) process.stderr.write(String(child.stderr ?? ''))
      return child.status === 0 && payload ? payload : { ok: false, exitCode: child.status }
    },
    startProducer: async (identity) => {
      assertTrustedPythonUnchanged()
      const child = spawnSync(trustedPython.path, ['-I', '-S', '-c', producerStartSource], {
        cwd: repoRoot, encoding: 'utf8', env: {
          ...boundPythonEnvironment,
          V106_RELEASE_VERSION: identity.releaseVersion,
          V106_PACKAGE_VERSION: identity.packageVersion,
          V106_RELEASE_COMMIT: identity.commit,
          V106_CUTOVER_GENERATION: identity.generation,
        },
      })
      process.stdout.write(String(child.stdout ?? ''))
      if (child.status !== 0) process.stderr.write(String(child.stderr ?? ''))
      const lines = String(child.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const payload = lines.length ? JSON.parse(lines.at(-1)) : null
      return child.status === 0 && payload ? payload : { ok: false, exitCode: child.status }
    },
    stopProducer: async (identity) => {
      assertTrustedPythonUnchanged()
      const child = spawnSync(trustedPython.path, ['-I', '-S', '-c', producerStopSource], {
        cwd: repoRoot, encoding: 'utf8', env: {
          ...boundPythonEnvironment,
          V106_RELEASE_VERSION: identity.releaseVersion,
          V106_PACKAGE_VERSION: identity.packageVersion,
          V106_RELEASE_COMMIT: identity.commit,
          V106_CUTOVER_GENERATION: identity.generation,
        },
      })
      process.stdout.write(String(child.stdout ?? ''))
      if (child.status !== 0) process.stderr.write(String(child.stderr ?? ''))
      const lines = String(child.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const payload = lines.length ? JSON.parse(lines.at(-1)) : null
      return child.status === 0 && payload ? payload : { ok: false, stopped: false, exitCode: child.status }
    },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 2
  })
}
