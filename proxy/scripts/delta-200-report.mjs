#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluateFiveRoadPrediction, parseDurationMs, SIDE_PREDICTION_THRESHOLDS } from '../src/stable-report.js'
import { createOnlineCoreClient } from '../src/online-core.js'
import { loadLocalEnv } from '../src/config.js'
import { persistFinalLiveReport } from '../src/test-report-persistence.js'

const args = parseArgs(process.argv.slice(2))
loadLocalEnv()
const apiBase = String(args.api ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const outDir = String(args.out ?? 'reports')
const targetRounds = Number(args.rounds ?? 200)
const tableLimit = Number(args.tables ?? 9)
const intervalMs = parseDurationMs(args.interval ?? '2s')
const maxMs = parseDurationMs(args.max ?? '90m')
const startedAt = new Date().toISOString()
await mkdir(outDir, { recursive: true })

const state = { tables: new Map(), prev: new Map(), events: [], startedAt, endedAt: null }
let stopped = false
process.on('SIGINT', () => { stopped = true })
process.on('SIGTERM', () => { stopped = true })

const first = await fetchSnapshot()
for (const table of first.tables.slice(0, tableLimit)) state.prev.set(table.tableId, table)
await persist('partial')
const deadline = Date.now() + maxMs
while (!stopped && Date.now() < deadline && state.events.length < targetRounds) {
  await sleep(intervalMs)
  const snap = await fetchSnapshot()
  processSnapshot(snap)
  await persist('partial')
  process.stdout.write(`
rounds=${state.events.length}/${targetRounds}`)
}
state.endedAt = new Date().toISOString()
await persist('final')
const memoryResult = await persistFinalLiveReport(buildReport(), {
  onlineCoreClient: createOnlineCoreClient(),
  projectSlug: args.project ?? 'ai-baccarat',
  strategyVersion: args.strategy ?? 'v034-auto-memory',
  reportType: args.reportType ?? `${targetRounds}_round_live_test`,
  reportPath: args.reportPath ?? `proxy/reports/draven-v034-${targetRounds}-round-report.png`,
  metadata: { source: 'local_chrome', tables: tableLimit, targetRounds },
})
await writeFile(join(outDir, `delta-200-v023-memory.json`), JSON.stringify(memoryResult, null, 2), 'utf8')
console.log(`\n記憶網站回傳：${memoryResult.ok ? '成功' : memoryResult.skipped ? `略過(${memoryResult.reason})` : '完成'}`)
console.log('\n' + formatReport(buildReport()))

async function fetchSnapshot() {
  const res = await fetch(`${apiBase}/api/snapshot`)
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`)
  const snap = await res.json()
  if (snap?.status?.connected !== true || snap?.status?.authenticated === false) throw new Error('proxy not connected/authenticated')
  return snap
}

function processSnapshot(snap) {
  const tables = (snap.tables ?? []).slice(0, tableLimit)
  const globalStats = summarizeGlobal(tables)
  for (const table of tables) {
    const prev = state.prev.get(table.tableId)
    if (!prev) { state.prev.set(table.tableId, table); continue }
    const prediction = evaluateFiveRoadPrediction(prev, { globalStats })
    const side = predictSide(prev)
    const diffs = countDiffs(prev, table)
    for (const winner of expandWinners(diffs).slice(0, Math.max(0, targetRounds - state.events.length))) {
      recordEvent(prev, table, prediction, side, winner, diffs)
    }
    state.prev.set(table.tableId, table)
  }
}

function recordEvent(prev, table, prediction, side, winner, diffs) {
  const actual = winner === 'banker' ? '莊' : winner === 'player' ? '閒' : '和'
  const mainEvaluated = actual !== '和'
  const mainHit = mainEvaluated && prediction.main === actual
  const sideActuals = {
    tie: actual === '和',
    bankerPair: diffs.bankerPair > 0,
    playerPair: diffs.playerPair > 0,
  }
  const sideActions = Object.entries(side).filter(([k, v]) => v >= (SIDE_PREDICTION_THRESHOLDS[k] ?? Infinity))
  const verifiableSideActions = sideActions.filter(([k]) => k in sideActuals)
  const sideHits = verifiableSideActions.filter(([k]) => sideActuals[k]).length
  const slot = Array.from(state.prev.keys()).indexOf(table.tableId) + 1
  const displayName = table.displayName ?? prev.displayName ?? table.tableId
  const summary = ensureTable(table.tableId, displayName, slot)
  summary.rounds += 1
  if (mainEvaluated) {
    summary.mainEvaluated += 1
    if (mainHit) summary.hits += 1
    else summary.misses += 1
  } else summary.pushes += 1
  summary.sideActions += verifiableSideActions.length
  summary.sideHits += sideHits
  summary.lastPrediction = prediction.main
  summary.lastConfidence = prediction.confidence
  summary.lastWinner = actual
  summary.lastDiagnostics = {
    sourceScores: prediction.sourceScores,
    weightAblation: prediction.weightAblation,
    confidenceCalibration: prediction.confidenceCalibration,
    tablePerformance: prediction.tablePerformance,
    patterns: prediction.patterns,
    cardShoeFeatures: prediction.cardShoeFeatures,
  }
  state.events.push({
    no: state.events.length + 1,
    at: new Date().toISOString(),
    tableId: table.tableId,
    displayName,
    shoe: table.shoe,
    round: table.round,
    prediction: prediction.main,
    confidence: prediction.confidence,
    actual,
    mainHit,
    mainEvaluated,
    side,
    sideActions: verifiableSideActions.map(([k, probability]) => ({ key: k, probability, hit: Boolean(sideActuals[k]) })),
    diagnostics: summary.lastDiagnostics,
  })
}

function ensureTable(tableId, displayName, slot) {
  if (!state.tables.has(tableId)) state.tables.set(tableId, { tableId, displayName, slot, rounds: 0, hits: 0, misses: 0, pushes: 0, mainEvaluated: 0, sideActions: 0, sideHits: 0 })
  return state.tables.get(tableId)
}

function countDiffs(a, b) {
  return {
    banker: Math.max(0, Number(b.bankerCount ?? 0) - Number(a.bankerCount ?? 0)),
    player: Math.max(0, Number(b.playerCount ?? 0) - Number(a.playerCount ?? 0)),
    tie: Math.max(0, Number(b.tieCount ?? 0) - Number(a.tieCount ?? 0)),
    bankerPair: Math.max(0, Number(b.bankerPairCount ?? 0) - Number(a.bankerPairCount ?? 0)),
    playerPair: Math.max(0, Number(b.playerPairCount ?? 0) - Number(a.playerPairCount ?? 0)),
  }
}
function expandWinners(d) { return [...Array(d.banker).fill('banker'), ...Array(d.player).fill('player'), ...Array(d.tie).fill('tie')] }
function summarizeGlobal(tables) { return tables.reduce((a,t)=>({ banker:a.banker+Number(t.bankerCount??0), player:a.player+Number(t.playerCount??0), tie:a.tie+Number(t.tieCount??0)}),{banker:0,player:0,tie:0}) }
function predictSide(table) {
  const banker=Number(table.bankerCount??0), player=Number(table.playerCount??0), tie=Number(table.tieCount??0)
  const total=Math.max(1,banker+player+tie)
  const pct=(n,d=total)=>Number(((n/d)*100).toFixed(1))
  const clamp=(v)=>Math.max(0,Math.min(80,Number(v.toFixed(1))))
  const br=pct(banker), pr=pct(player)
  return { tie:pct(tie), superSix:clamp(br*0.12), bankerPair:pct(Number(table.bankerPairCount??0)), playerPair:pct(Number(table.playerPairCount??0)), bankerDragon:clamp(br*0.36), playerDragon:clamp(pr*0.36) }
}
function buildReport() {
  const tables=[...state.tables.values()].sort((a,b)=>a.slot-b.slot).map(t=>({...t, hitRate:pct(t.hits,t.mainEvaluated), sideHitRate:pct(t.sideHits,t.sideActions)}))
  const total=tables.reduce((a,t)=>({rounds:a.rounds+t.rounds,hits:a.hits+t.hits,misses:a.misses+t.misses,pushes:a.pushes+t.pushes,mainEvaluated:a.mainEvaluated+t.mainEvaluated,sideActions:a.sideActions+t.sideActions,sideHits:a.sideHits+t.sideHits}),{rounds:0,hits:0,misses:0,pushes:0,mainEvaluated:0,sideActions:0,sideHits:0})
  return { title:`Draven v034 1-9桌 ${targetRounds}局自動回傳實測結果`, startedAt:state.startedAt, endedAt:state.endedAt??new Date().toISOString(), total:{...total, hitRate:pct(total.hits,total.mainEvaluated), sideHitRate:pct(total.sideHits,total.sideActions)}, tables, events:state.events }
}
function formatReport(r) {
  const lines=[`## ${r.title}`,'',`局數：${r.total.rounds} / ${targetRounds}`,`主預測命中率：${r.total.hitRate}%（命中 ${r.total.hits} / 未中 ${r.total.misses} / 和局不計 ${r.total.pushes} / 主統計 ${r.total.mainEvaluated}）`,`副預測可驗證出手命中率：${r.total.sideHitRate}%（出手 ${r.total.sideActions} / 命中 ${r.total.sideHits}；僅統計和局/莊對/閒對）`,'','| 桌台 | 局數 | 主命中 | 主未中 | 和局不計 | 主命中率 | 副出手 | 副命中 | 最後預測→結果 |','|---|---:|---:|---:|---:|---:|---:|---:|---|']
  for (const t of r.tables) lines.push(`| ${t.displayName} | ${t.rounds} | ${t.hits} | ${t.misses} | ${t.pushes} | ${t.hitRate}% | ${t.sideActions} | ${t.sideHits} | ${t.lastPrediction ?? '-'}(${t.lastConfidence ?? '-'}%)→${t.lastWinner ?? '-'} |`)
  return lines.join('\n')
}
async function persist(kind) { const r=buildReport(); await writeFile(join(outDir,`delta-200-v023-${kind}.json`),JSON.stringify(r,null,2),'utf8'); await writeFile(join(outDir,`delta-200-v023-${kind}.md`),formatReport(r),'utf8') }
function pct(a,b){ return b ? Number(((a/b)*100).toFixed(1)) : 0 }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }
function parseArgs(args){ const o={}; for (const arg of args){ const m=arg.match(/^--([^=]+)=(.*)$/); if(m)o[m[1]]=m[2] } return o }
