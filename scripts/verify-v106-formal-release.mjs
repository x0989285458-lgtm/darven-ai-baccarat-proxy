import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertCandidateIndexClean,
  assertExternalAttestationPath,
  computeGitTreePathSetDigest,
} from './verify-v105-mt-api-release.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_RELEASE_BINDINGS = Object.freeze([
  'implementationTree',
  'proxyBuildInput',
  'frontendBuildInput',
  'workerBuildInput',
  'databaseCutoverInput',
])
const DEPLOYABLE_BINDING_RULES = Object.freeze([
  { pattern: /^proxy\/(?:package(?:-lock)?\.json|src\/)/, bindings: ['implementationTree', 'proxyBuildInput'] },
  { pattern: /^proxy\/scripts\/run-tests\.mjs$/, bindings: ['implementationTree'] },
  { pattern: /^frontend\/(?:package(?:-lock)?\.json|src\/)/, bindings: ['implementationTree', 'frontendBuildInput'] },
  { pattern: /^cloud-browser-worker\/(?:Dockerfile|package(?:-lock)?\.json|src\/)/, bindings: ['implementationTree', 'workerBuildInput'] },
  { pattern: /^shared\//, bindings: ['implementationTree', 'proxyBuildInput', 'workerBuildInput'] },
  { pattern: /^supabase\/(?:migrations\/20260818010000_v106_formal_v10_main\.sql|operations\/(?:fence_v105_new_issuance|activate_v106_promotion|finalize_v106_promotion|rollback_v106_to_v105)\.sql)$/, bindings: ['implementationTree', 'databaseCutoverInput'] },
  { pattern: /^scripts\/(?:verify-v106-formal-release|run-worker-tests-scrubbed|test-env-scrub)\.mjs$/, bindings: ['implementationTree'] },
])

function pathIsBound(spec, candidatePath) {
  return spec?.paths?.some((boundPath) => candidatePath === boundPath || candidatePath.startsWith(`${boundPath}/`)) === true
}

export function verifyV106PredecessorRegression({ manifest, candidateIndexTree, root = repoRoot } = {}) {
  const spec = manifest?.predecessorRegression
  if (!spec || !/^[a-f0-9]{40}$/.test(spec.baseCommit ?? '') || !/^[a-f0-9]{64}$/.test(spec.sourceSha256 ?? '')) {
    throw new Error('predecessor_regression_binding_invalid')
  }
  for (const candidatePath of [spec.sourcePath, spec.executablePath]) {
    if (typeof candidatePath !== 'string' || !candidatePath || candidatePath.startsWith('/') || candidatePath.split('/').includes('..')) {
      throw new Error('predecessor_regression_path_invalid')
    }
  }
  const source = execFileSync('git', ['show', `${spec.baseCommit}:${spec.sourcePath}`], { cwd: root })
  const actual = createHash('sha256').update(source).digest('hex')
  if (actual !== spec.sourceSha256) throw new Error('predecessor_regression_source_mismatch')
  execFileSync('git', ['cat-file', '-e', `${candidateIndexTree}:${spec.executablePath}`], { cwd: root })
  return { ok: true, baseCommit: spec.baseCommit, sourceSha256: actual, executablePath: spec.executablePath }
}

export function resolveAnnotatedTagCommit({ tagName, root = repoRoot } = {}) {
  if (typeof tagName !== 'string' || !tagName) throw new Error('annotated_tag_name_missing')
  const tagRef = `refs/tags/${tagName}`
  const objectType = execFileSync('git', ['cat-file', '-t', tagRef], { cwd: root, encoding: 'utf8' }).trim()
  if (objectType !== 'tag') throw new Error('annotated_tag_required')
  return execFileSync('git', ['rev-parse', `${tagRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
}

export function verifyV106StagedDeployableCoverage({ manifest, root = repoRoot, stagedPaths } = {}) {
  const paths = stagedPaths ?? execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean)
  for (const candidatePath of paths) {
    const rule = DEPLOYABLE_BINDING_RULES.find(({ pattern }) => pattern.test(candidatePath))
    if (!rule) continue
    for (const bindingName of rule.bindings) {
      if (!pathIsBound(manifest?.releaseBinding?.[bindingName], candidatePath)) {
        throw new Error(`release_deployable_out_of_binding:${bindingName}:${candidatePath}`)
      }
    }
  }
  return {
    ok: true,
    paths: paths.filter((candidatePath) => DEPLOYABLE_BINDING_RULES.some(({ pattern }) => pattern.test(candidatePath))),
  }
}

export async function verifyV106ManifestDigests({ manifest, candidateIndexTree, root = repoRoot } = {}) {
  assertCandidateIndexClean(root, candidateIndexTree)
  verifyV106PredecessorRegression({ manifest, candidateIndexTree, root })
  const binding = manifest?.releaseBinding
  if (!binding) throw new Error('release_binding_missing')
  for (const name of REQUIRED_RELEASE_BINDINGS) {
    if (!Object.hasOwn(binding, name)) throw new Error(`release_binding_missing:${name}`)
  }
  verifyV106StagedDeployableCoverage({ manifest, root })
  const result = {}
  for (const [name, spec] of Object.entries(binding)) {
    if (!spec || spec.algorithm !== 'sha256' || !Array.isArray(spec.paths) || !/^[a-f0-9]{64}$/.test(spec.sha256 ?? '')) {
      throw new Error(`release_binding_invalid:${name}`)
    }
    const actual = await computeGitTreePathSetDigest(root, candidateIndexTree, spec)
    if (actual.sha256 !== spec.sha256) throw new Error(`release_binding_mismatch:${name}`)
    result[name] = actual.sha256
  }
  return { ok: true, mode: 'precommit-digests-only', releaseAuthorized: false, candidateIndexTree, digests: result }
}

export async function verifyV106Attestation({ manifest, candidateIndexTree, attestationPath, root = repoRoot } = {}) {
  const digests = await verifyV106ManifestDigests({ manifest, candidateIndexTree, root })
  const externalPath = await assertExternalAttestationPath({ repoRoot: root, attestationPath })
  const attestation = JSON.parse(await readFile(externalPath, 'utf8'))
  if (attestation.releaseVersion !== manifest.releaseVersion) throw new Error('attestation_release_mismatch')
  if (attestation.tagName !== manifest.gitTag) throw new Error('attestation_tag_mismatch')
  if (attestation.candidateIndexTree !== candidateIndexTree) throw new Error('attestation_tree_mismatch')
  const expectedDigests = digests.digests
  const attestedDigests = attestation.digests
  if (!attestedDigests || typeof attestedDigests !== 'object' || Array.isArray(attestedDigests)) throw new Error('attestation_digests_missing')
  const expectedDigestKeys = Object.keys(expectedDigests).sort()
  const attestedDigestKeys = Object.keys(attestedDigests).sort()
  if (JSON.stringify(attestedDigestKeys) !== JSON.stringify(expectedDigestKeys)) throw new Error('attestation_digests_key_mismatch')
  for (const name of expectedDigestKeys) {
    if (attestedDigests[name] !== expectedDigests[name]) throw new Error(`attestation_digest_mismatch:${name}`)
  }
  const commit = resolveAnnotatedTagCommit({ tagName: manifest.gitTag, root })
  const tree = execFileSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: root, encoding: 'utf8' }).trim()
  if (attestation.commit !== commit || tree !== candidateIndexTree) throw new Error('attestation_commit_tree_mismatch')
  return { ...digests, mode: 'external-attestation', releaseAuthorized: true, commit, tagName: manifest.gitTag }
}

async function main() {
  const args = process.argv.slice(2)
  const get = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const candidateIndexTree = get('--candidate-index-tree')
  const attestationPath = get('--attestation')
  const digestsOnly = args.includes('--digests-only')
  if (!attestationPath && !digestsOnly) throw new Error('attestation_required')
  if (attestationPath && digestsOnly) throw new Error('attestation_and_digests_only_are_mutually_exclusive')
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'release', 'v106-formal-v10-main-release-manifest.json'), 'utf8'))
  const result = digestsOnly
    ? await verifyV106ManifestDigests({ manifest, candidateIndexTree })
    : await verifyV106Attestation({ manifest, candidateIndexTree, attestationPath })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
