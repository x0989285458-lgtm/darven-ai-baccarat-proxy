import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as onlineCore from '../src/online-core.js'

const baselineSql = readFileSync(new URL('../../frontend/supabase/schema_v100_baseline.sql', import.meta.url), 'utf8')

test('formal strategy activation builds one stable compact memory version row', () => {
  assert.equal(typeof onlineCore.buildMemoryStrategyVersionRow, 'function', 'formal strategy memory row builder is not implemented')

  const row = onlineCore.buildMemoryStrategyVersionRow({
    releaseVersion: 'v105.0.0-formal.10',
    strategyVersion: 'v105',
    name: '瑞文AI百家正式策略',
    status: 'active',
    mainWeights: { 路單趨勢訊號: 0.275, 問路訊號: 0.275, 靴局莊閒偏差: 0.35, 中性保留: 0.1 },
    sideThresholds: { 和: 30, 超六: 50, 莊對: 50, 閒對: 50, 莊龍寶: 40, 閒龍寶: 40 },
    metrics: {
      verifiedTables: 10,
      e2ePassed: true,
      token: 'must-not-persist',
      password: 'must-not-persist',
      cookie: 'must-not-persist',
      events: [{ tableId: 'BAG01', round: 1 }],
      rawPayload: { cards: ['AS', 'KH'] },
    },
    notes: '正式E2E通過後啟用',
    activatedAt: '2026-07-24T12:00:00.000Z',
  })

  assert.deepEqual(row, {
    version: 'v105.0.0-formal.10',
    name: '瑞文AI百家正式策略',
    status: 'active',
    main_weights: { 路單趨勢訊號: 0.275, 問路訊號: 0.275, 靴局莊閒偏差: 0.35, 中性保留: 0.1 },
    side_thresholds: { 和: 30, 超六: 50, 莊對: 50, 閒對: 50, 莊龍寶: 40, 閒龍寶: 40 },
    metrics: { strategyVersion: 'v105', verifiedTables: 10, e2ePassed: true },
    notes: '正式E2E通過後啟用',
    activated_at: '2026-07-24T12:00:00.000Z',
  })
  assert.equal(JSON.stringify(row).includes('must-not-persist'), false)
  assert.equal(JSON.stringify(row).includes('BAG01'), false)
  assert.equal(JSON.stringify(row).includes('AS'), false)
})

test('online core upserts a repeated formal strategy version through the project version conflict key', async () => {
  assert.match(baselineSql, /UNIQUE\s*\(project_id,\s*version\)/i)

  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null })
    if (String(url).includes('/memory_projects')) {
      return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat' }])
    }
    return jsonResponse([])
  }
  const client = onlineCore.createOnlineCoreClient({
    url: 'https://example.supabase.co',
    serviceKey: 'service-key',
    dbConnectionString: '',
    fetchImpl,
  })
  assert.equal(typeof client.upsertStrategyVersion, 'function', 'formal strategy memory upsert is not implemented')

  const input = {
    releaseVersion: 'v105.0.0-formal.10',
    strategyVersion: 'v105',
    name: '瑞文AI百家正式策略',
    status: 'active',
    mainWeights: { 路單趨勢訊號: 0.275, 問路訊號: 0.275, 靴局莊閒偏差: 0.35, 中性保留: 0.1 },
    sideThresholds: { 和: 30, 超六: 50, 莊對: 50, 閒對: 50, 莊龍寶: 40, 閒龍寶: 40 },
    metrics: { verifiedTables: 10, e2ePassed: true },
    activatedAt: '2026-07-24T12:00:00.000Z',
  }
  await client.upsertStrategyVersion(input)
  await client.upsertStrategyVersion(input)

  const writes = requests.filter((request) => request.url.includes('/memory_strategy_versions'))
  assert.equal(writes.length, 2)
  assert.ok(writes.every((request) => request.options.method === 'POST'))
  assert.ok(writes.every((request) => request.url.includes('on_conflict=project_id%2Cversion')))
  assert.ok(writes.every((request) => request.options.headers.Prefer === 'resolution=merge-duplicates,return=minimal'))
  assert.deepEqual(writes[0].body, writes[1].body)
  assert.equal(writes[0].body.project_id, 'project-1')
  assert.equal(writes[0].body.version, 'v105.0.0-formal.10')
})

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}
