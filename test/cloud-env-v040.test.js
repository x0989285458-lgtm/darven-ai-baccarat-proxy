import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDeployConfig } from '../src/config.js'

test('v040 cloud deploy config enables cloud polling when cloud browser URL is configured', () => {
  const config = resolveDeployConfig({
    DEPLOY_MODE: 'cloud',
    CAPTURE_SOURCE: 'cloud_browser',
    CLOUD_BROWSER_URL: 'https://cloud-worker.example/snapshot',
    CLOUD_CAPTURE_POLL_MS: '1500',
  })

  assert.equal(config.deployMode, 'cloud')
  assert.equal(config.captureSource, 'cloud_browser')
  assert.equal(config.cloudBrowserUrl, 'https://cloud-worker.example/snapshot')
  assert.equal(config.cloudCapturePollMs, 1500)
})
