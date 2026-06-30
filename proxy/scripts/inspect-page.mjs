import { WebSocket } from 'ws';
const port=9237;
const tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page=tabs.find(t=>t.type==='page');
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;
await new Promise((res,rej)=>{ws.once('open',res); ws.once('error',rej)});
function send(method,params={}){return new Promise((resolve,reject)=>{const mid=++id; const to=setTimeout(()=>reject(new Error('timeout '+method)),5000); function on(raw){let m=JSON.parse(raw); if(m.id===mid){clearTimeout(to); ws.off('message',on); m.error?reject(new Error(m.error.message)):resolve(m.result)}} ws.on('message',on); ws.send(JSON.stringify({id:mid,method,params}));});}
const expr=`({url:location.href.replace(/token=([^&]+)/,'token=[REDACTED]'),title:document.title,text:document.body.innerText.slice(0,2000),html:document.body.innerHTML.slice(0,1000)})`;
console.log(JSON.stringify((await send('Runtime.evaluate',{expression:expr,returnByValue:true})).result.value,null,2));
ws.close();
