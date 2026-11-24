'use strict';
const crypto=require('node:crypto');
const error=(status,code)=>Object.assign(new Error(code),{status,code});
function normalize(d){
 const p=d.params||{},outlets=Array.isArray(p.switches)?p.switches.filter(c=>Number.isInteger(c.outlet)&&c.outlet>=0&&c.outlet<128):[];
 const values=outlets.length?outlets.map(c=>c.switch):[p.switch];
 const state=values.every(v=>v==='on')?'on':values.every(v=>v==='off')?'off':values.every(v=>v==='on'||v==='off')?'mixed':'unknown';
 const pulse=d.deviceid==='1000ac81a0'||p.pulse==='on'||Array.isArray(p.pulseConfig)&&p.pulseConfig.some(c=>c.pulse==='on');
 return {id:d.deviceid,name:d.name||d.deviceid,online:typeof d.online==='boolean'?d.online:null,state,
  kind:pulse?'pulse':values.length&&values.every(v=>v==='on'||v==='off')?'switch':'unsupported',outlets:outlets.map(c=>c.outlet),homeId:d.familyId};
}
module.exports=function createSnapshots({access,listDevices,localProvider=()=>null,appid,region='eu',onChanged=async()=>{},fetch=globalThis.fetch,WebSocket=globalThis.WebSocket,now=Date.now}){
 const owners=new Map(),intervals=new Set();
 function owner(workspace){
  if(!workspace.providerOwner)throw error(409,'ewelink_not_connected');
  let entry=owners.get(workspace.providerOwner);
  if(!entry){entry={owner:workspace.providerOwner,workspaces:new Set(),raw:new Map(),devices:[],version:0,observedAt:0,loadedAt:0,job:null,socket:null,opening:false,failures:0,retryAt:0,changed:new Set(),closed:false};owners.set(entry.owner,entry);}
  entry.workspaces.add(workspace.id);return entry;
 }
 function different(before,after){const old=new Map(before.map(d=>[d.id,JSON.stringify(d)]));return [...new Set([...after.filter(d=>old.get(d.id)!==JSON.stringify(d)).map(d=>d.id),...before.filter(d=>!after.some(n=>n.id===d.id)).map(d=>d.id)])];}
 function emit(entry,ids){if(!ids.length)return;for(const id of ids)entry.changed.add(id);if(entry.flush)return;entry.flush=setTimeout(()=>{entry.flush=null;const changed=[...entry.changed];entry.changed.clear();for(const workspaceId of entry.workspaces)void onChanged(workspaceId,changed,entry.version).catch(()=>{});},600);entry.flush.unref?.();}
 async function refresh(entry){
  if(entry.job)return entry.job;
  entry.job=(async()=>{
   const credentials=await access(entry.owner);
   if(localProvider()?.supports(credentials.accessToken)){
    if(entry.reconnect){clearTimeout(entry.reconnect);entry.reconnect=null;}if(entry.socket){const old=entry.socket;entry.socket=null;old.close();}if(entry.heartbeat){clearInterval(entry.heartbeat);intervals.delete(entry.heartbeat);entry.heartbeat=null;}entry.apikey=null;const snap=await localProvider().snapshot(credentials.accessToken);entry.raw=new Map(snap.devices.map(d=>[d.deviceid,d]));const next=snap.devices.map(normalize);entry.lastChanged=different(entry.devices,next);entry.devices=next;if(entry.lastChanged.length)entry.version++;entry.observedAt=snap.observedAt||now();entry.loadedAt=now();entry.credentials=credentials;entry.live=snap.ready;
    if(entry.watching&&!entry.unsubscribeLocal)entry.unsubscribeLocal=await localProvider().watch(credentials.accessToken,()=>{void refresh(entry).then(()=>emit(entry,entry.lastChanged||[])).catch(()=>{entry.live=false;entry.devices=entry.devices.map(d=>({...d,online:false,state:'unknown'}));emit(entry,entry.devices.map(d=>d.id));});});return entry;
   }
   if(entry.unsubscribeLocal){entry.unsubscribeLocal();entry.unsubscribeLocal=null;}
   const devices=await listDevices(credentials.accessToken,undefined,{nativeOwnership:true});
   // Only itemType=1 devices expose ownerApikey in PACE; never use keys from shared devices.
   const keys=new Set(devices.filter(d=>d.itemType===1&&typeof d.ownerApikey==='string'&&d.ownerApikey).map(d=>d.ownerApikey));
   entry.apikey=keys.size===1?[...keys][0]:null;
   entry.raw=new Map(devices.map(d=>[d.deviceid,d]));const next=devices.map(normalize);entry.lastChanged=different(entry.devices,next);entry.devices=next;if(entry.lastChanged.length)entry.version++;entry.observedAt=now();entry.loadedAt=now();
   entry.credentials=credentials;if(entry.watching)void connect(entry,credentials).catch(()=>{});return entry;
  })();
  try{return await entry.job;}finally{entry.job=null;}
 }
 function scheduleReconnect(entry){
  if(entry.closed||!entry.watching||entry.reconnect)return;
  entry.reconnect=setTimeout(async()=>{
   entry.reconnect=null;
   try{
    const credentials=entry.credentials?.atExpiredTime>now()+60000?entry.credentials:await access(entry.owner);
    entry.credentials=credentials;await connect(entry,credentials);
   }catch(e){
    entry.live=false;
    if(['not_authenticated','app_blocked','app_pending'].includes(e.code)){entry.watching=false;emit(entry,[...entry.raw.keys()]);return;}
    entry.retryAt=now()+300000;scheduleReconnect(entry);
   }
  },Math.max(30000,entry.retryAt-now()));entry.reconnect.unref?.();
 }
 async function connect(entry,credentials){
  if(entry.socket||entry.opening||entry.closed||!entry.watching||!entry.apikey||now()<entry.retryAt)return;
  entry.opening=true;
  try{
   const response=await fetch(`https://${region}-dispa.coolkit.cc/dispatch/app`,{headers:{Authorization:'Bearer '+credentials.accessToken,'X-CK-Appid':appid},signal:AbortSignal.timeout(10000)});
   const dispatch=await response.json();
   if(!response.ok||dispatch.error!==0||!new RegExp('^'+region+'-[a-z0-9-]+\\.coolkit\\.(cc|cn)$','i').test(dispatch.domain||'')||!Number.isInteger(dispatch.port)||dispatch.port<1||dispatch.port>65535)throw error(503,'stream_unavailable');
   const ws=new WebSocket(`wss://${dispatch.domain}:${dispatch.port}/api/ws`);entry.socket=ws;
   const finish=()=>{
    if(entry.socket!==ws)return;entry.socket=null;entry.live=false;
    if(entry.heartbeat){clearInterval(entry.heartbeat);intervals.delete(entry.heartbeat);entry.heartbeat=null;}
    if(entry.handshake){clearTimeout(entry.handshake);entry.handshake=null;}
    entry.retryAt=now()+Math.min(300000,30000*2**Math.min(entry.failures++,4));
    // Reconnect only while this owner's widgets are registered; no Firestore polling.
    scheduleReconnect(entry);
   };
   ws.addEventListener('open',()=>{
    ws.send(JSON.stringify({action:'userOnline',version:8,ts:Math.floor(now()/1000),at:credentials.accessToken,apikey:entry.apikey,appid,userAgent:'app',nonce:crypto.randomBytes(6).toString('base64url').slice(0,8),sequence:String(now())}));
    entry.handshake=setTimeout(()=>ws.close(),10000);entry.handshake.unref?.();
   });
   ws.addEventListener('close',finish);ws.addEventListener('error',()=>{ws.close();finish();});
   ws.addEventListener('message',event=>{
    if(typeof event.data!=='string'||event.data==='pong')return;
    let message;try{message=JSON.parse(event.data);}catch{return;}
    if(message.error!==undefined&&!message.action){
     if(message.error!==0){ws.close();return;}
     if(entry.handshake){clearTimeout(entry.handshake);entry.handshake=null;}
     entry.live=true;entry.failures=0;
     if(!entry.heartbeat){entry.heartbeat=setInterval(()=>{if(ws.readyState===1)ws.send('ping');},(Math.max(30,Math.min(300,message.config?.hbInterval||90))+7)*1000);entry.heartbeat.unref?.();intervals.add(entry.heartbeat);}
     return;
    }
    if(!entry.live||!['update','sysmsg'].includes(message.action))return;
    const d=entry.raw.get(message.deviceid);if(!d||!message.params||typeof message.params!=='object')return;
    if(typeof message.params.online==='boolean')d.online=message.params.online;
    const p=message.params;
    if(['on','off'].includes(p.switch))d.params={...d.params,switch:p.switch};
    if(Array.isArray(p.switches)&&Array.isArray(d.params?.switches)){
     const patch=new Map(p.switches.filter(c=>['on','off'].includes(c.switch)).map(c=>[c.outlet,c.switch]));
     d.params={...d.params,switches:d.params.switches.map(c=>patch.has(c.outlet)?{...c,switch:patch.get(c.outlet)}:c)};
    }
    const next=[...entry.raw.values()].map(normalize),changed=different(entry.devices,next);entry.devices=next;if(changed.length)entry.version++;entry.observedAt=now();emit(entry,changed);
   });
  }catch(e){entry.retryAt=now()+60000;entry.live=false;scheduleReconnect(entry);}
  finally{entry.opening=false;}
 }
 return {
  async read(workspace){const entry=owner(workspace);if(!entry.loadedAt||!entry.live&&now()-entry.loadedAt>15000)await refresh(entry);return {version:entry.version,observedAt:entry.observedAt,liveUpdates:entry.live===true,devices:entry.devices};},
  async watch(workspace){const entry=owner(workspace);entry.watching=true;if(!entry.loadedAt)await refresh(entry);else if(entry.credentials&&localProvider()?.supports(entry.credentials.accessToken))await refresh(entry);else if(entry.credentials)await connect(entry,entry.credentials);},
  unwatch(workspaceId){for(const entry of owners.values()){entry.workspaces.delete(workspaceId);if(!entry.workspaces.size){entry.watching=false;entry.closed=true;if(entry.reconnect)clearTimeout(entry.reconnect);if(entry.flush)clearTimeout(entry.flush);entry.unsubscribeLocal?.();entry.socket?.close();owners.delete(entry.owner);}}},
  async refresh(workspace){const entry=owner(workspace);await refresh(entry);emit(entry,entry.lastChanged||[]);return {version:entry.version,observedAt:entry.observedAt,devices:entry.devices};},
  stop(){for(const e of owners.values()){e.closed=true;if(e.flush)clearTimeout(e.flush);if(e.reconnect)clearTimeout(e.reconnect);if(e.handshake)clearTimeout(e.handshake);e.unsubscribeLocal?.();e.socket?.close();}for(const i of intervals)clearInterval(i);owners.clear();}
 };
};
module.exports.normalize=normalize;
