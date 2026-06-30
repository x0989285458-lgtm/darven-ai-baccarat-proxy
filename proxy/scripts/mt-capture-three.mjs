import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const token = process.env.MT_TOKEN;
if (!token) throw new Error('MT_TOKEN env var is required');
const url = `https://gsa.ofalive99.net/?token=${encodeURIComponent(token)}&lang=zhtw`;
const port = Number(process.env.CHROME_CDP_PORT || 9237);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const userDataDir = process.env.CHROME_USER_DATA_DIR || 'C:/Users/童威仁/AppData/Local/hermes/chrome-profiles/mt-capture-three';
const maxMinutes = Number(process.env.MAX_MINUTES || 20);
const desired = Number(process.env.DESIRED_RESULTS || 3);
const outDir = process.env.OUT_DIR || 'C:/Users/童威仁/mt-capture-output';
const filterFirstTable = process.env.FILTER_FIRST_TABLE === 'true';
mkdirSync(outDir, { recursive: true });

let msgId = 0;
let cdp;
let chrome;
const started = Date.now();
const rawMatches = [];
const tables = new Map();
let firstBacTable = null;
const pending = new Map();
const confirmed = [];
const seenKeys = new Set();
let frames = 0;
let lastFrameAt = null;
let clicked = false;

function log(...args) { console.log(new Date().toISOString(), ...args); }
function sanitize(s) { return String(s).replaceAll(token, '[REDACTED]').replace(/token=([^&\"']+)/ig, 'token=[REDACTED]'); }
function jsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
function winnerName(w) { return String(w) === '1' ? '閒' : String(w) === '2' ? '莊' : String(w) === '3' ? '和' : String(w); }
function asArr(x) { return Array.isArray(x) ? x : null; }
function resultFrom(obj) { return asArr(obj?.body?.result) || asArr(obj?.msg?.result) || asArr(obj?.data?.result) || asArr(obj?.result); }
function tableIdFrom(obj) { return obj?.body?.table_id ?? obj?.body?.tableId ?? obj?.body?.table ?? obj?.msg?.table_id ?? obj?.data?.table_id ?? obj?.table_id ?? obj?.tableId ?? obj?.tid; }
function shoeFrom(obj) { return obj?.body?.shoe ?? obj?.body?.shoe_id ?? obj?.body?.shoe_num ?? obj?.body?.current_shoe ?? obj?.msg?.shoe ?? obj?.data?.shoe ?? obj?.shoe ?? obj?.current_shoe; }
function roundFrom(obj) { return obj?.body?.round ?? obj?.body?.round_id ?? obj?.body?.round_num ?? obj?.body?.current_round ?? obj?.msg?.round ?? obj?.data?.round ?? obj?.round ?? obj?.current_round; }
function winnerFrom(obj) { return obj?.body?.winner ?? obj?.body?.win ?? obj?.msg?.winner ?? obj?.data?.winner ?? obj?.winner; }
function actionOf(obj) { return String(obj?.action ?? obj?.cmd ?? obj?.event ?? obj?.type ?? obj?.name ?? ''); }
function addTables(arr) {
  for (const [idx, t] of arr.entries()) {
    const id = t?.table_id ?? t?.id ?? t?.tableId;
    if (!id) continue;
    tables.set(String(id), t);
    const type = String(t?.table_type ?? t?.type ?? '').toUpperCase();
    if (!firstBacTable && (type.includes('BAC') || type === 'B')) {
      firstBacTable = { id: String(id), name: t?.table_name ?? t?.name ?? String(idx + 1), index: idx, type };
      log('FIRST_BAC_TABLE', JSON.stringify(firstBacTable));
    }
  }
}
function walk(obj, cb, depth=0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  cb(obj);
  if (Array.isArray(obj)) { for (const v of obj) walk(v, cb, depth+1); }
  else { for (const v of Object.values(obj)) walk(v, cb, depth+1); }
}
function keyFor(obj) { return `${tableIdFrom(obj) ?? ''}|${shoeFrom(obj) ?? ''}|${roundFrom(obj) ?? ''}`; }
function mergeRound(obj, source, rawPayload) {
  const tid = tableIdFrom(obj); const result = resultFrom(obj); const winner = winnerFrom(obj); const shoe = shoeFrom(obj); const round = roundFrom(obj);
  if (!tid && !result && winner == null) return;
  if (filterFirstTable) {
    if (!firstBacTable) return;
    if (tid == null || String(tid) !== String(firstBacTable.id)) return;
  }
  const k = keyFor(obj); if (k === '||') return;
  const cur = pending.get(k) || { table_id: tid ?? null, shoe: shoe ?? null, round: round ?? null, raw_result: null, sources: [], raw_samples: [] };
  if (tid != null) cur.table_id = tid; if (shoe != null) cur.shoe = shoe; if (round != null) cur.round = round; if (result) cur.raw_result = result; if (winner != null) cur.winner = winner;
  cur.sources.push(source); if (cur.raw_samples.length < 3) cur.raw_samples.push(sanitize(rawPayload).slice(0, 2000)); pending.set(k, cur);
  if (cur.raw_result && cur.raw_result.length >= 10 && cur.winner != null && cur.table_id != null && cur.shoe != null && cur.round != null) {
    const ck = `${cur.table_id}|${cur.shoe}|${cur.round}|${JSON.stringify(cur.raw_result)}|${cur.winner}`;
    if (!seenKeys.has(ck)) {
      seenKeys.add(ck);
      const item = { table_id: String(cur.table_id), shoe: cur.shoe, round: cur.round, player_points: cur.raw_result[8], banker_points: cur.raw_result[9], winner: winnerName(cur.winner), winner_code: cur.winner, raw_result: cur.raw_result, sources: [...new Set(cur.sources)] };
      confirmed.push(item); log('CONFIRMED_RESULT', JSON.stringify(item));
    }
  }
}
async function waitForCdp() { for (let i=0;i<100;i++) { try { const r=await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch {} await delay(200); } throw new Error('CDP not ready'); }
async function pickPage() { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || tabs[0]; }
function send(method, params={}) { return new Promise((resolve, reject) => { const id = ++msgId; const timer = setTimeout(()=>reject(new Error(`${method} timeout`)), 10000); function on(raw) { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.id === id) { clearTimeout(timer); cdp.off('message', on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } } cdp.on('message', on); cdp.send(JSON.stringify({ id, method, params })); }); }
async function tryClickFirstBac() {
  if (clicked || !firstBacTable || !cdp || cdp.readyState !== WebSocket.OPEN) return; clicked = true; const tid = firstBacTable.id;
  const expr = `(async()=>{ const tid=${JSON.stringify(tid)}; const sleep=ms=>new Promise(r=>setTimeout(r,ms)); function vis(el){const r=el.getBoundingClientRect();return r.width>5&&r.height>5&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth} const candidates=[...document.querySelectorAll('button,a,[role=button],div,li,span')].filter(el=>vis(el)); let target=candidates.find(el=>String(el.getAttribute('data-table-id')||el.dataset?.tableId||'')===tid)||candidates.find(el=>String(el.outerHTML).includes(tid))||candidates.find(el=>/百家|Baccarat|BAC/i.test(el.textContent||'')); if(target){ target.scrollIntoView({block:'center',inline:'center'}); await sleep(200); target.click(); return {clicked:true, text:(target.textContent||'').trim().slice(0,120), tag:target.tagName, url:location.href.replace(/token=([^&]+)/,'token=[REDACTED]')}; } return {clicked:false, visibleText:document.body.innerText.slice(0,1000), url:location.href.replace(/token=([^&]+)/,'token=[REDACTED]')}; })()`;
  try { log('CLICK_ATTEMPT', JSON.stringify(await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then(r=>r.result.value))); } catch (e) { log('CLICK_ATTEMPT_FAILED', e.message); }
}
async function main() {
  rmSync(userDataDir, { recursive: true, force: true }); mkdirSync(userDataDir, { recursive: true });
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', url];
  chrome = spawn(chromePath, args, { stdio: 'ignore', detached: false }); log('CHROME_STARTED', JSON.stringify({ port, url: 'https://gsa.ofalive99.net/?token=[REDACTED]&lang=zhtw' }));
  await waitForCdp(); const page = await pickPage(); cdp = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
  cdp.on('message', raw => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } if (ev.method === 'Network.webSocketFrameReceived') { frames++; lastFrameAt = new Date().toISOString(); const payload = ev.params?.response?.payloadData || ''; const obj = jsonParse(payload); if (!obj) return; walk(obj, node => { const tabs = node?.msg?.tables || node?.body?.tables || node?.data?.tables || node?.tables; if (Array.isArray(tabs)) addTables(tabs); const act = actionOf(node); const hasKnown = /show_poker|summary|show_win/i.test(act) || (resultFrom(node)?.length >= 10) || winnerFrom(node) != null; if (hasKnown) { if (/show_poker|summary|show_win/i.test(act) && rawMatches.length < 25) rawMatches.push(sanitize(JSON.stringify(node)).slice(0, 3000)); mergeRound(node, act || 'unknown', payload); } }); tryClickFirstBac(); } });
  await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront').catch(()=>{}); await send('Page.navigate', { url });
  const deadline = Date.now() + maxMinutes*60_000; while (Date.now() < deadline && confirmed.length < desired) await delay(1000);
  await send('Page.bringToFront').catch(()=>{}); let screenshotPath = null; try { const ss = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); screenshotPath = `${outDir}/mt-page-${new Date().toISOString().replace(/[:.]/g,'-')}.png`; writeFileSync(screenshotPath, Buffer.from(ss.data, 'base64')); log('SCREENSHOT', screenshotPath); } catch (e) { log('SCREENSHOT_FAILED', e.message); }
  const report = { startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), elapsedSeconds: Math.round((Date.now()-started)/1000), frames, lastFrameAt, firstBacTable, confirmed: confirmed.slice(0, desired), confirmedCount: confirmed.length, tablesCount: tables.size, clicked, screenshotPath, sampleKnownPackets: rawMatches.slice(0, 5) };
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2)); log('FINAL_REPORT', JSON.stringify(report));
}
main().catch(e => { console.error('FATAL', sanitize(e.stack || e.message)); process.exitCode = 1; });
