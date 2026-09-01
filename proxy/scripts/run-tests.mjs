import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyProxyTests, discoverProxyTests } from './test-classifier.mjs'

export function buildCurrentRuntimeTestArgs(currentRuntime, callerArgs = []) {
  const requestedFiles = []
  const runnerArgs = []
  for (const arg of callerArgs) {
    const value = String(arg)
    if (!value.startsWith('-') && /(?:^|[\\/])[^\\/]+\.(?:c|m)?js$/i.test(value)) requestedFiles.push(value)
    else runnerArgs.push(value)
  }
  return ['--test', ...runnerArgs, ...(requestedFiles.length > 0 ? requestedFiles : currentRuntime)]
}

function sanitizedEnvironment() {
  const env = { ...process.env }
  delete env.SUPABASE_DB_CONNECTION_STRING
  delete env.SUPABASE_SERVICE_ROLE_KEY
  delete env.SUPABASE_SECRET_KEY
  delete env.DATABASE_URL
  delete env.POSTGRES_URL
  delete env.POSTGRES_PRISMA_URL
  delete env.POSTGRES_URL_NON_POOLING
  delete env.PGHOST
  delete env.PGPORT
  delete env.PGDATABASE
  delete env.PGUSER
  delete env.PGPASSWORD
  delete env.PGSERVICE
  delete env.PGSERVICEFILE
  return env
}

function run() {
  const proxyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { currentRuntime } = classifyProxyTests(discoverProxyTests(proxyRoot))
  const child = spawn(process.execPath, buildCurrentRuntimeTestArgs(currentRuntime, process.argv.slice(2)), {
    cwd: proxyRoot,
    env: sanitizedEnvironment(),
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
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) run()
