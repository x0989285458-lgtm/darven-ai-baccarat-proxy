import test from 'node:test'
import assert from 'node:assert/strict'
import * as onlineCore from '../src/online-core.js'

test('formal release E2E report is compact and idempotent by release day', async () => {
  assert.equal(typeof onlineCore.buildFormalReleaseMemoryReportRow, 'function', 'formal release memory report builder is not implemented')
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null })
    if (String(url).includes('/memory_projects')) return jsonResponse([{ id: 'project-1', slug: 'ai-baccarat' }])
    return jsonResponse([])
  }
  const client = onlineCore.createOnlineCoreClient({ url: 'https://example.supabase.co', serviceKey: 'service-key', dbConnectionString: '', fetchImpl })
  assert.equal(typeof client.upsertFormalReleaseReport, 'function', 'formal release report upsert is not implemented')
  const input = {
    releaseVersion: 'v105.0.0-formal.11', strategyVersion: 'v105', completedAt: '2026-07-24T16:30:00.000Z',
    passed: true, verifiedTables: 10, finalRows: 917,
    checks: { proxy: true, database: true, queue: true, cursor: true, frontend: true },
    token: 'must-not-persist', rawEvidence: { cards: ['AS', 'KH'] },
  }
  await client.upsertFormalReleaseReport(input)
  await client.upsertFormalReleaseReport(input)
  const writes = requests.filter((request) => request.url.includes('/memory_test_reports'))
  assert.equal(writes.length, 2)
  assert.ok(writes.every((request) => request.url.includes('on_conflict=project_id%2Cstrategy_version%2Creport_type%2Creport_date')))
  assert.deepEqual(writes[0].body, writes[1].body)
  assert.equal(writes[0].body.report_type, 'formal_release_e2e')
  assert.equal(writes[0].body.report_date, '2026-07-25')
  assert.equal(writes[0].body.strategy_version, 'v105')
  assert.equal(writes[0].body.raw_summary.releaseVersion, 'v105.0.0-formal.11')
  assert.equal(writes[0].body.raw_summary.verifiedTables, 10)
  assert.deepEqual(writes[0].body.raw_summary.checks, input.checks)
  assert.equal(writes[0].body.metadata.e2ePassed, true)
  assert.equal(JSON.stringify(writes[0].body).includes('must-not-persist'), false)
  assert.equal(JSON.stringify(writes[0].body).includes('AS'), false)
})

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload }, async text() { return JSON.stringify(payload) } }
}
