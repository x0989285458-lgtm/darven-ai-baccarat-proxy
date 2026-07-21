import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudCaptureClient } from '../src/cloud-capture.js'
import { createApp } from '../src/server.js'
import { classifyOperationalEvent } from '../src/event-layer.js'

const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()

test('classifies operational events into capture/write/monitor/control layers', () => {
  assert.equal(classifyOperationalEvent({ component: 'cloud_capture', message: 'worker socket reset' }).layer, 'capture_error')
  assert.equal(classifyOperationalEvent({ component: 'supabase_writer', message: 'insert failed' }).layer, 'write_error')
  assert.equal(classifyOperationalEvent({ component: 'cloud_status', message: 'Cloud snapshot is stale' }).layer, 'monitor_error')
  assert.equal(classifyOperationalEvent({ component: 'control_api', statusCode: 401 }).layer, 'control_error')
})

test('worker disconnect is recorded as capture error without leaking token', async () => {
  const state = createFakeState()
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot?token=secret-token-value',
    state,
    fetchImpl: async () => { throw new Error('worker socket reset token=secret-token-value') },
    requestRetries: 1,
  })

  await client.tick()

  const status = state.snapshot().status
  assert.equal(status.eventLayer, 'capture_error')
  assert.equal(status.connected, false)
  assert.match(status.errorMessage, /worker socket reset/)
  assert.doesNotMatch(status.errorMessage, /secret-token-value/)
})

test('Supabase write failure is recorded as write error while keeping fresh worker data', async () => {
  const state = createFakeState()
  const client = createCloudCaptureClient({
    url: 'https://cloud-worker.example/snapshot',
    state,
    writer: {
      configured: true,
      writeCloudCaptureStatus: async () => { throw new Error('Supabase insert failed secret=hidden') },
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ buildVersion: '104', connected: true, authenticated: true, tables: [{ tableId: 'BAG01', round: 7 }] }),
    }),
  })

  const parsed = await client.tick()

  const status = state.snapshot().status
  assert.equal(parsed.tables.length, 1)
  assert.equal(status.connected, true)
  assert.equal(status.eventLayer, 'write_error')
  assert.match(status.eventMessage, /Supabase insert failed/)
  assert.doesNotMatch(status.eventMessage, /hidden/)
})

test('stale cloud data is exposed as monitor error on status', async () => {
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    supabaseClient: {
      configured: true,
      getLatestCloudCaptureStatus: async () => ({
        capture_source: 'cloud_browser',
        connected: true,
        authenticated: true,
        table_count: 12,
        last_message_at: staleTime,
      }),
      getLatestCloudTableSnapshot: async () => ({ snapshot_at: staleTime, table_count: 12, tables: [{ tableId: 'BAG01' }] }),
    },
  })

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  const body = JSON.parse(response.body)
  assert.equal(body.eventLayer, 'monitor_error')
  assert.match(body.eventMessage, /stale|過期/i)
})

test('unauthorized control API is recorded as control error', async () => {
  const app = createApp({
    autoConnect: false,
    deployMode: 'cloud',
    captureSource: 'cloud_browser',
    cloudBrowserUrl: 'https://cloud-worker.example/snapshot',
    controlToken: 'control-secret',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tables: [] }) }),
  })

  const denied = await app.inject({ method: 'POST', url: '/api/cloud-capture/start' })
  assert.equal(denied.statusCode, 401)
  const status = app.state.snapshot().status
  assert.equal(status.eventLayer, 'control_error')
  assert.match(status.eventMessage, /control token/i)
})

function createFakeState() {
  const data = { status: {}, tables: [] }
  return {
    setStatus(next = {}) { data.status = { ...data.status, ...next } },
    setTables(tables = []) { data.tables = tables; data.status.tableCount = tables.length },
    upsertRoundEvent(round = {}) { data.lastRound = round },
    recordError(message) { data.status.connected = false; data.status.errorMessage = String(message) },
    snapshot() { return JSON.parse(JSON.stringify(data)) },
  }
}
