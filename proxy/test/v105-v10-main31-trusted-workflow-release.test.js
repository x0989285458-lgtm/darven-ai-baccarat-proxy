import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../../', import.meta.url)
const rootPath = fileURLToPath(root)
const tagBytes = (path) => execFileSync('git', ['show', `v105-v10-main.32:${path}`], { cwd: rootPath })
const read = (path) => tagBytes(path).toString('utf8')
const readJson = (path) => JSON.parse(read(path))
const sha256Candidates = (path) => {
  const bytes = tagBytes(path)
  const crlf = Buffer.from(bytes.toString('utf8').replace(/\r?\n/g, '\r\n'))
  return [bytes, crlf].map((value) => createHash('sha256').update(value).digest('hex'))
}
const allowedChangedPaths = [
  '.github/workflows/trusted-release-images-main31.yml',
  'proxy/test/v105-mt-api-release-binding.test.js',
  'proxy/test/v105-v10-main-release.test.js',
  'proxy/test/v105-v10-main31-trusted-workflow-release.test.js',
  'release/v105-v10-main31-trusted-workflow-release-manifest.json',
  'release/v105-v10-main31-trusted-workflow-release-report.json',
]
const hasExactChangedPaths = (actual) => actual.length === allowedChangedPaths.length
  && actual.every((path, index) => path === allowedChangedPaths[index])

test('Main31 trusted workflow builds and attests all roles only from the exact frozen tag', () => {
  const workflow = read('.github/workflows/trusted-release-images-main31.yml')
  assert.equal(workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:')).trim(), [
    'on:',
    '  push:',
    '    tags:',
    '      - v105-v10-main.31',
  ].join('\n'))
  assert.match(workflow, /tags:\s*\n\s*- v105-v10-main\.31/)
  assert.match(workflow, /github\.ref == 'refs\/tags\/v105-v10-main\.31'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.31/)
  assert.match(workflow, /test "\$\{GITHUB_REF\}" = "refs\/tags\/v105-v10-main\.31"/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\^\)" = "1cfc2cd494fd02b288263ab4dfa0eb7434b6effe"/)
  assert.match(workflow, /fetch-depth: 2/)
  assert.match(workflow, /mapfile -d '' -t changed_paths < <\(git diff --name-only -z HEAD\^ HEAD \| LC_ALL=C sort -z\)/)
  assert.match(workflow, /test "\$\{#changed_paths\[@\]\}" -eq "\$\{#expected_paths\[@\]\}"/)
  assert.match(workflow, /for index in "\$\{!expected_paths\[@\]\}"/)
  assert.match(workflow, /test "\$\{changed_paths\[\$\{index\}\]\}" = "\$\{expected_paths\[\$\{index\}\]\}"/)
  for (const path of allowedChangedPaths) assert.match(workflow, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const role of ['proxy', 'formal-consumer', 'worker']) assert.match(workflow, new RegExp(`role: ${role}`))
  for (const image of ['darven-ai-baccarat-proxy', 'darven-ai-baccarat-formal-consumer', 'darven-ai-baccarat-worker']) assert.match(workflow, new RegExp(`image: ${image}`))
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/)
  assert.match(workflow, /docker\/setup-buildx-action@[0-9a-f]{40}/)
  assert.match(workflow, /docker\/login-action@[0-9a-f]{40}/)
  assert.match(workflow, /docker\/build-push-action@[0-9a-f]{40}/)
  assert.match(workflow, /actions\/attest-build-provenance@[0-9a-f]{40}/)
  assert.match(workflow, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/)
  assert.match(workflow, /gh attestation verify "oci:\/\/\$\{SUBJECT_NAME\}@\$\{IMAGE_DIGEST\}"/)
  assert.match(workflow, /--repo "\$\{GITHUB_REPOSITORY\}"/)
  assert.match(workflow, /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/trusted-release-images-main31\.yml"/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  assert.doesNotMatch(workflow, /pull_request|workflow_dispatch/)
  assert.doesNotMatch(workflow, /:latest(?:\s|$)/m)

  assert.equal(hasExactChangedPaths(allowedChangedPaths), true)
  assert.equal(hasExactChangedPaths(allowedChangedPaths.slice(1)), false)
  assert.equal(hasExactChangedPaths([...allowedChangedPaths, 'extra']), false)
  assert.equal(hasExactChangedPaths(['.github/workflows/trusted-release-images-main31.yml proxy/test/v105-mt-api-release-binding.test.js', ...allowedChangedPaths.slice(2)]), false)
  assert.equal(hasExactChangedPaths(allowedChangedPaths.with(1, 'replacement')), false)
})

test('Main31 is workflow-only over the immutable Main30 runtime', () => {
  const historicalMainReleaseTest = read('proxy/test/v105-v10-main-release.test.js')
  const historicalWorkflowTest = historicalMainReleaseTest.slice(historicalMainReleaseTest.indexOf("test('V105 Main26 trusted workflow"))
  assert.match(historicalWorkflowTest, /rev-parse', 'v105-v10-main\.26\^\{tree\}'/)
  assert.doesNotMatch(historicalWorkflowTest, /write-tree/)

  const manifest = readJson('release/v105-v10-main31-trusted-workflow-release-manifest.json')
  assert.equal(manifest.releaseVersion, 'v105-v10-main.31')
  assert.equal(manifest.gitTag, 'v105-v10-main.31')
  assert.equal(manifest.applicationVersion, '1.0.66')
  assert.equal(manifest.baseCommit, '1cfc2cd494fd02b288263ab4dfa0eb7434b6effe')
  assert.equal(manifest.runtimeSourceVersion, 'v105-v10-main.30')
  assert.equal(manifest.releaseScope.runtimeCodeChanged, false)
  assert.equal(manifest.releaseScope.trustedWorkflowAdded, true)
  assert.equal(manifest.releaseScope.releaseVerificationChanged, true)
  assert.equal(manifest.workflowContract.mutableLatestTag, false)
  assert.equal(manifest.workflowContract.requiredParentCommit, '1cfc2cd494fd02b288263ab4dfa0eb7434b6effe')
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, allowedChangedPaths)
  assert.deepEqual(manifest.workflowContract.provenanceReadbackRequiredFields, [
    'repository', 'workflowRef', 'commitSha', 'subjectName', 'subjectDigest',
  ])
  assert.deepEqual(manifest.workflowContract.provenanceReadbackContract, {
    phase: 'post-attestation-pre-deployment',
    verifier: 'gh attestation verify',
    repository: 'x0989285458-lgtm/darven-ai-baccarat-proxy',
    workflowRef: 'x0989285458-lgtm/darven-ai-baccarat-proxy/.github/workflows/trusted-release-images-main31.yml',
    sourceRef: 'refs/tags/v105-v10-main.31',
    commitSha: 'resolved-tag-commit-equals-github-sha',
    roleSubjects: {
      proxy: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy',
      'formal-consumer': 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer',
      worker: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker',
    },
    abortOnMismatch: true,
  })
  for (const [path, expected] of Object.entries(manifest.releaseBinding.changedFileSha256)) {
    assert.ok(sha256Candidates(path).includes(expected), path)
  }
})

test('Main31 records Main30 build blocker and cannot self-approve production', () => {
  const report = readJson('release/v105-v10-main31-trusted-workflow-release-report.json')
  assert.equal(report.evidence.main30RemoteTagReadback, 'PASS')
  assert.equal(report.evidence.main30WorkflowRunFound, false)
  assert.equal(report.evidence.main30RuntimeTests, '1030/1030 PASS')
  assert.equal(report.scope.runtimeCodeChanged, false)
  assert.equal(report.scope.releaseVerificationChanged, true)
  assert.equal(report.productionGates.finalVerdict, 'BLOCK')
  assert.ok(Object.values(report.productionGates).every((value) => value !== 'PASS'))
})
