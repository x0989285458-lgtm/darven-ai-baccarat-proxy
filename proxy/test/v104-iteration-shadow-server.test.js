import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

const HEADS = ['main','tie','superSix','bankerDragon','playerDragon','bankerPair','playerPair']
const table = { tableId: 'BAG01', shoe: 104, round: 20, bankerCount: 12, playerCount: 8 }

function settledRows(count = 1000) {
  return Array.from({ length: count }, (_, index) => ({
    prediction_id: `p-${index}`, table_id: 'BAG01', shoe_no: '104', round_no: index + 1,
    prediction_payload: { heads: Object.fromEntries(HEADS.map((key) => [key, { action: key === 'main', weights: {}, featureValues: {} }])) },
    head_results: Object.fromEntries(HEADS.map((key) => [key, {
      action: key === 'main', status: key === 'main' ? (index % 2 ? 'miss' : 'hit') : 'no_action',
      isHit: key === 'main' ? index % 2 === 0 : null,
      fixedStakeUnits: key === 'main' ? 1 : 0, weightedStakeUnits: key === 'main' ? 3 : 0,
      fixedNetUnits: key === 'main' ? (index % 2 ? -1 : 1) : 0,
      weightedNetUnits: key === 'main' ? (index % 2 ? -3 : 3) : 0,
    }])),
    settlement_final: true, resolved_at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  }))
}

function runtime(overrides = {}) {
  return {
    enabled: true,
    async observeTable() {}, async settleRound() {}, async start() {},
    snapshot: () => ({ status: 'ok', pendingCount: 0, ...overrides }),
  }
}

async function superSession(app, account = 'dv1788', role = 'total') {
  const login = await app.inject({ method: 'POST', url: '/api/online-license/agent-login', body: JSON.stringify({ agentAccount: account }) })
  assert.equal(login.statusCode, 200)
  return JSON.parse(login.body).adminSessionToken
}

test('iteration shadow remains a non-blocking backend-only sibling of formal v104 tables', async () => {
  const clock = () => Date.parse('2026-07-21T10:00:00Z')
  const withoutShadow = createApp({ autoConnect: false, supabaseClient: { configured: false }, now: clock })
  const withShadow = createApp({ autoConnect: false, supabaseClient: { configured: false }, now: clock, v104IterationShadowRuntime: runtime() })
  withoutShadow.state.setTables([table])
  withShadow.state.setTables([table])
  const formal = JSON.parse((await withoutShadow.inject({ url: '/api/tables' })).body)
  const shadowed = JSON.parse((await withShadow.inject({ url: '/api/tables' })).body)
  assert.deepEqual(shadowed, formal)
  assert.equal(shadowed[0].prediction.strategyVersion, 'v105')
  assert.equal(JSON.stringify(shadowed).includes('v104-seven-head-shadow-v1'), false)
})

test('control status requires control token and reports formal v104 without exposing member endpoint', async () => {
  const app = createApp({ autoConnect: false, supabaseClient: { configured: false }, controlToken: 'control-test', v104IterationShadowRuntime: runtime() })
  assert.equal((await app.inject({ url: '/api/v104-iteration-shadow/control/status' })).statusCode, 401)
  const response = await app.inject({ url: '/api/v104-iteration-shadow/control/status', headers: { 'x-control-token': 'control-test' } })
  const body = JSON.parse(response.body)
  assert.equal(response.statusCode, 200)
  assert.equal(body.formalStrategyVersion, 'v105')
  assert.equal(body.runtime.status, 'ok')
})

test('admin status and complete SVG are super-admin Bearer only and reject query secrets', async () => {
  const rows = settledRows()
  let durableReads = 0
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>影子預測第1輪</text></svg>'
  const writer = {
    configured: true,
    async getV104IterationShadowCounters() { durableReads += 1; return { settlement_count: 1000, main_action_count: 1000, tie_action_count: 0, super_six_action_count: 0, banker_dragon_action_count: 0, player_dragon_action_count: 0, banker_pair_action_count: 0, player_pair_action_count: 0 } },
    async getV104IterationShadowSettledRange() { durableReads += 1; return rows },
    async getV104IterationShadowCycleReports() { durableReads += 1; return [{ cycle_number: 1, report_payload: { cycleNumber: 1, startedAt: '2026-01-01', completedAt: '2026-01-02' }, report_svg: svg }] },
    async getV104IterationShadowSuggestions() { durableReads += 1; return [{ suggestion_id: 'suggestion-1', head_key: 'main', action_cycle: 1, model_version: 'v104-seven-head-shadow-v1', search_method: 'exhaustive_5_percent_grid', current_weights: {}, suggested_weights: {}, baseline_metrics: {}, candidate_metrics: {}, status: 'pending', auto_apply: false }] },
    async reviewV104IterationShadowSuggestion({ suggestionId, decision, reviewer }) { return { suggestion_id: suggestionId, status: decision, reviewer, auto_apply: false } },
  }
  const licenseAdminClient = {
    configured: true,
    async validateAgentLogin(input) {
      const superUser = input.agentAccount === 'dv1788'
      return { ok: true, account: { code: input.agentAccount, role: superUser ? 'total' : 'manager' }, agent: { code: input.agentAccount, role: superUser ? 'total' : 'manager' } }
    },
  }
  const app = createApp({ autoConnect: false, supabaseClient: writer, licenseAdminClient, v104IterationShadowRuntime: runtime() })
  assert.equal((await app.inject({ url: '/api/v104-iteration-shadow/admin/status' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/v104-iteration-shadow/admin/status?adminSessionToken=leak' })).statusCode, 400)

  const manager = await superSession(app, 'M001', 'manager')
  assert.equal((await app.inject({ url: '/api/v104-iteration-shadow/admin/status', headers: { authorization: `Bearer ${manager}` } })).statusCode, 403)

  const token = await superSession(app)
  const status = await app.inject({ url: '/api/v104-iteration-shadow/admin/status', headers: { authorization: `Bearer ${token}` } })
  const statusBody = JSON.parse(status.body)
  assert.equal(status.statusCode, 200, status.body)
  assert.equal(statusBody.formalStrategyVersion, 'v104')
  assert.equal(statusBody.heads.length, 7)
  assert.equal(statusBody.reports[0].cycleNumber, 1)

  const image = await app.inject({ url: '/api/v104-iteration-shadow/admin/reports/1/image.svg', headers: { authorization: `Bearer ${token}` } })
  assert.equal(image.statusCode, 200)
  assert.match(image.headers['content-type'], /^image\/svg\+xml/)
  assert.match(image.headers['content-security-policy'], /sandbox/)
  assert.match(image.body, /影子預測第1輪/)
  assert.doesNotMatch(image.body, /<script>/)
  assert.equal(durableReads, 4)

  const reviewed = await app.inject({ method: 'POST', url: '/api/v104-iteration-shadow/admin/suggestions/suggestion-1/review', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ decision: 'approved' }) })
  assert.equal(reviewed.statusCode, 200)
  const reviewedBody = JSON.parse(reviewed.body)
  assert.equal(reviewedBody.status, 'approved')
  assert.equal(reviewedBody.auto_apply, false)
})
