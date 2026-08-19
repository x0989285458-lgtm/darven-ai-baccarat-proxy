import { spawn } from 'node:child_process'
import path from 'node:path'
import { buildScrubbedTestEnv } from './test-env-scrub.mjs'

const workerRoot = path.resolve(import.meta.dirname, '../cloud-browser-worker')
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  cwd: workerRoot,
  env: buildScrubbedTestEnv(),
  stdio: 'inherit',
  shell: false,
})

child.once('error', (error) => {
  process.stderr.write(`worker test runner failed: ${error?.message ?? String(error)}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`worker test runner stopped by ${signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = Number.isInteger(code) ? code : 1
})
