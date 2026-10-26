import {act,cleanup,render,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import App from './App'
import {sourcePipelineFixtures as rows} from './test-fixtures/sourcePipeline'
afterEach(()=>{cleanup();window.sessionStorage.clear();vi.unstubAllGlobals();vi.useRealTimers()})
it('real Worker/Journal/Pusher/Proxy API outputs traverse LiveRoadClient and App DOM, including BAV03A',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(rows.recovery.sourceUpdatedAt))
 window.history.pushState({},'','/');window.sessionStorage.setItem('darven-member-session-token','synthetic-test-token')
 let stream:ReadableStreamDefaultController<Uint8Array>
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  if(url.includes('/member-session'))return{ok:true,status:200,json:async()=>({ok:true,sessionExpiresAt:new Date(Date.now()+600000).toISOString()})}
  if(url.includes('/api/tables/stream'))return{ok:true,status:200,body:new ReadableStream<Uint8Array>({start(c){stream=c;c.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))}})}
  if(url.endsWith('/api/status'))return{ok:true,status:200,json:async()=>({connected:true,authenticated:true,tableCount:1,buildVersion:'v105'})}
  if(url.endsWith('/api/tables'))return{ok:true,status:200,json:async()=>[rows.early]}
  return{ok:false,status:404,json:async()=>({})}
 }))
 render(<App/>);const heading=()=>document.querySelector('.road-card h2')
 await waitFor(()=>expect(heading()).toHaveTextContent('更新中／截至第1局'))
 await waitFor(()=>expect(stream!).toBeDefined())
 for(const [row,label] of [[rows.complete,'路單'],[rows.gap,'路單（更新中／截至第2局）'],[rows.recovery,'路單']] as const){
  await act(async()=>{stream.enqueue(new TextEncoder().encode(`event: tables\ndata: ${JSON.stringify({tables:[row]})}\n\n`))})
  await waitFor(()=>expect(heading()?.textContent).toBe(label))
 }
 expect(document.querySelectorAll('.road-card')).toHaveLength(1)
 expect(document.querySelector('.dashboard-stats-row')).not.toHaveTextContent('更新中')
})
