import { createRequire, registerHooks } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Current tests, including unchanged immutable build/release identity tests.
// Optional dependency roots reuse exact-version real packages; no mocks or installs.
const root = path.dirname(fileURLToPath(import.meta.url))
const roots = JSON.parse(process.env.WORKER_TEST_DEPENDENCY_ROOTS ?? '{}')
const expected = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies
const resolutions = new Map()
for (const [name, directory] of Object.entries(roots)) {
  if (!['playwright', 'ws'].includes(name)) throw new Error(`test_dependency_not_admitted:${name}`)
  const require = createRequire(path.join(path.resolve(directory), 'package.json'))
  const actual = require(`${name}/package.json`).version
  if (actual !== expected[name]) throw new Error(`test_dependency_version_mismatch:${name}:${actual}`)
  resolutions.set(name, pathToFileURL(path.join(path.resolve(directory), 'package.json')).href)
}
if (resolutions.size) registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, resolutions.has(specifier) ? { ...context, parentURL: resolutions.get(specifier) } : context)
} })
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tests = readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.js')).sort().map((name) => `test/${name}`)
  const env = { ...process.env }
  if (resolutions.size) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${import.meta.url}`.trim()
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=20000', ...tests], {
    cwd: root, env, stdio: 'inherit', timeout: 90000,
  })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 124
}
