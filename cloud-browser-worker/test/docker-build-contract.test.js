import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const dockerfileUrl = new URL('../Dockerfile', import.meta.url)
const composeUrl = new URL('../deploy/vm/docker-compose.yml', import.meta.url)

test('v098.18 worker Docker image packages the shared exact-card validator from repo root', async () => {
  const [dockerfile, compose] = await Promise.all([
    readFile(dockerfileUrl, 'utf8'),
    readFile(composeUrl, 'utf8'),
  ])

  assert.match(compose, /context:\s*\.\.\/\.\.\/\.\.(?:\/|\s)/)
  assert.match(compose, /dockerfile:\s*cloud-browser-worker\/Dockerfile/)
  assert.match(dockerfile, /COPY\s+cloud-browser-worker\/package\*\.json\s+\.\//)
  assert.match(dockerfile, /COPY\s+cloud-browser-worker\/src\s+\.\/src/)
  assert.match(dockerfile, /COPY\s+shared\s+\/shared/)
})
