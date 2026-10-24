import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createApp } from '../src/server.js'
import { readReleaseIdentity } from '../src/release-identity.js'

const commit = '6092a5b2e01d533ca2b9714b9bd3629501118b12'
const release = 'v105-six-raw.20261024.5'

async function healthWithEnv(values) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  let app
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    app = createApp({ autoConnect: false })
    const response = await app.inject({ method: 'GET', url: '/health' })
    return { response, body: JSON.parse(response.body) }
  } finally {
    await app?.stop()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('public health adds only exact typed commit and release, never raw environment', async () => {
  const { body } = await healthWithEnv({ GIT_SHA: commit, RELEASE_VERSION: release, HEALTH_IDENTITY_PRIVATE_SENTINEL: 'not-public' })
  assert.deepEqual(body.releaseIdentity, { commit, release })
  assert.equal(body.version, 'v105')
  assert.equal(body.buildVersion, 'v105')
  assert.equal(JSON.stringify(body).includes('not-public'), false)
})

for (const [name, values] of Object.entries({
  missing: { GIT_SHA: undefined, RELEASE_VERSION: undefined },
  missingCommit: { GIT_SHA: undefined, RELEASE_VERSION: release },
  missingRelease: { GIT_SHA: commit, RELEASE_VERSION: undefined },
  empty: { GIT_SHA: '', RELEASE_VERSION: '' },
  shortSha: { GIT_SHA: commit.slice(0, 7), RELEASE_VERSION: release },
  malformedSha: { GIT_SHA: 'not-public-secret', RELEASE_VERSION: release },
  malformedRelease: { GIT_SHA: commit, RELEASE_VERSION: 'https://user:not-public-secret@example.test' },
  padded: { GIT_SHA: ` ${commit}`, RELEASE_VERSION: release },
  newline: { GIT_SHA: `${commit}\n`, RELEASE_VERSION: release },
  paddedRelease: { GIT_SHA: commit, RELEASE_VERSION: `${release}\n` },
})) {
  test(`public health identity is null for ${name}, with no partial identity or raw error`, async () => {
    const { body } = await healthWithEnv(values)
    assert.equal(body.releaseIdentity, null)
    assert.equal(JSON.stringify(body).includes('not-public-secret'), false)
    assert.equal(body.version, 'v105')
  })
}

test('identity accepts strings only and never coerces an object into public output', () => {
  for (const value of [null, 123, {}, [], { toString() { throw new Error('must not coerce') } }]) {
    assert.equal(readReleaseIdentity({ GIT_SHA: value, RELEASE_VERSION: release }), null)
    assert.equal(readReleaseIdentity({ GIT_SHA: commit, RELEASE_VERSION: value }), null)
  }
})

test('six-raw image embeds exact trusted workflow build args into runtime ENV', () => {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile.six-raw', import.meta.url), 'utf8')
  const workflow = fs.readFileSync(new URL('../../.github/workflows/trusted-release-six-raw.yml', import.meta.url), 'utf8')
  assert.match(dockerfile, /^ARG GIT_SHA\r?$/m)
  assert.match(dockerfile, /^ARG RELEASE_VERSION\r?$/m)
  assert.match(dockerfile, /^ENV GIT_SHA=\$\{GIT_SHA\}\r?$/m)
  assert.match(dockerfile, /^ENV RELEASE_VERSION=\$\{RELEASE_VERSION\}\r?$/m)
  assert.match(workflow, /build-args: \|\r?\n\s+GIT_SHA=\$\{\{ github.sha \}\}\r?\n\s+RELEASE_VERSION=\$\{\{ github.ref_name \}\}/)
})
