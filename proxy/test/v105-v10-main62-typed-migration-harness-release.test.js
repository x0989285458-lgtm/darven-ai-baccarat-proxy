import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const parent='6dc5672577bea7625feda541a53ab2a43b632b7e'
const workflow='.github/workflows/trusted-release-images-main62.yml'
const harness='scripts/test-main61-three-tier-adaptive-batch-migration.mjs'
const self='proxy/test/v105-v10-main62-typed-migration-harness-release.test.js'
const migration='supabase/migrations/20260828110000_v105_capture_outbox_three_tier_adaptive_batch.sql'
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),staged=head===parent,ref=staged?'':'HEAD'
const blob=p=>execFileSync('git',['show',`${ref}:${p}`],{cwd:root,encoding:null})
const text=p=>blob(p).toString('utf8')
test('Main62 exact three-file correction over immutable Main61',()=>{const d=execFileSync('git',staged?['diff','--cached','--name-only']:['diff','--name-only',parent,'HEAD'],{cwd:root,encoding:'utf8'}).split('\n').map(x=>x.trim()).filter(Boolean).sort();assert.deepEqual(d,[workflow,harness,self].sort());if(!staged)assert.equal(execFileSync('git',['rev-parse','HEAD^'],{cwd:root,encoding:'utf8'}).trim(),parent)})
test('Main62 explicitly types every repeated harness parameter',()=>{const c=text(harness);assert.match(c,/\$\{b\+1\}::text/);assert.match(c,/\$\{b\+2\}::bigint/);assert.match(c,/\$\{b\+3\}::jsonb/);assert.match(c,/bigint::text/);assert.match(c,/bigint\*interval/)})
test('Main62 preserves exact reviewed Main61 migration',()=>{assert.equal(createHash('sha256').update(blob(migration)).digest('hex'),'cdd477daef664e9fc86f5321d3e18e915c4b5337193d53f9e67ca7a1ddd0064c')})
test('Main62 workflow pins exact image and provenance',()=>{const y=text(workflow);assert.match(y,/v105-v10-main\.62/g);assert.match(y,/node-version: '24'/);assert.match(y,/Dockerfile\.formal-consumer/);assert.match(y,/--deny-self-hosted-runners/)})
