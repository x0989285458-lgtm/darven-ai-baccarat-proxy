import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const parent='705e411cc83529c4ff1f544e471a801249d6e5a0'
const workflow='.github/workflows/trusted-release-images-main61.yml'
const migration='supabase/migrations/20260828110000_v105_capture_outbox_three_tier_adaptive_batch.sql'
const harness='scripts/test-main61-three-tier-adaptive-batch-migration.mjs'
const self='proxy/test/v105-v10-main61-three-tier-adaptive-batch-release.test.js'
const expected=[workflow,migration,harness,self]
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(); const staged=head===parent; const ref=staged?'':'HEAD'
const text=p=>execFileSync('git',['show',`${ref}:${p}`],{cwd:root,encoding:'utf8'})
test('Main61 is an exact four-file migration release over Main60',()=>{
 const delta=execFileSync('git',staged?['diff','--cached','--name-only']:['diff','--name-only',parent,'HEAD'],{cwd:root,encoding:'utf8'}).split('\n').map(x=>x.trim()).filter(Boolean).sort()
 assert.deepEqual(delta,[...expected].sort()); if(!staged) assert.equal(execFileSync('git',['rev-parse','HEAD^'],{cwd:root,encoding:'utf8'}).trim(),parent)
})
test('Main61 binds low ten, middle thirty, and high hundred tiers',()=>{
 const sql=text(migration)
 assert.match(sql,/p_limit integer default 30/)
 assert.match(sql,/offset 300 limit 1[\s\S]*then 100/)
 assert.match(sql,/offset 29 limit 1[\s\S]*then 30[\s\S]*else 10/)
 assert.match(sql,/limit least\(p_limit, \(select batch_policy\.effective_max/)
})
test('Main61 rollback harness freezes production state and verifies all tiers',()=>{
 const code=text(harness)
 assert.match(code,/\.\.\/proxy\/node_modules\/pg\/lib\/index\.js/)
 assert.match(code,/lock table public\.v105_capture_settlement_outbox in share row exclusive mode/)
 assert.match(code,/low\.rows\.length!==10/); assert.match(code,/mid\.rows\.length!==30/); assert.match(code,/high\.rows\.length!==100/)
 assert.match(code,/await db\.query\('rollback'\)/); assert.match(code,/beforeHash!==afterHash/)
})
test('Main61 workflow pins exact image and provenance',()=>{
 const y=text(workflow); assert.match(y,/v105-v10-main\.61/g); assert.match(y,/node-version: '24'/); assert.match(y,/test-main61-three-tier-adaptive-batch-migration\.mjs/); assert.match(y,/Dockerfile\.formal-consumer/); assert.match(y,/--deny-self-hosted-runners/)
})
