import path from 'node:path'
import { readdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { buildScrubbedTestEnv } from '../../scripts/test-env-scrub.mjs'

const candidateIndexTree = execFileSync('git', ['write-tree'], { encoding: 'utf8' }).trim()
const env = buildScrubbedTestEnv()
env.V106_CANDIDATE_INDEX_TREE = candidateIndexTree

function listJavaScriptFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(absolute))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute)
  }
  return files
}

function run(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...files], { env, stdio: 'inherit', shell: false })
    child.once('error', (error) => {
      process.stderr.write(`test runner failed: ${error?.message ?? String(error)}\n`)
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      if (signal) {
        process.stderr.write(`test runner stopped by ${signal}\n`)
        resolve(1)
        return
      }
      resolve(Number.isInteger(code) ? code : 1)
    })
  })
}

const requested = process.argv.slice(2)
if (requested.length) {
  process.exitCode = await run(requested)
} else {
  const isolated = path.resolve('test', 'shadow-process-isolation.test.js')
  const discovered = [
    path.resolve('src', 'test-report-persistence.js'),
    ...listJavaScriptFiles(path.resolve('test')),
  ].filter((file) => file !== isolated)
  // Keep confirmed and deliberately-unconfirmed child lifecycle fixtures in separate
  // OS test processes. Running both groups in one worker leaves Node's test harness
  // waiting on the intentionally unconfirmed generation even after every assertion passes.
  const isolatedPatterns = [
    '^(V9|AbortSignal|a direct required|a stalled runtime|a timed-out request|an unconfirmed child termination)',
    '^(an unconfirmed isolated|real shadow child|an expired exact|an active required|child hydration|pending or queued)',
  ]
  let isolatedCode = 0
  for (const pattern of isolatedPatterns) {
    isolatedCode = await run([`--test-name-pattern=${pattern}`, isolated])
    if (isolatedCode !== 0) break
  }
  process.exitCode = isolatedCode === 0 ? await run(discovered) : isolatedCode
}
