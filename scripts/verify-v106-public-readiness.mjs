import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function verifyV106PublicReadiness({
  url,
  expectedRelease,
  expectedPackage,
  expectedCommit,
  fetchImpl = globalThis.fetch,
  consecutive = 2,
  attempts = 30,
  intervalMs = 15000,
  requestTimeoutMs = 20000,
  onProbe = () => {},
} = {}) {
  if (!/^https:\/\//.test(String(url ?? ''))) throw new Error('public_readiness_https_url_required')
  if (!/^v106\.0\.0-formal\.\d+$/.test(String(expectedRelease ?? ''))) throw new Error('public_readiness_release_required')
  if (!/^1\.0\.\d+$/.test(String(expectedPackage ?? ''))) throw new Error('public_readiness_package_required')
  if (!/^[a-f0-9]{40}$/.test(String(expectedCommit ?? ''))) throw new Error('public_readiness_commit_required')
  if (typeof fetchImpl !== 'function') throw new Error('public_readiness_fetch_required')
  const requiredStreak = Math.max(2, Number(consecutive) || 0)
  const maxAttempts = Math.max(requiredStreak, Number(attempts) || 0)
  let streak = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response = null
    let body = null
    let error = null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(requestTimeoutMs) || 20000))
    try {
      response = await fetchImpl(`${String(url).replace(/\/$/, '')}/health`, {
        method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal,
      })
      body = await response.json()
    } catch (caught) {
      error = caught?.name ?? 'Error'
    } finally {
      clearTimeout(timer)
    }
    const passed = response?.status === 200
      && body?.ok === true
      && body?.version === 'v106'
      && body?.buildVersion === 'v106'
      && body?.releaseVersion === expectedRelease
      && body?.packageVersion === expectedPackage
      && body?.commit === expectedCommit
    streak = passed ? streak + 1 : 0
    const probe = {
      attempt, status: response?.status ?? null, ok: body?.ok ?? null,
      version: body?.version ?? null, buildVersion: body?.buildVersion ?? null,
      releaseVersion: body?.releaseVersion ?? null, packageVersion: body?.packageVersion ?? null,
      commit: body?.commit ?? null, passed, streak, error,
    }
    onProbe(probe)
    if (streak >= requiredStreak) return { verdict: 'PASS', consecutive: streak, probe }
    if (attempt < maxAttempts) await sleep(Math.max(0, Number(intervalMs) || 0))
  }
  const blocked = new Error('public_proxy_exact_readiness_not_reached')
  blocked.code = 'PUBLIC_PROXY_READINESS_BLOCK'
  throw blocked
}

async function main() {
  const args = process.argv.slice(2)
  const get = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  try {
    const result = await verifyV106PublicReadiness({
      url: get('--url'), expectedRelease: get('--expected-release'), expectedPackage: get('--expected-package'),
      expectedCommit: get('--expected-commit'), consecutive: Number(get('--consecutive') ?? 2),
      attempts: Number(get('--attempts') ?? 30), intervalMs: Number(get('--interval-ms') ?? 15000),
      requestTimeoutMs: Number(get('--request-timeout-ms') ?? 20000),
      onProbe: (probe) => process.stdout.write(`${JSON.stringify(probe)}\n`),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ verdict: 'BLOCK', code: error?.code ?? 'PUBLIC_PROXY_READINESS_ERROR', error: error?.message ?? String(error) })}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
