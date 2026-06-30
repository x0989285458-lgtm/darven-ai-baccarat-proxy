#!/usr/bin/env node
import { runCloudDeploySmoke } from '../src/cloud-deploy-smoke.js'

const apiBaseUrl = process.argv[2] ?? process.env.DRAVEN_API_BASE_URL ?? process.env.VITE_DRAVEN_CLOUD_API_URL
const workerUrl = process.argv[3] ?? process.env.CLOUD_BROWSER_URL
const expectedVersion = process.env.DRAVEN_EXPECTED_VERSION ?? '042'

const result = await runCloudDeploySmoke({ apiBaseUrl, workerUrl, expectedVersion })
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
