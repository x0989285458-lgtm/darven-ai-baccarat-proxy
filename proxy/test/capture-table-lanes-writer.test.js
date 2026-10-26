import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseIngestionClient } from '../src/supabase-writer.js'
test('versioned table work Writer routes exact lease through direct DB and rejects negative ACK', async () => {
 const calls=[]; let ok=true
 const writer=createSupabaseIngestionClient({ strategyPool:{ query:async q=>{calls.push(q); return {rows:q.text.includes('select *')?[{id:'7'}]:[{ack:{ok,id:7}}]}}}, url:'https://offline.invalid', serviceKey:'synthetic', fetchImpl:()=>{throw Error('network forbidden')} })
 assert.equal(typeof writer.claimCaptureTableWork,'function')
 assert.deepEqual(await writer.claimCaptureTableWork({limit:1}),[{id:'7'}])
 await writer.completeCaptureTableWork({id:'7',claimToken:'lease',attempt:2})
 assert.deepEqual(calls.at(-1).values,['7','lease',2])
 ok=false
 await assert.rejects(writer.failCaptureTableWork({id:'7',claimToken:'lease',attempt:2,error:'gap'}),/acknowledgement/)
 assert.match(calls.at(-1).text,/fail_v105_capture_table_work_v1/)
})
