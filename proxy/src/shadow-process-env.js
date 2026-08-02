export const DIRECT_DATABASE_ENV_KEYS = Object.freeze([
  'SUPABASE_DB_CONNECTION_STRING',
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSERVICE',
  'PGSERVICEFILE',
])

export function scrubDirectDatabaseEnv(env = {}) {
  for (const key of DIRECT_DATABASE_ENV_KEYS) delete env[key]
  return env
}
