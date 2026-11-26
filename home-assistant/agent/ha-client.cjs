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
   return require('../catalogue.cjs').discover(rows,registry,devices);
  },
  async pulse(entityId,pulseMs){
   if(!allowed.has(entityId)||![500,1000].includes(pulseMs))throw fail(403,'ha_entity');
   if(!ready||states.get(entityId)?.state!=='off')throw fail(503,'ha_device_offline');
   // Exactly one ON edge. The native inching timer remains enabled on the relay.
   await request('call_service',{domain:entityId.split('.')[0],service:'turn_on',target:{entity_id:entityId}});
   await new Promise(resolve=>setTimeout(resolve,pulseMs+150));
   const read=async()=>{const response=await fetch(restURL+'/states/'+encodeURIComponent(entityId),{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1500)});if(!response.ok)throw fail(502,'ha_readback');const value=safeState(await response.json());if(value.entity_id!==entityId)throw fail(502,'ha_readback');apply(value);return value;};
   let state=await read();
   // OFF releases the contact; it never repeats the ON pulse. This also protects
   // against a native inching option being changed after configuration.
   if(state.state==='on'){await request('call_service',{domain:entityId.split('.')[0],service:'turn_off',target:{entity_id:entityId}});state=await read();}
   if(state.state!=='off')throw fail(504,'ha_uncertain');
   return state; // HA accepted the command and relay is at rest; position is unknown.
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
