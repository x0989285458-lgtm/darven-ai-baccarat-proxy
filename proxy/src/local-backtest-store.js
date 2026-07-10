import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DEFAULT_BACKTEST_DIR = join('tmp', 'backtests')

export async function writeLocalBacktestResult(result = {}, {
  outDir = DEFAULT_BACKTEST_DIR,
  prefix = 'backtest',
  now = new Date(),
} = {}) {
  const targetDir = resolve(outDir)
  await mkdir(targetDir, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const fileName = `${sanitizeFileToken(prefix)}-${stamp}.json`
  const filePath = join(targetDir, fileName)
  const payload = {
    savedAt: now.toISOString(),
    storage: 'local_tmp_backtests',
    result,
  }
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
  return { ok: true, filePath, payload }
}

function sanitizeFileToken(value) {
  const token = String(value ?? 'backtest')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return token || 'backtest'
}
