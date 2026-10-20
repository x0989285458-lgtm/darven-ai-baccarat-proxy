// Test-only historical lane. No environment variable may override these pins.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HISTORICAL_COMMIT = '796bd573fa39b71ba2d0061e555de92ad45276fd'
export const HISTORICAL_TREE = '818770a15310c5c24d5dbb507ba29933040e227a'
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const blobHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
function safePath(path) {
  if (typeof path !== 'string' || !path || /[\\:\0?#%]/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid historical path: ${path}`)
  }
  return path
}

// Factory is only an explicit error-injection seam for tests; public default pins
// are module-private constants and never consult process.env or caller options.
export function createHistoricalLoader({ repoRoot = REPO_ROOT, commit = HISTORICAL_COMMIT, tree = HISTORICAL_TREE } = {}) {
  let root = null
  let hook = null
  let closed = false
  const manifest = new Map()
  const loaded = new Set()
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', repoRoot, ...args], {
    maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const cleanup = () => {
    closed = true
    hook?.deregister()
    hook = null
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    process.removeListener('exit', cleanup)
  }
  function verify(path) {
    const expected = manifest.get(path)
    if (!expected) throw new Error(`Unpinned historical path: ${path}`)
    if (blobHash(readFileSync(join(root, path))) !== expected) throw new Error(`Historical source integrity mismatch: ${path}`)
  }
  function prepare() {
    if (closed) throw new Error('Historical loader is closed')
    if (root) return
    if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) throw new Error('Historical pin must be a full SHA')
    if (git('rev-parse', '--verify', `${commit}^{commit}`).toString().trim() !== commit
      || git('rev-parse', '--verify', `${commit}^{tree}`).toString().trim() !== tree) throw new Error('Historical commit/tree pin mismatch')
    const entries = git('ls-tree', '-rz', '--full-tree', commit).toString('utf8').split('\0').filter(Boolean).map((line) => {
      const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line)
      if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) throw new Error(`Unsupported historical tree entry: ${line}`)
      return { hash: match[3], path: safePath(match[4]) }
    })
    // cat-file returns literal blob bytes: no checkout filters, export-ignore,
    // export-subst, CRLF conversion, symlinks, or dependency junctions.
    const batch = execFileSync('git', ['--no-replace-objects', '-C', repoRoot, 'cat-file', '--batch'], {
      input: entries.map((entry) => entry.hash).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    root = mkdtempSync(join(tmpdir(), 'immutable-six-raw-history-'))
    process.once('exit', cleanup)
    try {
      let offset = 0
      for (const entry of entries) {
        const end = batch.indexOf(10, offset)
        const [hash, type, size] = batch.subarray(offset, end).toString().split(' ')
        if (hash !== entry.hash || type !== 'blob' || !/^\d+$/.test(size)) throw new Error('Historical Git object unavailable')
        const bytes = batch.subarray(end + 1, end + 1 + Number(size))
        if (blobHash(bytes) !== hash) throw new Error('Historical Git blob mismatch')
        const target = join(root, entry.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes, { flag: 'wx' })
        manifest.set(entry.path, hash)
        offset = end + 2 + Number(size)
      }
      const prefix = pathToFileURL(root + '/').href
      const dependencyParent = pathToFileURL(join(repoRoot, 'proxy', 'package.json')).href
      hook = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (!context.parentURL?.startsWith(prefix)) return nextResolve(specifier, context)
          if (isBuiltin(specifier)) return nextResolve(specifier, context)
          const bare = /^(pg|ws)(\/|$)/.test(specifier)
          const result = nextResolve(specifier, bare ? { ...context, parentURL: dependencyParent } : context)
          if (bare) {
            const packageRoot = pathToFileURL(realpathSync(join(repoRoot, 'proxy', 'node_modules')) + '/').href
            if (!result.url.startsWith(packageRoot)) throw new Error(`Unapproved historical dependency: ${result.url}`)
          } else if (!result.url.startsWith(prefix)) throw new Error(`Historical source graph escaped: ${result.url}`)
          return result
        },
        load(url, context, nextLoad) {
          if (url.startsWith(prefix)) {
            const path = fileURLToPath(url).slice(root.length + 1).replaceAll('\\', '/')
            verify(path)
            loaded.add(path)
          }
          return nextLoad(url, context)
        },
      })
    } catch (error) { cleanup(); throw error }
  }
  return {
    async importHistoricalModule(repoRelativePath) {
      safePath(repoRelativePath)
      prepare()
      // Reject deleted/tampered cached modules rather than report phantom success.
      for (const path of loaded) verify(path)
      verify(repoRelativePath)
      return import(pathToFileURL(join(root, repoRelativePath)).href)
    },
    cleanup,
    get root() { return root },
    get evidence() { return { commit, tree, root, closed, files: manifest.size, loaded: [...loaded].sort(), removed: root !== null && !existsSync(root) } },
  }
}
const historicalLoader = createHistoricalLoader()
export const importHistoricalModule = (repoRelativePath) => historicalLoader.importHistoricalModule(repoRelativePath)
export const cleanupHistoricalModules = () => historicalLoader.cleanup()
export const historicalSourceEvidence = () => historicalLoader.evidence
