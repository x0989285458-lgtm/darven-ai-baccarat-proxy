import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as onlineCore from '../src/online-core.js'

const migrationUrl = new URL('../../frontend/supabase/migrate_v105_formal_memory_daily_summary.sql', import.meta.url)
const baselineUrl = new URL('../../frontend/supabase/schema_v100_baseline.sql', import.meta.url)

function assertDailySchema(sql) {
  assert.match(sql, /(?:add\s+column\s+if\s+not\s+exists\s+|^\s*)report_date\s+date/im)
  assert.match(sql, /(?:add\s+column\s+if\s+not\s+exists\s+|^\s*)updated_at\s+(?:timestamp\s+with\s+time\s+zone|timestamptz)/im)
  assert.match(sql, /create\s+unique\s+index(?:\s+if\s+not\s+exists)?[\s\S]*\(project_id,\s*strategy_version,\s*report_type,\s*report_date\)/i)
}

test('daily memory schema has a rerunnable one-row-per-Taipei-day conflict key', () => {
  assert.equal(existsSync(migrationUrl), true, 'daily memory additive migration is not implemented')
  const migrationSql = readFileSync(migrationUrl, 'utf8')
  const baselineSql = readFileSync(baselineUrl, 'utf8')
  assertDailySchema(migrationSql)
  assertDailySchema(baselineSql)
  assert.doesNotMatch(migrationSql, /drop\s+(?:table|column)|truncate|delete\s+from/i)
})

test('online core upserts one compact finalized v105 summary per Taipei date', async () => {
  assert.equal(typeof onlineCore.buildFormalDailyMemoryReportRow, 'function', 'formal daily memory row builder is not implemented')

  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null })
    if (String(url).includes('/memory_projects')) return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat' }])
    return jsonResponse([])
  }
  const client = onlineCore.createOnlineCoreClient({
    url: 'https://example.supabase.co',
    serviceKey: 'service-key',
    dbConnectionString: '',
    fetchImpl,
  })
  assert.equal(typeof client.upsertDailySummary, 'function', 'formal daily memory upsert is not implemented')

  const summary = {
    reportDate: '2026-07-24',
    timezone: 'Asia/Taipei',
    strategyVersion: 'v105',
    rounds: 1000,
    hits: 506,
    misses: 414,
    pushes: 80,
    mainEvaluated: 920,
    mainHitRate: 55,
    sideActions: 200,
    sideHits: 42,
    sideHitRate: 21,
    categories: {
      莊: { hits: 260, total: 470, rate: 55.32 },
      閒: { hits: 246, total: 450, rate: 54.67 },
      和: { hits: 8, total: 30, rate: 26.67 },
      龍寶: { hits: 12, total: 50, rate: 24 },
      對子: { hits: 16, total: 80, rate: 20 },
      超六: { hits: 6, total: 40, rate: 15 },
    },
    events: [{ tableId: 'BAG01', cards: ['AS', 'KH'] }],
    token: 'must-not-persist',
  }
  await client.upsertDailySummary(summary)
  await client.upsertDailySummary(summary)

  const writes = requests.filter((request) => request.url.includes('/memory_test_reports'))
  assert.equal(writes.length, 2)
  assert.ok(writes.every((request) => request.url.includes('on_conflict=project_id%2Cstrategy_version%2Creport_type%2Creport_date')))
  assert.ok(writes.every((request) => request.options.headers.Prefer === 'resolution=merge-duplicates,return=minimal'))
  assert.deepEqual(writes[0].body, writes[1].body)
  assert.equal(writes[0].body.project_id, 'project-1')
  assert.equal(writes[0].body.strategy_version, 'v105')
  assert.equal(writes[0].body.report_type, 'formal_daily_summary')
  assert.equal(writes[0].body.report_date, '2026-07-24')
  assert.equal(writes[0].body.metadata.timezone, 'Asia/Taipei')
  assert.equal(writes[0].body.metadata.finalized, true)
  assert.equal(JSON.stringify(writes[0].body).includes('must-not-persist'), false)
  assert.equal(JSON.stringify(writes[0].body).includes('BAG01'), false)
  assert.equal(JSON.stringify(writes[0].body).includes('AS'), false)
})

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}
