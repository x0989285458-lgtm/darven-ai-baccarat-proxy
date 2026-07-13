#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildStableReportFromRows, formatReportText, parseDurationMs } from '../src/stable-report.js'

const options = parseArgs(process.argv.slice(2))
const durationMs = parseDurationMs(options.duration ?? '10m')
const intervalMs = parseDurationMs(options.interval ?? '5s')
const apiBase = String(options.api ?? process.env.DRAVEN_PROXY_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const outDir = String(options.out ?? 'reports')
const startedAt = new Date().toISOString()
const controlToken = String(options.token ?? process.env.PROXY_CONTROL_TOKEN ?? '')
let lastReport = null
let stopped = false

process.on('SIGINT', () => { stopped = true })
process.on('SIGTERM', () => { stopped = true })

await mkdir(outDir, { recursive: true })

try {
  const endAt = Date.now() + durationMs
  while (!stopped && Date.now() <= endAt) {
    await sampleOnce()
    await sleep(intervalMs)
  }
  await sampleOnce()
  await persistReport('final')
  console.log(formatReportText(lastReport))
} catch (error) {
  await persistReport('partial').catch(() => {})
  console.error(`v017 report failed: ${error?.message ?? error}`)
  process.exitCode = 1
}

async function sampleOnce() {
  const payload = await fetchJson(`${apiBase}/api/stable-report/rows?since=${encodeURIComponent(startedAt)}`)
  lastReport = buildStableReportFromRows(payload.rows)
  await persistReport('partial')
}

async function persistReport(kind) {
  if (!lastReport) lastReport = buildStableReportFromRows([])
  const jsonPath = join(outDir, `stable-report-v023-${kind}.json`)
  const mdPath = join(outDir, `stable-report-v023-${kind}.md`)
  await writeFile(jsonPath, JSON.stringify(lastReport, null, 2), 'utf8')
  await writeFile(mdPath, formatReportText(lastReport), 'utf8')
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: controlToken ? { Authorization: `Bearer ${controlToken}` } : undefined })
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`)
  return response.json()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(args) {
  const result = {}
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      console.log(`Draven v023 主預測移除牌面改用路單走勢報表工具\n\n用法:\n  node scripts/stable-capture-report.mjs --duration=10m --interval=5s --preflight=30s --tables=9\n\n輸出:\n  reports/stable-report-v023-partial.json/.md\n  reports/stable-report-v023-final.json/.md`)
      process.exit(0)
    }
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}
