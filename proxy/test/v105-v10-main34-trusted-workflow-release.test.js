import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const workflowPath = '.github/workflows/trusted-release-images-main34.yml'
const manifestPath = 'release/v105-v10-main34-trusted-workflow-release-manifest.json'
const reportPath = 'release/v105-v10-main34-trusted-workflow-release-report.json'
const verifierPath = path.join(root, 'scripts', 'verify-trusted-release-delta.sh')
const expectedPaths = [
  '.github/workflows/trusted-release-images-main34.yml',
  'proxy/test/v105-v10-main34-trusted-workflow-release.test.js',
  'release/v105-v10-main34-trusted-workflow-release-manifest.json',
  'release/v105-v10-main34-trusted-workflow-release-report.json',
]
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8')
const readJson = async (relativePath) => JSON.parse(await read(relativePath))
const readIndexBlob = (relativePath) => execFileSync('git', ['show', `:${relativePath}`], { cwd: root })

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function verify(cwd, head, parent, paths = ['release.txt']) {
  return spawnSync('bash', [verifierPath, head, parent, ...paths], { cwd, encoding: 'utf8' })
}

test('Main34 verifier contract accepts head-parent order and rejects the Main33 reversed order', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'main34-verifier-'))
  try {
    git(repo, ['init'])
    git(repo, ['config', 'user.name', 'Main34 Test'])
    git(repo, ['config', 'user.email', 'main34@example.invalid'])
    writeFileSync(path.join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    const parent = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(path.join(repo, 'release.txt'), 'release\n')
    git(repo, ['add', 'release.txt'])
    git(repo, ['commit', '-m', 'release'])
    const head = git(repo, ['rev-parse', 'HEAD'])
    assert.equal(verify(repo, head, parent).status, 0)
    assert.notEqual(verify(repo, parent, head).status, 0)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('Main34 workflow passes head before required parent and preserves exact trusted build gates', async () => {
  const workflow = (await read(workflowPath)).replace(/\r\n/g, '\n')
  assert.equal(workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:')).trim(), [
    'on:', '  push:', '    tags:', '      - v105-v10-main.34',
  ].join('\n'))
  assert.match(workflow, /if: github\.ref == 'refs\/tags\/v105-v10-main\.34'/)
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.34/)
  const invocationStart = workflow.indexOf('bash scripts/verify-trusted-release-delta.sh')
  const invocationEnd = workflow.indexOf('\n\n      - name:', invocationStart)
  assert.ok(invocationStart >= 0 && invocationEnd > invocationStart)
  const verifierArgs = workflow.slice(invocationStart, invocationEnd)
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/\s+\\$/, ''))
  const expectedVerifierArgs = [
    '"${GITHUB_SHA}"',
    '9510ed1b97b1ecc9f87a861944f11da8fbb4d088',
    ...expectedPaths,
  ]
  assert.deepEqual(verifierArgs, expectedVerifierArgs)
  assert.throws(() => assert.deepEqual([...verifierArgs, 'outside.txt'], expectedVerifierArgs))
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
})

test('Main34 manifest is workflow-only over immutable Main33 and binds Git index blobs', async () => {
  const manifest = await readJson(manifestPath)
  const report = await readJson(reportPath)
  assert.equal(manifest.releaseVersion, 'v105-v10-main.34')
  assert.equal(manifest.gitTag, 'v105-v10-main.34')
  assert.equal(manifest.baseCommit, '9510ed1b97b1ecc9f87a861944f11da8fbb4d088')
  assert.equal(manifest.runtimeSourceVersion, 'v105-v10-main.33')
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedPaths)
  assert.equal(Object.values(manifest.releaseScope).filter(Boolean).length, 1)
  assert.equal(manifest.releaseScope.trustedWorkflowChanged, true)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256).sort(), expectedPaths.filter((p) => p !== manifestPath).sort())
  for (const [relativePath, expected] of Object.entries(manifest.releaseBinding.changedFileSha256)) {
    assert.equal(createHash('sha256').update(readIndexBlob(relativePath)).digest('hex'), expected, relativePath)
  }
  assert.equal(report.releaseVersion, 'v105-v10-main.34')
  assert.equal(report.main33FormalRun, 'BLOCK')
  assert.equal(report.productionGates.finalVerdict, 'BLOCK')
  assert.ok(Object.values(report.productionGates).every((value) => value !== 'PASS'))
})
