import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.SUPABASE_DB_CONNECTION_STRING
delete env.SUPABASE_SERVICE_ROLE_KEY
delete env.SUPABASE_SECRET_KEY
delete env.DATABASE_URL
delete env.POSTGRES_URL
delete env.POSTGRES_PRISMA_URL
delete env.POSTGRES_URL_NON_POOLING
delete env.PGHOST
delete env.PGPORT
delete env.PGDATABASE
delete env.PGUSER
delete env.PGPASSWORD
delete env.PGSERVICE
delete env.PGSERVICEFILE

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  shell: false,
})

child.once('error', (error) => {
  process.stderr.write(`test runner failed: ${error?.message ?? String(error)}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`test runner stopped by ${signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = Number.isInteger(code) ? code : 1
})
