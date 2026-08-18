import { spawn } from 'node:child_process'
import { buildScrubbedTestEnv } from '../../scripts/test-env-scrub.mjs'

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  env: buildScrubbedTestEnv(),
  stdio: 'inherit',
  shell: false,
})

child.once('error', (error) => {
  process.stderr.write(`test runner failed: ${error?.message ?? String(error)}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`test runner stopped by ${signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = Number.isInteger(code) ? code : 1
})
