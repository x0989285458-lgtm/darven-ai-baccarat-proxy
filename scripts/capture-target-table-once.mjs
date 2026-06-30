import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const token = process.env.MT_TOKEN;
if (!token) throw new Error('MT_TOKEN required');
const targetLabel = process.env.TARGET_TABLE_LABEL || '3';
const desired = Number(process.env.DESIRED_RESULTS || 3);
const maxMinutes = Number(process.env.MAX_MINUTES || 9);
const port = Number(process.env.CHROME_CDP_PORT || 9243);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const userDataDir = process.env.CHROME_USER_DATA_DIR || `C:/tmp/mt-capture-table-${targetLabel}-${Date.now()}`;
const outDir = process.env.OUT_DIR || 'C:/tmp/mt-capture-target';
const url = `https://gsa.ofalive99.net/?token=${encodeURIComponent(token)}&lang=zhtw`;
mkdirSync(outDir, { recursive: true });

let msgId = 0;
let chrome;
let cdp;
let frames = 0;
let lastFrameAt = null;
let targetTable = null;
let clicked = false;
const tablesById = new Map();
const pending = new Map();
const confirmed = [];
const seen = new Set();

function sanitize(s) { return String(s).replaceAll(token, '[REDACTED]').replace(/token=([^&\"']+)/ig, 'token=[REDACTED]'); }
function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }
function winnerName(w) { return String(w) === '1' ? '閒' : String(w) === '2' ? '莊' : String(w) === '3' ? '和' : String(w); }
function cardPoint(code) { const n = Number(code); if (!Number.isFinite(n) || n <= 0) return null; const rank = ((n - 1) % 13) + 1; return rank <= 9 ? rank : 0; }
function decodeCards(result) {
  const labels = ['閒1','莊1','閒2','莊2','閒3','莊3'];
  return labels.map((label, i) => ({ label, code: result[i] ?? null, point: cardPoint(result[i]) }));
}
function actionOf(o) { return String(o?.action?.name ?? o?.action ?? o?.cmd ?? o?.event ?? o?.type ?? o?.name ?? ''); }
function resultFrom(o) { return Array.isArray(o?.body?.result) ? o.body.result : Array.isArray(o?.msg?.result) ? o.msg.result : Array.isArray(o?.data?.result) ? o.data.result : Array.isArray(o?.result) ? o.result : null; }
function tableIdFrom(o) { return o?.body?.table_id ?? o?.body?.tableId ?? o?.msg?.table_id ?? o?.data?.table_id ?? o?.table_id ?? o?.tableId; }
function shoeFrom(o) { return o?.body?.shoe ?? o?.body?.current_shoe ?? o?.msg?.shoe ?? o?.data?.shoe ?? o?.shoe ?? o?.current_shoe; }
function roundFrom(o) { return o?.body?.round ?? o?.body?.current_round ?? o?.msg?.round ?? o?.data?.round ?? o?.round ?? o?.current_round; }
function winnerFrom(o) { return o?.body?.winner ?? o?.msg?.winner ?? o?.data?.winner ?? o?.winner; }
function walk(o, cb, d=0) { if (!o || typeof o !== 'object' || d > 8) return; cb(o); if (Array.isArray(o)) for (const v of o) walk(v, cb, d+1); else for (const v of Object.values(o)) walk(v, cb, d+1); }
function tableLabel(t, idx) { return String(t?.table_name ?? t?.name ?? t?.table_no ?? t?.table_number ?? t?.display_name ?? idx + 1); }
function tableType(t) { return String(t?.table_type ?? t?.type ?? '').toUpperCase(); }
function addTables(arr) {
  for (const [idx, t] of arr.entries()) {
    const id = t?.table_id ?? t?.id ?? t?.tableId;
    if (!id) continue;
    const normalized = { ...t, id: String(id), label: tableLabel(t, idx), index: idx, type: tableType(t) };
    tablesById.set(String(id), normalized);
  }
  if (!targetTable) {
    const bac = [...tablesById.values()].filter(t => t.type.includes('BAC') || t.type === 'B' || /^BA/.test(t.type));
    targetTable = bac.find(t => String(t.label).trim() === String(targetLabel)) || bac[Number(targetLabel)-1] || null;
    if (targetTable) console.log('TARGET_TABLE', JSON.stringify({ id: targetTable.id, label: targetTable.label, index: targetTable.index, type: targetTable.type }));
  }
}
function keyFor(tid, shoe, round) { return `${tid ?? ''}|${shoe ?? ''}|${round ?? ''}`; }
function merge(o, source) {
  const tid = tableIdFrom(o); const result = resultFrom(o); const winner = winnerFrom(o); const shoe = shoeFrom(o); const round = roundFrom(o);
  if (!targetTable || !tid || String(tid) !== String(targetTable.id)) return;
  const k = keyFor(tid, shoe, round); if (k === '||') return;
  const cur = pending.get(k) || { table_id: String(tid), shoe, round, raw_result: null, winner: null, sources: [] };
  if (result) cur.raw_result = result;
  if (winner != null) cur.winner = winner;
  if (shoe != null) cur.shoe = shoe;
  if (round != null) cur.round = round;
  cur.sources.push(source || 'unknown');
  pending.set(k, cur);
  if (cur.raw_result?.length >= 10 && cur.winner != null && cur.shoe != null && cur.round != null) {
    const ck = `${cur.table_id}|${cur.shoe}|${cur.round}|${JSON.stringify(cur.raw_result)}|${cur.winner}`;
    if (!seen.has(ck)) {
      seen.add(ck);
      const cards = decodeCards(cur.raw_result);
      const item = {
        table_id: cur.table_id,
        table_label: targetTable.label,
        shoe: cur.shoe,
        round: cur.round,
        cards,
        player_total: cur.raw_result[8],
        banker_total: cur.raw_result[9],
        winner: winnerName(cur.winner),
        winner_code: cur.winner,
        raw_result: cur.raw_result,
        sources: [...new Set(cur.sources)]
      };
      confirmed.push(item);
      console.log('CONFIRMED', JSON.stringify(item));
    }
  }
}
async function waitForCdp() { for (let i=0; i<120; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch {} await delay(250); } throw new Error('CDP not ready'); }
async function pickPage() { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || tabs[0]; }
function send(method, params={}) { return new Promise((resolve, reject) => { const id = ++msgId; const timer = setTimeout(()=>reject(new Error(`${method} timeout`)), 12000); const on = raw => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.id === id) { clearTimeout(timer); cdp.off('message', on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }; cdp.on('message', on); cdp.send(JSON.stringify({ id, method, params })); }); }
async function clickTarget() {
  if (!targetTable || clicked) return;
  clicked = true;
  const expr = `(async()=>{const tid=${JSON.stringify(targetTable.id)};const label=${JSON.stringify(targetTable.label)};const sleep=ms=>new Promise(r=>setTimeout(r,ms));function vis(el){const r=el.getBoundingClientRect();return r.width>5&&r.height>5&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}const els=[...document.querySelectorAll('button,a,[role=button],div,li,span')].filter(vis);let target=els.find(el=>String(el.outerHTML).includes(tid))||els.find(el=>(el.textContent||'').includes('第'+label+'桌'))||els.find(el=>(el.textContent||'').trim()===label);if(target){target.scrollIntoView({block:'center',inline:'center'});await sleep(200);target.click();await sleep(500);return {clicked:true,text:(target.textContent||'').trim().slice(0,160),url:location.href.replace(/token=([^&]+)/,'token=[REDACTED]')}}return {clicked:false,url:location.href.replace(/token=([^&]+)/,'token=[REDACTED]'),text:document.body.innerText.slice(0,500)}})()`;
  try { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); console.log('CLICK_RESULT', JSON.stringify(r.result.value)); } catch (e) { console.log('CLICK_FAILED', e.message); }
}
async function cleanup() {
  try { if (cdp?.readyState === WebSocket.OPEN) cdp.close(); } catch {}
  try { if (chrome?.pid) chrome.kill('SIGTERM'); } catch {}
  await delay(1200);
  try { if (chrome?.pid) process.kill(chrome.pid, 0) && chrome.kill('SIGKILL'); } catch {}
}
async function main() {
  rmSync(userDataDir, { recursive: true, force: true }); mkdirSync(userDataDir, { recursive: true });
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,900', url];
  chrome = spawn(chromePath, args, { stdio: 'ignore' });
  try {
    await waitForCdp(); const page = await pickPage(); cdp = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
    cdp.on('message', raw => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } if (ev.method === 'Network.webSocketFrameReceived') { frames++; lastFrameAt = new Date().toISOString(); const payload = ev.params?.response?.payloadData || ''; const obj = parseJson(payload); if (!obj) return; walk(obj, node => { const tabs = node?.msg?.tables || node?.body?.tables || node?.data?.tables || node?.tables; if (Array.isArray(tabs)) addTables(tabs); const act = actionOf(node); if (/show_poker|summary|show_win/i.test(act) || resultFrom(node)?.length >= 10 || winnerFrom(node) != null) merge(node, act); }); clickTarget(); } });
    await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable'); await send('Page.navigate', { url });
    const deadline = Date.now() + maxMinutes * 60_000;
    while (Date.now() < deadline && confirmed.length < desired) await delay(1000);
    let screenshotPath = null;
    try { const ss = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); screenshotPath = `${outDir}/table-${targetLabel}-${new Date().toISOString().replace(/[:.]/g,'-')}.png`; writeFileSync(screenshotPath, Buffer.from(ss.data, 'base64')); } catch {}
    const report = { targetLabel, targetTable, clicked, frames, lastFrameAt, confirmed: confirmed.slice(0, desired), confirmedCount: confirmed.length, screenshotPath, endedAt: new Date().toISOString() };
    writeFileSync(`${outDir}/report-table-${targetLabel}.json`, JSON.stringify(report, null, 2));
    console.log('FINAL_REPORT', sanitize(JSON.stringify(report)));
  } finally {
    await cleanup();
  }
}
main().catch(async e => { console.error('FATAL', sanitize(e.stack || e.message)); await cleanup(); process.exitCode = 1; });
