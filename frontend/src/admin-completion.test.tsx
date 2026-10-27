import { afterEach, expect, it, vi } from 'vitest'
import { getCloudDataStatus, getOnlineLicenseStatus, createOnlineLicense } from './lib/onlineLicenseClient'
import { checkSupabaseConnection } from './lib/supabaseClient'
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
afterEach(() => vi.restoreAllMocks())
it('D04 rejects unknown write JSON without replaying POST', async () => {
  const send = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw Error('broken JSON') } }) as unknown as Response)
  await expect(createOnlineLicense({ memberAccount: 'offline', code: 'offline_001', agentCode: 'offline', durationDays: 1 }, send)).rejects.toThrow()
  expect(send).toHaveBeenCalledTimes(1)
})

it('D01 distinguishes transport error from successful empty status', async () => {
 const bad = await getOnlineLicenseStatus(async () => { throw Error('offline') })
 expect(bad).toMatchObject({ state: 'error' })
 const good = await getOnlineLicenseStatus(async () => response({ configured:true, licenses:[], agents:[] }))
 expect(good).toMatchObject({ state:'ready', licenseRows:[] })
})

it('D08 malformed JSON is not healthy and next read recovers', async () => {
 const bad = vi.fn(async () => ({ ok:true, json: async () => { throw Error('bad') } }) as unknown as Response)
 expect((await checkSupabaseConnection('offline-session', bad)).ok).toBe(false)
 expect((await checkSupabaseConnection('offline-session', async () => response({configured:true}))).ok).toBe(true)
})

it('D03 cloud JSON rejection is controlled', async () => {
 const bad = vi.fn(async () => ({ok:true,json: async () => {throw Error('bad')}}) as unknown as Response)
 await expect(getCloudDataStatus(bad)).resolves.toMatchObject({ok:false})
})

import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import App from './App'
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear() })
let rows = [{member:'offline-member',code:'offline_001',status:'啟用中',remain:'3天'}]
function mountAdmin(extra?: (url:string, init?:RequestInit) => Response | Promise<Response> | undefined) {
 history.pushState({}, '', '/admin');sessionStorage.setItem('darven-admin-account','dv1788');sessionStorage.setItem('darven-admin-role','super');sessionStorage.setItem('darven-admin-session-token','offline-session')
 const send = vi.fn(async (url: string, init?:RequestInit) => {
  const custom = extra?.(url,init); if(custom) return custom
  if(url.includes('/online-license/status')) return response({configured:true,licenseRows:rows,agentRows:[]})
  if(url.includes('/online-core/status')) return response({connected:true,settings:{frontend:{ui_defaults:{theme:'keep',maintenanceMode:false}}}})
  if(url.includes('/cloud-data/status')) return response({ok:true,todayRoundCount:12,tableStats:[],dailyReports:[]})
  if(init?.method==='POST') return response({ok:true})
  return response({connected:true,items:[],reports:[],strategies:[],strategyRows:[]})
 });vi.stubGlobal('fetch',send);return {send,...render(<App />)}
}
it('D01 UI never falls back to demo data and retries failed status', async () => {
 vi.useFakeTimers(); let fail=true
 mountAdmin((url) => url.includes('/online-license/status') && fail ? Promise.reject(Error('offline')) : undefined)
 await act(async () => {})
 expect(screen.queryByText('Agent001_001')).not.toBeInTheDocument()
 expect(screen.getByText(/授權資料讀取失敗/)).toBeInTheDocument()
 fail=false; await act(async () => {await vi.advanceTimersByTimeAsync(5000)})
 expect(screen.getByText('offline_001')).toBeInTheDocument()
})

it('D02 database status recovers on same page', async () => {
 vi.useFakeTimers();let fail=true
 mountAdmin(url => url.includes('/online-license/status') && fail ? Promise.reject(Error('offline')) : undefined)
 await act(async()=>{}); expect(screen.getByText('授權後端連線失敗')).toBeInTheDocument()
 fail=false;await act(async()=>{await vi.advanceTimersByTimeAsync(15000)})
 expect(within(screen.getByText('資料庫').closest('article')!).getByText('已連線')).toBeInTheDocument()
})

it('D03 keeps authoritative last-good reports, unknown before load, bounded retries and abort on unmount', async () => {
 vi.useFakeTimers();let fail=true;let calls=0;let signal:AbortSignal|undefined
 const view=mountAdmin((url,init)=>{if(!url.includes('/cloud-data/status'))return;calls++;signal=init?.signal as AbortSignal;return fail ? Promise.reject(Error('offline')) : response({ok:true,todayRoundCount:77,tableStats:[],dailyReports:[]})})
 await act(async()=>{});expect(screen.queryByText('已抓 0 局')).not.toBeInTheDocument();expect(screen.getByText(/報表.*過期|報表.*未讀取/)).toBeInTheDocument()
 fail=false;await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(screen.getByText('已抓 77 局')).toBeInTheDocument();expect(calls).toBe(2)
 await act(async()=>{await vi.advanceTimersByTimeAsync(20000)});expect(calls).toBe(2)
 fail=true;await act(async()=>{await vi.advanceTimersByTimeAsync(300000)})
 expect(screen.getByText('已抓 77 局')).toBeInTheDocument();expect(screen.getByText(/報表.*過期/)).toBeInTheDocument()
 view.unmount();expect(signal?.aborted).toBe(true)
})

it('D05 last license deletion clears list and D04 unknown write reads back without success', async () => {
 rows=[{member:'offline-member',code:'offline_001',status:'啟用中',remain:'3天'}]
 let writes=0
 mountAdmin((url,init)=>{if(init?.method==='POST' && url.includes('/licenses/delete')) {writes++;rows=[];return response({})}})
 await screen.findByText('offline_001');fireEvent.click(screen.getByLabelText('勾選 offline_001'));fireEvent.click(screen.getByText('刪除驗證碼'))
 await waitFor(()=>expect(screen.queryByText('offline_001')).not.toBeInTheDocument())
 expect(writes).toBe(1);expect(screen.queryByText('已刪除選取驗證碼')).not.toBeInTheDocument()
 rows=[{member:'offline-member',code:'offline_001',status:'啟用中',remain:'3天'}]
})

it('D06 each code uses its own clamped extension days', async () => {
 rows=[{member:'offline-member',code:'offline_001',status:'啟用中',remain:'3天'}]
 const {send}=mountAdmin();await screen.findByText('offline_001')
 fireEvent.change(screen.getByPlaceholderText('延長1-30天'),{target:{value:'7'}})
 fireEvent.click(screen.getByLabelText('勾選 offline_001'));fireEvent.click(screen.getByText('延長驗證碼'))
 await waitFor(()=>expect(send.mock.calls.some(([url,init])=>url.includes('/licenses/extend') && JSON.parse(String(init?.body)).days===7)).toBe(true))
})

it('D09 joins shuffled missing tables by canonical tableId without aggregate category fallbacks', async () => {
 mountAdmin(url=>url.includes('/cloud-data/status') ? response({ok:true,todayRoundCount:10,tableStats:[{tableId:'BAV02',mainHitRate:'62%',sideHitRate:'12%'},{tableId:'BAV01',mainHitRate:'51%',sideHitRate:'11%'}],dailyReports:[{date:'offline-day',rounds:10,side_hit_rate:99,main_hit_rate:88}]}) : undefined)
 await screen.findByText('已抓 10 局')
 expect(screen.getByText('1桌').parentElement).toHaveTextContent('主命中率 51%')
 expect(screen.getByText('2桌').parentElement).toHaveTextContent('主命中率 62%')
 expect(screen.getByText('3桌').parentElement).toHaveTextContent('無資料')
 expect(screen.queryByText('99%')).not.toBeInTheDocument()
 expect(screen.getAllByText(/^[0-9]+A?桌$/)).toHaveLength(10)
})

it('D07 maintenance merges fresh settings, verifies readback and provides disable', async () => {
 let enabled=false;let posted:any
 mountAdmin((url,init)=>{
  if(url.includes('/online-core/status'))return response({connected:true,settings:{frontend:{ui_defaults:{theme:'keep',maintenanceMode:enabled}}}})
  if(url.includes('/online-core/settings')) {posted=JSON.parse(String(init?.body));enabled=posted.value.maintenanceMode;return response({ok:true,result:{ok:true}})}
 })
 fireEvent.click(await screen.findByText('啟用維護模式'))
 await screen.findByText('停用維護模式');expect(posted.value).toMatchObject({theme:'keep',maintenanceMode:true})
 fireEvent.click(screen.getByText('停用維護模式'));await screen.findByText('啟用維護模式');expect(posted.value.maintenanceMode).toBe(false)
})

it('D07 missing settings fail closed without POST', async () => {
 const {send}=mountAdmin(url=>url.includes('/online-core/status') ? response({connected:true}) : undefined)
 fireEvent.click(await screen.findByText('啟用維護模式'))
 await screen.findByText(/現有設定.*未送出/)
 expect(send.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0)
})
