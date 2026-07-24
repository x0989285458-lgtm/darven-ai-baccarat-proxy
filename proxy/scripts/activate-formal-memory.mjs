import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createOnlineCoreClient } from '../src/online-core.js'
import { activateFormalReleaseMemory } from '../src/formal-memory-activation.js'

const SENSITIVE_KEY = /token|password|cookie|secret|rawpayload/i

export async function runFormalMemoryActivation({
  manifestPath,
  e2eEvidencePath,
  onlineCoreClient = createOnlineCoreClient(),
  readFileImpl = readFile,
} = {}) {
  const manifest = await readJson(manifestPath, readFileImpl)
  const e2eEvidence = await readJson(e2eEvidencePath, readFileImpl)
  if (String(e2eEvidence.releaseVersion ?? '') !== String(manifest.releaseVersion ?? '')) {
    throw new Error('E2E evidence release version does not match the formal manifest release version')
  }
  const sensitivePath = findSensitiveKey(e2eEvidence)
  if (sensitivePath) throw new Error(`E2E evidence contains sensitive field: ${sensitivePath}`)
  const strategy = await activateFormalReleaseMemory({ onlineCoreClient, manifest, e2eEvidence })
  if (strategy?.ok !== true) throw new Error('formal strategy activation was not durable')
  if (typeof onlineCoreClient?.upsertFormalReleaseReport !== 'function') throw new Error('formal release report writer is unavailable')
  const report = await onlineCoreClient.upsertFormalReleaseReport({ ...e2eEvidence, strategyVersion: manifest.strategyVersion })
  if (report?.ok !== true) throw new Error('formal release report was not durable')
  return { ok: true, strategy, report }
}

async function readJson(filePath, readFileImpl) {
  if (!filePath) throw new Error('manifest and E2E evidence paths are required')
  const value = JSON.parse(await readFileImpl(filePath, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid JSON object: ${filePath}`)
  return value
}

function findSensitiveKey(value, path = '') {
  if (!value || typeof value !== 'object') return null
  for (const [key, item] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key
    if (SENSITIVE_KEY.test(key)) return nextPath
    const nested = findSensitiveKey(item, nextPath)
    if (nested) return nested
  }
  return null
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
  const [, , manifestPath, e2eEvidencePath] = process.argv
  runFormalMemoryActivation({ manifestPath, e2eEvidencePath })
    .then((result) => process.stdout.write(`${JSON.stringify({ ok: result?.ok === true })}\n`))
    .catch((error) => {
      process.stderr.write(`${error?.message ?? String(error)}\n`)
      process.exitCode = 1
    })
}
