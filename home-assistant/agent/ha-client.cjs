'use strict';
const {EventEmitter}=require('node:events');
const {fail,safeState}=require('../protocol.cjs');
module.exports=function createHAClient({restURL,websocketURL,token,entities,WebSocket=globalThis.WebSocket,fetch=globalThis.fetch,now=Date.now}){
 const events=new EventEmitter(),allowed=new Set(entities),states=new Map(),pending=new Map();let socket=null,ready=false,stopped=true,retry=null,heartbeat=null,failures=0,serial=0;
 function apply(value){if(!allowed.has(value?.entity_id))return;const s=safeState(value),old=states.get(s.entity_id);if(old?.last_updated&&s.last_updated&&Date.parse(s.last_updated)<Date.parse(old.last_updated))return;states.set(s.entity_id,s);events.emit('state',s);}
 function disconnect(ws){if(socket!==ws)return;socket=null;ready=false;states.clear();if(heartbeat)clearInterval(heartbeat);heartbeat=null;for(const p of pending.values()){clearTimeout(p.timer);p.reject(fail(503,'ha_connection'));}pending.clear();events.emit('availability',false);if(!stopped&&!retry){retry=setTimeout(()=>{retry=null;connect();},Math.min(60000,1000*2**Math.min(failures++,6))+Math.floor(Math.random()*500));retry.unref?.();}}
 function request(type,data={}){if(!socket||socket.readyState!==1)return Promise.reject(fail(503,'ha_connection'));const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(fail(504,'ha_timeout'));},6000);timer.unref?.();pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,type,...data}));});}
 function connect(){if(stopped||socket)return;const ws=new WebSocket(websocketURL);socket=ws;let authenticated=false;
  const authTimeout=setTimeout(()=>ws.close(),10000);authTimeout.unref?.();
  ws.addEventListener('message',async event=>{try{
   const m=JSON.parse(event.data);
   if(m.type==='auth_required'){ws.send(JSON.stringify({type:'auth',access_token:token}));return;}
   if(m.type==='auth_invalid'){ws.close();return;}
   if(m.type==='auth_ok'){
    if(authenticated)throw Error('duplicate auth');authenticated=true;clearTimeout(authTimeout);
    await request('subscribe_events',{event_type:'state_changed'});
    const rows=await request('get_states');if(socket!==ws||!Array.isArray(rows))return;
    for(const entity_id of allowed)if(!states.has(entity_id))states.set(entity_id,{entity_id,state:'unknown',last_updated:null});for(const s of rows)apply(s);
    ready=true;failures=0;events.emit('availability',true);
    heartbeat=setInterval(()=>void request('ping').catch(()=>ws.close()),25000);heartbeat.unref?.();return;
   }
   if(!authenticated)throw Error('auth required');
   if(m.type==='result'||m.type==='pong'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.type==='pong'||m.success===true)p.resolve(m.result);else p.reject(fail(502,'ha_service'));return;}
   if(m.type==='event'&&m.event?.event_type==='state_changed'){const {entity_id,new_state}=m.event.data||{};if(allowed.has(entity_id))apply(new_state||{entity_id,state:'unavailable'});}
  }catch{ws.close();}});
  ws.addEventListener('close',()=>{clearTimeout(authTimeout);disconnect(ws);});ws.addEventListener('error',()=>{ws.close();disconnect(ws);});
 }
 return {
  events,
  start(){stopped=false;connect();},
  snapshot(){return {ready,states:[...allowed].map(entity_id=>states.get(entity_id)||{entity_id,state:'unknown',last_updated:null})};},
  async select(next){if(!Array.isArray(next)||next.some(e=>!require('../protocol.cjs').entity(e)))throw fail(400,'ha_entity');allowed.clear();for(const e of next)allowed.add(e);const rows=await request('get_states');for(const row of rows)apply(row);},
  async discover(){
   if(!ready)throw fail(503,'ha_offline');
   const [rows,registry,devices]=await Promise.all([request('get_states'),request('config/entity_registry/list'),request('config/device_registry/list')]);
   const models=new Map(devices.map(d=>[d.id,d]));
   return rows.filter(s=>require('../protocol.cjs').entity(s.entity_id)).flatMap(s=>{const e=registry.find(e=>e.entity_id===s.entity_id),d=models.get(e?.device_id),match=s.entity_id.match(/_sonoff_([a-f0-9]{10})_1$/);if(e?.platform!=='sonoff'||d?.model!=='MINIR4'||!match)return [];return [{entityId:s.entity_id,deviceId:match[1],name:String(s.attributes?.friendly_name||s.entity_id).slice(0,100),model:'MINIR4',state:['on','off'].includes(s.state)?s.state:'unknown'}];}).slice(0,200);
  },
  async set(entityId,state){
   if(!allowed.has(entityId)||!['on','off'].includes(state))throw fail(403,'ha_entity');if(!ready||!['on','off'].includes(states.get(entityId)?.state))throw fail(503,'ha_device_offline');
   await request('call_service',{domain:entityId.split('.')[0],service:state==='on'?'turn_on':'turn_off',target:{entity_id:entityId}});
   // A successful service call alone is not a state confirmation. Read the
   // actual entity after the call; never POST /api/states to invent feedback.
   for(let attempt=0;attempt<3;attempt++){
    const response=await fetch(restURL+'/states/'+encodeURIComponent(entityId),{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1500)});
    if(!response.ok)throw fail(502,'ha_readback');const s=safeState(await response.json());if(s.entity_id!==entityId)throw fail(502,'ha_readback');apply(s);if(s.state===state)return s;
    if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250));
   }
   throw fail(504,'ha_uncertain');
  },
  stop(){stopped=true;if(retry)clearTimeout(retry);retry=null;if(heartbeat)clearInterval(heartbeat);const ws=socket;if(ws){disconnect(ws);ws.close();}}
 };
};
