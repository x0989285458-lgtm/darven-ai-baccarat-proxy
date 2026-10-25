import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const AGE=86400000, SEGMENT=8388608, RESERVE=268435456
// This module executes disk work only in its dedicated child, never the capture pool.
export function createAuditDiskWriter(directory,{io=fs,now=Date.now,onGap=()=>{}}={}){
 if(!directory.endsWith('.delivery-audit-v1'))throw Error('directory_scope')
 io.mkdirSync(directory,{recursive:true,mode:0o700})
 if(io.lstatSync(directory).isSymbolicLink())throw Error('directory_scope')
 let current=null, expiry=null
 const pattern=/^receipt-(\d+)-[a-f0-9-]+\.jsonl$/
 function inventory(){return io.readdirSync(directory).filter(n=>pattern.test(n)).map(name=>{const p=path.join(directory,name),s=io.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('directory_scope');return {name,path:p,time:Number(name.match(pattern)[1]),size:s.size}}).sort((a,b)=>a.time-b.time||a.name.localeCompare(b.name))}
 if(inventory().length)onGap('preexisting_audit_history')
 function sweep(){clearTimeout(expiry);const ts=now();let files=inventory();for(const f of files){if(ts-f.time>=AGE){onGap('retention_deleted');io.unlinkSync(f.path);if(current===f.path)current=null}}
  files=inventory();if(files.length){expiry=setTimeout(()=>{try{sweep()}catch{process.exitCode=1;process.disconnect?.()}},Math.max(1,files[0].time+AGE-ts));expiry.unref?.()}return files}
 return {append(record){
  const data=Buffer.from(JSON.stringify(record)+'\n');if(data.length>16384)throw Error('record_capacity')
  const space=io.statfsSync(directory);if(Number(space.bavail)*Number(space.bsize)<RESERVE)throw Error('disk_reserve')
  let files=sweep();let f=files.find(f=>f.path===current)
  if(!f||f.size+data.length>SEGMENT){while(files.length>=4){const old=files.shift();onGap('retention_deleted');io.unlinkSync(old.path)}current=path.join(directory,`receipt-${now()}-${randomUUID()}.jsonl`);f=null}
  const fd=io.openSync(current,f?'a':'wx',0o600)
  try{let offset=0;while(offset<data.length){const n=io.writeSync(fd,data,offset,data.length-offset);if(n<=0)throw Error('short_write');offset+=n}io.fsyncSync(fd)}finally{io.closeSync(fd)}
  sweep()
 },close(){clearTimeout(expiry)}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let writer
 process.on('disconnect',()=>{writer?.close();process.exit(0)})
 process.on('message',m=>{
  try{writer??=createAuditDiskWriter(process.argv[2],{onGap:gap=>process.send?.({gap})});writer.append(m.record);process.send?.({id:m.id,ok:true})}
  catch(e){process.send?.({id:m.id,ok:false,error:e?.code==='ENOSPC'?'ENOSPC':e?.message==='disk_reserve'?'disk_reserve':'child_error'})}
 })
}
