import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
const verifier = path.join(root, 'scripts', 'verify-trusted-release-delta.sh')
const workflowPath = path.join(root, '.github', 'workflows', 'trusted-release-images-main32.yml')
const expectedPaths = [
  '.github/workflows/trusted-release-images-main32.yml',
  'proxy/test/v105-v10-main32-trusted-workflow-release.test.js',
  'release/v105-v10-main32-trusted-workflow-release-manifest.json',
  'release/v105-v10-main32-trusted-workflow-release-report.json',
  'scripts/verify-trusted-release-delta.sh',
]

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'main32-release-delta-'))
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.invalid'])
  git(cwd, ['config', 'user.name', 'test'])
  await writeFile(path.join(cwd, 'base.txt'), 'base\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  return cwd
}

function verify(cwd, parent, head, paths = expectedPaths, env = {}) {
  return spawnSync('bash', [verifier, head, parent, ...paths], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  })
}

test('Main32 workflow delegates exact delta verification to the pinned fail-closed script', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  assert.equal(workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:')).trim(), [
    'on:', '  push:', '    tags:', '      - v105-v10-main.32',
  ].join('\n'))
  assert.match(workflow, /ref: refs\/tags\/v105-v10-main\.32/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /verify-trusted-release-delta\.sh/)
  assert.match(workflow, /8f6e490677d3e38ffc8468c3a911c62a7b62a901/)
  for (const changedPath of expectedPaths) assert.match(workflow, new RegExp(changedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(workflow, /gh attestation verify/)
  assert.match(workflow, /--source-digest "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /--source-ref "\$\{GITHUB_REF\}"/)
  assert.match(workflow, /--deny-self-hosted-runners/)
  const invocation = workflow.match(/bash scripts\/verify-trusted-release-delta\.sh \\\n([\s\S]*?)\n\n      - name: Set up Docker Buildx/)
  assert.ok(invocation)
  const invocationArgs = invocation[1].split('\n').map((line) => line.trim().replace(/ \\$/, '')).filter(Boolean)
  assert.deepEqual(invocationArgs, [
    '"${GITHUB_SHA}"',
    '8f6e490677d3e38ffc8468c3a911c62a7b62a901',
    ...expectedPaths,
  ])
})

test('release delta verifier accepts only the complete exact allowlist', async () => {
  const cwd = await fixture()
  try {
    const parent = git(cwd, ['rev-parse', 'HEAD'])
    for (const changedPath of expectedPaths) {
      const target = path.join(cwd, changedPath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `${changedPath}\n`)
    }
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'candidate'])
    const head = git(cwd, ['rev-parse', 'HEAD'])
    const result = verify(cwd, parent, head)
    assert.equal(result.status, 0, result.stderr)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('release delta verifier rejects rename from outside the allowlist', async () => {
  const cwd = await fixture()
  try {
    await writeFile(path.join(cwd, 'outside.txt'), 'same bytes\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'outside source'])
    const parent = git(cwd, ['rev-parse', 'HEAD'])
    const allowed = expectedPaths[0]
    await mkdir(path.dirname(path.join(cwd, allowed)), { recursive: true })
    git(cwd, ['mv', 'outside.txt', allowed])
    git(cwd, ['commit', '-m', 'rename attempt'])
    const head = git(cwd, ['rev-parse', 'HEAD'])
    const result = verify(cwd, parent, head, [allowed])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /release delta differs from exact allowlist/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('release delta verifier propagates git diff failure', async () => {
  const cwd = await fixture()
  try {
    const head = git(cwd, ['rev-parse', 'HEAD'])
    const result = verify(cwd, '0'.repeat(40), head, ['base.txt'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /fatal:|bad object|unknown revision|ambiguous argument/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('release delta verifier propagates sort failure', async () => {
  const cwd = await fixture()
  try {
    const parent = git(cwd, ['rev-parse', 'HEAD'])
    await writeFile(path.join(cwd, 'base.txt'), 'changed\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'candidate'])
    const head = git(cwd, ['rev-parse', 'HEAD'])
    const shim = path.join(cwd, 'shim')
    await mkdir(shim)
    const realSort = execFileSync('bash', ['-lc', 'command -v sort'], { encoding: 'utf8' }).trim()
    const counter = path.join(cwd, 'sort-count')
    await writeFile(path.join(shim, 'sort'), `#!/usr/bin/env bash\ncount=0\n[[ -f '${counter}' ]] && count=$(cat '${counter}')\ncount=$((count + 1))\nprintf '%s' "$count" > '${counter}'\nif [[ "$count" -eq 1 ]]; then exec '${realSort}' "$@"; fi\nexit 41\n`, { mode: 0o755 })
    const result = verify(cwd, parent, head, ['base.txt'], { PATH: `${shim}${path.delimiter}${process.env.PATH}` })
    assert.notEqual(result.status, 0)
    assert.equal(await readFile(counter, 'utf8'), '2')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Main32 manifest binds the exact release-gate files without changing runtime', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'release', 'v105-v10-main32-trusted-workflow-release-manifest.json'), 'utf8'))
  assert.equal(manifest.releaseVersion, 'v105-v10-main.32')
  assert.equal(manifest.baseCommit, '8f6e490677d3e38ffc8468c3a911c62a7b62a901')
  assert.equal(manifest.runtimeSourceVersion, 'v105-v10-main.30')
  assert.equal(manifest.releaseScope.runtimeCodeChanged, false)
  assert.equal(manifest.workflowContract.renameDetectionDisabled, true)
  assert.equal(manifest.workflowContract.pipelineFailurePropagated, true)
  assert.deepEqual(manifest.workflowContract.allowedChangedPaths, expectedPaths)
  assert.deepEqual(Object.keys(manifest.releaseBinding.changedFileSha256).sort(), expectedPaths.filter((value) => !value.endsWith('manifest.json')).sort())
  for (const [changedPath, expected] of Object.entries(manifest.releaseBinding.changedFileSha256)) {
    const bytes = await readFile(path.join(root, changedPath))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, changedPath)
  }
})

test('Main32 report records Main31 BLOCK and cannot self-approve production', async () => {
  const report = JSON.parse(await readFile(path.join(root, 'release', 'v105-v10-main32-trusted-workflow-release-report.json'), 'utf8'))
  assert.match(report.evidence.main31FreshReview, /^BLOCK:/)
  assert.equal(report.evidence.main32FocusedShellGates, '5/5 PASS')
  assert.equal(report.scope.runtimeCodeChanged, false)
  assert.equal(report.productionGates.finalVerdict, 'BLOCK')
  assert.deepEqual(Object.keys(report.productionGates), [
    'freshReview', 'trustedImageBuild', 'localProvenanceReadback', 'formalConsumerDeployment',
    'queueRecovery', 'tenMinuteLiveWindow', 'browserE2E', 'finalVerdict',
  ])
  assert.ok(Object.values(report.productionGates).every((value) => value !== 'PASS'))
})
