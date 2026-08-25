import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MAX_RAW_BYTES = 4 * 1024 * 1024
const MAX_ATTESTATION_BYTES = 4 * 1024 * 1024
const TRUSTED_REPOSITORY = 'x0989285458-lgtm/darven-ai-baccarat-proxy'
const TRUSTED_SIGNER_WORKFLOW = 'x0989285458-lgtm/darven-ai-baccarat-proxy/.github/workflows/trusted-release-images.yml'
const TRUSTED_SOURCE_REF = 'refs/tags/v105-v10-main.26'
const ROLE_REPOSITORIES = Object.freeze({
  proxy: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-proxy',
  'formal-consumer': 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-formal-consumer',
  worker: 'ghcr.io/x0989285458-lgtm/darven-ai-baccarat-worker',
})

export function readTrustedRegistryEvidence({ role, imageRef, sourceDigest, sourceRef, execFile = execFileSync } = {}) {
  if (!['proxy', 'formal-consumer', 'worker'].includes(role)) throw new Error('registry_role_invalid')
  if (!/^[a-f0-9]{40}$/.test(String(sourceDigest ?? ''))) throw new Error('registry_source_digest_invalid')
  if (sourceRef !== TRUSTED_SOURCE_REF) throw new Error('registry_source_ref_invalid')
  const expectedImageRef = `${ROLE_REPOSITORIES[role]}:${sourceDigest}`
  if (!isRegistryImageRef(imageRef) || imageRef !== expectedImageRef) throw new Error('registry_image_ref_invalid')

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
  const imageDigest = `sha256:${digestValue}`
  const immutableImageRef = `${ROLE_REPOSITORIES[role]}@${imageDigest}`

  const attestationRaw = execFile('gh', [
    'attestation', 'verify', `oci://${immutableImageRef}`,
    '--repo', TRUSTED_REPOSITORY,
    '--signer-workflow', TRUSTED_SIGNER_WORKFLOW,
    '--source-digest', sourceDigest,
    '--source-ref', sourceRef,
    '--deny-self-hosted-runners',
    '--format', 'json',
  ], {
    encoding: null,
    shell: false,
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: MAX_ATTESTATION_BYTES,
  })
  const attestationBytes = Buffer.isBuffer(attestationRaw) ? attestationRaw : Buffer.from(attestationRaw ?? '')
  if (attestationBytes.length === 0 || attestationBytes.length > MAX_ATTESTATION_BYTES) throw new Error('github_attestation_size_invalid')
  let attestations
  try { attestations = JSON.parse(attestationBytes.toString('utf8')) } catch (error) {
    throw new Error('github_attestation_json_invalid', { cause: error })
  }
  assertNoSecretMaterial(attestations)
  if (!Array.isArray(attestations) || attestations.length < 1) throw new Error('github_attestation_missing')
  const subjectMatch = attestations.some((entry) => {
    const subjects = entry?.verificationResult?.statement?.subject
    return Array.isArray(subjects) && subjects.some((subject) => subject?.name === ROLE_REPOSITORIES[role]
      && subject?.digest?.sha256 === digestValue)
  })
  if (!subjectMatch) throw new Error('github_attestation_subject_mismatch')

  return {
    role,
    provenance: 'github-sigstore-attestation',
    receiptId: `github-attestation-${digestValue}`,
    imageRef,
    imageDigest,
    immutableImageRef,
    subjectName: ROLE_REPOSITORIES[role],
    subjectDigest: imageDigest,
    sourceDigest,
    sourceRef,
    signerWorkflow: TRUSTED_SIGNER_WORKFLOW,
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
  const allowed = new Set(['--role', '--image-ref', '--source-digest', '--source-ref'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(flag) || !value || String(value).startsWith('--') || values.has(flag)) throw new Error('registry_adapter_arguments_invalid')
    values.set(flag, value)
  }
  if ([...allowed].some((flag) => !values.has(flag))) throw new Error('registry_adapter_arguments_invalid')
  return {
    role: values.get('--role'),
    imageRef: values.get('--image-ref'),
    sourceDigest: values.get('--source-digest'),
    sourceRef: values.get('--source-ref'),
  }
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
