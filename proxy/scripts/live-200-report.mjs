#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildStableReportFromRows, formatReportText, parseDurationMs } from '../src/stable-report.js'

const options = parseArgs(process.argv.slice(2))
const apiBase = String(options.api ?? process.env.DRAVEN_PROXY_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const outDir = String(options.out ?? 'reports')
const targetRounds = Number(options.rounds ?? 200)
const intervalMs = parseDurationMs(options.interval ?? '5s')
const maxMs = parseDurationMs(options.max ?? '90m')
const startedAt = new Date().toISOString()
const controlToken = String(options.token ?? process.env.PROXY_CONTROL_TOKEN ?? '')
let lastReport = null
let stopped = false
process.on('SIGINT', () => { stopped = true })
process.on('SIGTERM', () => { stopped = true })
await mkdir(outDir, { recursive: true })
try {
  const deadline = Date.now() + maxMs
  while (!stopped && Date.now() <= deadline) {
    await sampleOnce()
    const total = lastReport?.total?.rounds ?? 0
    process.stdout.write(`
rounds=${total}/${targetRounds} main=${lastReport?.total?.hitRate ?? 0}% side=${lastReport?.total?.sideHitRate ?? 0}%   `)
    if (total >= targetRounds) break
    await sleep(intervalMs)
  }
  await sampleOnce()
  await persistReport('final')
  console.log('\n' + formatReportText(lastReport))
} catch (error) {
  await persistReport('partial').catch(() => {})
  console.error(`live 200 report failed: ${error?.message ?? error}`)
  process.exitCode = 1
}

async function sampleOnce() {
  const payload = await fetchJson(`${apiBase}/api/stable-report/rows?since=${encodeURIComponent(startedAt)}`)
  lastReport = buildStableReportFromRows(payload.rows)
  await persistReport('partial')
}
async function persistReport(kind) {
  if (!lastReport) lastReport = buildStableReportFromRows([])
  const jsonPath = join(outDir, `live-200-v023-${kind}.json`)
  const mdPath = join(outDir, `live-200-v023-${kind}.md`)
  await writeFile(jsonPath, JSON.stringify(lastReport, null, 2), 'utf8')
  await writeFile(mdPath, formatReportText(lastReport), 'utf8')
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: controlToken ? { Authorization: `Bearer ${controlToken}` } : undefined })
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`)
  return response.json()
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function parseArgs(args) {
  const result = {}
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}
