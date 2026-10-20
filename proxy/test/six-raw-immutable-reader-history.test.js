import { importHistoricalModule } from './helpers/immutable-six-raw-history.mjs'

// Execute the original BAG reader/restore test bytes and entire repository-owned
// source graph from the fixed predecessor. Current counterparts remain in their
// original files and six-raw-current-reader-contract.test.js. No skip or fallback.
for (const file of [
  'cloud-supabase-writer.test.js',
  'final-statistics.test.js',
  'prediction-integrity.test.js',
  'v105-shadow-compact-hydration.test.js',
]) {
  await importHistoricalModule(`proxy/test/${file}`)
}
