import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ACTIONS = new Set(['backup', 'restore', 'drill'])
const action = process.argv[2] || 'backup'
const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || ''
const restoreDbUrl = process.env.V094_RESTORE_DB_URL || ''
const backupDir = resolve(process.env.V094_BACKUP_DIR || join(process.cwd(), 'backups'))
const backupFile = resolve(process.env.V094_BACKUP_FILE || join(backupDir, `supabase-v094-${timestamp()}.dump`))
const restoreFile = resolve(process.env.V094_RESTORE_FILE || backupFile)
const criticalTables = [
  'public.cloud_capture_status',
  'public.cloud_table_snapshots',
  'public.cloud_table_rounds',
  'public.daily_roadmap_events',
  'public.daily_prediction_results',
  'public.cloud_strategy_reports',
  'public.cloud_strategy_adjustment_stats',
  'public.cloud_operational_events',
  'public.schema_migration_versions',
]

if (!ACTIONS.has(action)) fail(`未知動作：${action}。可用：backup / restore / drill`)
if (!dbUrl) fail('缺少 SUPABASE_DB_URL 或 DATABASE_URL；腳本不會要求或列印 secret。')
if (action !== 'backup' && !restoreDbUrl) fail('restore / drill 必須設定 V094_RESTORE_DB_URL，禁止預設覆蓋來源資料庫。')
if (action !== 'backup' && restoreDbUrl === dbUrl) fail('V094_RESTORE_DB_URL 不得與來源資料庫相同。')
if (action !== 'backup' && process.env.V094_ALLOW_RESTORE !== '確認還原') fail('restore / drill 必須設定 V094_ALLOW_RESTORE=確認還原。')
mkdirSync(backupDir, { recursive: true })

if (action === 'backup') {
  await backup(backupFile)
  console.log(`v094 備份完成：${backupFile}`)
} else if (action === 'restore') {
  if (!existsSync(restoreFile)) fail(`找不到還原檔：${restoreFile}`)
  await restore(restoreFile)
  console.log(`v094 還原演練完成：${restoreFile}`)
} else {
  await backup(backupFile)
  await restore(backupFile)
  console.log(`v094 備份＋還原演練完成：${backupFile}`)
}

async function backup(file) {
  const args = ['--format=custom', '--no-owner', '--no-acl', '--file', file]
  for (const table of criticalTables) args.push('--table', table)
  await run('pg_dump', args, dbUrl)
}

async function restore(file) {
  const args = ['--clean', '--if-exists', '--no-owner', '--no-acl', file]
  await run('pg_restore', args, restoreDbUrl)
}

function run(command, args, databaseUrl) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGDATABASE: databaseUrl },
    })
    child.stdout.on('data', (chunk) => process.stdout.write(redact(chunk)))
    child.stderr.on('data', (chunk) => process.stderr.write(redact(chunk)))
    child.on('error', (error) => reject(new Error(`${command} 無法執行：${error.message}`)))
    child.on('close', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} 退出碼 ${code}`)))
  })
}

function redact(chunk) {
  return String(chunk)
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]')
    .replace(/(password=)[^\s]+/gi, '$1[redacted]')
    .replace(/(sb_secret_[A-Za-z0-9._-]+)/g, '[redacted]')
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

function fail(message) {
  console.error(`v094 備份還原停止：${message}`)
  process.exit(1)
}
