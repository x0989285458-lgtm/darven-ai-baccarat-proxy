import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MAX_RAW_BYTES = 4 * 1024 * 1024

export function readTrustedRegistryEvidence({ role, imageRef, execFile = execFileSync } = {}) {
  if (!['proxy', 'worker'].includes(role)) throw new Error('registry_role_invalid')
  if (!isRegistryImageRef(imageRef)) throw new Error('registry_image_ref_invalid')
  const raw = execFile('docker', ['buildx', 'imagetools', 'inspect', '--raw', imageRef], {
    encoding: null,
    shell: false,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: MAX_RAW_BYTES,
  })
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '')
  if (bytes.length === 0 || bytes.length > MAX_RAW_BYTES) throw new Error('registry_readback_size_invalid')
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new Error('registry_readback_json_invalid', { cause: error })
  }
  assertNoSecretMaterial(manifest)
  const digestValue = crypto.createHash('sha256').update(bytes).digest('hex')
  return {
    role,
    provenance: 'trusted-registry-adapter',
    receiptId: `registry-manifest-${digestValue}`,
    imageRef,
    imageDigest: `sha256:${digestValue}`,
  }
}

function isRegistryImageRef(value) {
  return /^(?=.{1,255}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/.test(String(value ?? ''))
}

function assertNoSecretMaterial(value) {
  const visit = (item) => {
    if (item == null) return
    if (typeof item === 'string') {
      if (/\bbearer\s+\S+/i.test(item) || /[?&](?:token|key|secret|password|authorization)=/i.test(item)) {
        throw new Error('registry_readback_secret_rejected')
      }
      return
    }
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return }
    if (typeof item !== 'object') return
    for (const [key, entry] of Object.entries(item)) {
      if (/^(?:token|key|secret|password|authorization|api[_-]?key)$/i.test(key)) {
        throw new Error('registry_readback_secret_rejected')
      }
      visit(entry)
    }
  }
  visit(value)
}

function parseArgs(argv) {
  const allowed = new Set(['--role', '--image-ref'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(flag) || !value || String(value).startsWith('--') || values.has(flag)) throw new Error('registry_adapter_arguments_invalid')
    values.set(flag, value)
  }
  if (!values.has('--role') || !values.has('--image-ref')) throw new Error('registry_adapter_arguments_invalid')
  return { role: values.get('--role'), imageRef: values.get('--image-ref') }
}

function main() {
  const evidence = readTrustedRegistryEvidence(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main() } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  }
}
