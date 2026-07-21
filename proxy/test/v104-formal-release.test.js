import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { BUILD_VERSION } from '../src/build-version.js'
import { ALL_MT_EQUAL_STRATEGY_VERSION, buildFormalActiveStrategy } from '../src/supabase-writer.js'
import { createApp } from '../src/server.js'

const root = new URL('../../', import.meta.url)
const manifestUrl = new URL('release/v104-formal-release-manifest.json', root)
const frontendVersionUrl = new URL('frontend/src/lib/buildVersion.ts', root)
const workerRuntimeUrl = new URL('cloud-browser-worker/src/runtime-config.js', root)
const workerPusherUrl = new URL('cloud-browser-worker/src/snapshot-pusher.js', root)
const workerDockerUrl = new URL('cloud-browser-worker/Dockerfile', root)

test('v104 formal release manifest and every live component expose one coherent identity', async () => {
  assert.equal(existsSync(manifestUrl), true, 'formal release manifest must exist')
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))
  assert.deepEqual({
    productVersion: manifest.productVersion,
    frontendBuildVersion: manifest.frontendBuildVersion,
    proxyBuildVersion: manifest.proxyBuildVersion,
    workerBuildVersion: manifest.workerBuildVersion,
    strategyVersion: manifest.strategyVersion,
    protocolVersion: manifest.protocolVersion,
    monitorVersion: manifest.monitorVersion,
    candidateMode: manifest.candidateMode,
    formalActionsEnabled: manifest.formalActionsEnabled,
  }, {
    productVersion: 'v104', frontendBuildVersion: 'v104', proxyBuildVersion: 'v104',
    workerBuildVersion: '104', strategyVersion: 'v104', protocolVersion: 'v104',
    monitorVersion: 'v104', candidateMode: 'formal', formalActionsEnabled: true,
  })

  assert.equal(BUILD_VERSION, 'v104')
  assert.equal(ALL_MT_EQUAL_STRATEGY_VERSION, 'v104')
  assert.equal(buildFormalActiveStrategy().version, 'v104')
  assert.equal(buildFormalActiveStrategy().status, 'active')
  const app = createApp({ autoConnect: false })
  const health = JSON.parse((await app.inject({ url: '/health' })).body)
  assert.equal(health.buildVersion, 'v104')

  const frontend = readFileSync(frontendVersionUrl, 'utf8')
  assert.match(frontend, /buildVersion:\s*'v104'/)
  assert.match(frontend, /strategyVersion:\s*'v104'/)
  const workerRuntime = readFileSync(workerRuntimeUrl, 'utf8')
  assert.match(workerRuntime, /BUILD_VERSION\s*=\s*'104'/)
  const pusher = readFileSync(workerPusherUrl, 'utf8')
  assert.equal((pusher.match(/protocolVersion:\s*'v104'/g) ?? []).length >= 2, true)
  const docker = readFileSync(workerDockerUrl, 'utf8')
  assert.match(docker, /org\.opencontainers\.image\.version="v104"/)
})
