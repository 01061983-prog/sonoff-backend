'use strict';
const {EventEmitter}=require('node:events'),crypto=require('node:crypto');
const {WebSocketServer}=require('ws');
const {fail,safeState,entitiesOf,channels}=require('./protocol.cjs');
module.exports=function createBridge({authenticate,now=Date.now,timeout=12000,heartbeat=25000,setTimer=setTimeout,clearTimer=clearTimeout}){
 const events=new EventEmitter(),peers=new Map();let wss,interval;
 function send(peer,message){if(peer.socket.readyState!==1)throw fail(503,'ha_offline','Ponte Home Assistant non raggiungibile.');peer.socket.send(JSON.stringify(message));}
 function rejectPending(peer){if(peer.discovery){clearTimer(peer.discovery.timer);peer.discovery.reject(fail(503,'ha_offline'));peer.discovery=null;}for(const job of peer.pending.values()){clearTimer(job.timer);job.reject(fail(504,'ha_uncertain','Collegamento interrotto: esito del comando da verificare. Nessun reinvio automatico.'));}peer.pending.clear();}
 function changed(peer){events.emit('changed',{owner:peer.config.owner,agentId:peer.config.agentId});}
 function disconnect(peer){if(peers.get(peer.config.agentId)!==peer)return;peers.delete(peer.config.agentId);peer.ready=false;rejectPending(peer);changed(peer);}
 async function accept(socket){
  let peer=null,authenticating=false;
  const authTimer=setTimer(()=>socket.close(1008,'Authentication required'),5000);authTimer.unref?.();
  socket.on('message',async(data,binary)=>{
   try{
    if(binary)throw fail(400,'ha_protocol');const message=JSON.parse(data.toString());
    if(!peer){
     if(authenticating||message.type!=='auth'||typeof message.agentId!=='string'||! /^[a-f0-9]{64}$/.test(message.agentId)||typeof message.token!=='string'||! /^[A-Za-z0-9_-]{43}\.[a-f0-9]{64}$/.test(message.token))throw fail(401,'ha_auth');
     authenticating=true;const config=await authenticate(message.agentId,message.token);
     if(!config||config.agentId!==message.agentId)throw fail(401,'ha_auth');
     if(socket.readyState!==1)return;
     const old=peers.get(config.agentId);if(old){old.socket.close(4001,'Replaced');disconnect(old);}
     peer={socket,config,capabilities:Array.isArray(message.capabilities)?message.capabilities.filter(c=>c==='native-pulse-v1'):[],ready:false,seenAt:now(),seq:-1,states:new Map(),pending:new Map(),discovery:null,catalogue:[]};peers.set(config.agentId,peer);clearTimer(authTimer);
     send(peer,{type:'welcome',revision:config.revision,entities:entitiesOf(config)});return;
    }
    if(peers.get(peer.config.agentId)!==peer)throw fail(401,'ha_session');
    if(message.type==='heartbeat'){peer.seenAt=now();send(peer,{type:'heartbeat_ack'});return;}
    if(message.type==='availability'){if(message.available!==false)throw fail(400,'ha_protocol');peer.ready=false;rejectPending(peer);changed(peer);return;}
    if(['snapshot','states'].includes(message.type)){
     if(!Number.isSafeInteger(message.seq)||message.seq<=peer.seq||!Array.isArray(message.states)||message.states.length>200)throw fail(400,'ha_protocol');
     const allowed=new Set(entitiesOf(peer.config)),states=message.states.map(safeState);if(states.some(s=>!allowed.has(s.entity_id))||new Set(states.map(s=>s.entity_id)).size!==states.length)throw fail(403,'ha_entity');
     if(message.type==='snapshot'&&(states.length!==allowed.size||message.revision!==peer.config.revision))throw fail(409,'ha_revision');
     if(message.type==='snapshot'){peer.states.clear();peer.ready=true;}
     if(!peer.ready)throw fail(409,'ha_snapshot_required');
     for(const s of states)peer.states.set(s.entity_id,{...s,receivedAt:now()});peer.seq=message.seq;peer.seenAt=now();changed(peer);return;
    }
    if(message.type==='catalogue'){
     const job=peer.discovery;if(!job||message.id!==job.id)throw fail(400,'ha_protocol');
     if(!Array.isArray(message.devices)||message.devices.length>200)throw fail(400,'ha_catalogue');
     peer.catalogue=message.devices.map(require('./catalogue.cjs').entry);peer.discovery=null;clearTimer(job.timer);job.resolve(peer.catalogue);return;
    }
    if(message.type==='result'){
     const job=peer.pending.get(message.id);if(!job)return;
     if(message.status==='confirmed'&&!job.pulse||message.status==='pulse_accepted'&&job.pulse){
      const state=safeState(message.state);if(state.entity_id!==job.entityId||state.state!==(job.pulse?'off':job.state))throw fail(400,'ha_confirmation');
      peer.pending.delete(message.id);clearTimer(job.timer);peer.states.set(state.entity_id,{...state,receivedAt:now()});changed(peer);job.resolve({status:job.pulse?'pulse_accepted':'confirmed',state:state.state,observedAt:now(),source:'home_assistant'});
     }else {peer.pending.delete(message.id);clearTimer(job.timer);job.reject(fail(message.status==='failed'?502:504,message.status==='failed'?'ha_failed':'ha_uncertain',message.status==='failed'?'Home Assistant non ha eseguito il comando.':'Stato non confermato da Home Assistant. Verifica prima di riprovare.'));}
     return;
    }
    throw fail(400,'ha_protocol');
   }catch{socket.close(1008,'Invalid bridge message');if(peer)disconnect(peer);}
  });
  socket.on('close',()=>{clearTimer(authTimer);if(peer)disconnect(peer);});socket.on('error',()=>{if(peer)disconnect(peer);});
 }
 return {
  attach(server){if(wss)throw Error('Bridge already attached');wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
   server.on('upgrade',(request,socket,head)=>{if(wss.clients.size>=64){socket.destroy();return;}if(new URL(request.url,'http://bridge').pathname!=='/api/ha/bridge'){socket.destroy();return;}if(request.headers.origin||request.url.includes('?')){socket.destroy();return;}wss.handleUpgrade(request,socket,head,ws=>accept(ws));});
   interval=setInterval(()=>{for(const p of peers.values()){if(now()-p.seenAt>heartbeat*3){p.socket.terminate();disconnect(p);}else if(p.socket.readyState===1)p.socket.ping();}},heartbeat);interval.unref?.();
  },
  snapshot(config){const p=peers.get(config.agentId),ready=!!p&&p.config.revision===config.revision&&p.ready&&now()-p.seenAt<=heartbeat*3;return {ready,states:ready?new Map(p.states):new Map(),observedAt:ready?p.seenAt:null};},
  async command(config,{deviceId,state,outlet=0,id=crypto.randomUUID()}){
   const d=config.devices.find(d=>d.deviceId===deviceId),entityId=d&&channels(d).find(c=>c.outlet===outlet)?.entityId;if(!entityId||!['on','off'].includes(state))throw fail(400,'ha_command');const p=peers.get(config.agentId);
   if(!p||!this.snapshot(config).ready)throw fail(503,'ha_offline','Raspberry o Home Assistant non disponibile. Nessun comando inviato.');
   if(!['on','off'].includes(p.states.get(entityId)?.state))throw fail(503,'ha_device_offline','Il dispositivo non è disponibile in Home Assistant.');
   const pulse=d.controlMode==='pulse';if(pulse&&(state!=='on'||!p.capabilities.includes('native-pulse-v1')||p.states.get(entityId)?.state!=='off'))throw fail(409,'ha_pulse','Il comando a impulso richiede il ponte aggiornato e il relè a riposo.');
   if(pulse&&[...p.pending.values()].some(job=>job.entityId===entityId))throw fail(409,'ha_command_pending');
   if(p.pending.has(id))throw fail(409,'ha_command_pending');
   return new Promise((resolve,reject)=>{const timer=setTimer(()=>{p.pending.delete(id);reject(fail(504,'ha_uncertain','Conferma Home Assistant non ricevuta. Nessun reinvio automatico.'));},timeout);timer.unref?.();p.pending.set(id,{resolve,reject,timer,entityId,state,pulse});try{send(p,{type:'command',id,entityId,state,...(pulse?{mode:'pulse',deviceId:d.deviceId,model:d.model}:{}),expiresAt:now()+timeout-1000,revision:config.revision});}catch(e){clearTimer(timer);p.pending.delete(id);reject(e);}});
  },
  busy(config){return !!peers.get(config.agentId)?.pending.size;},
  catalogue(config){return peers.get(config.agentId)?.catalogue||[];},
  async discover(config){const p=peers.get(config.agentId);if(!p||!this.snapshot(config).ready)throw fail(503,'ha_offline','Collega prima il Raspberry.');if(p.discovery)throw fail(409,'ha_busy');return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimer(()=>{p.discovery=null;reject(fail(504,'ha_discovery_timeout'));},10000);timer.unref?.();p.discovery={id,timer,resolve,reject};send(p,{type:'discover',id});});},
  configure(config){const p=peers.get(config.agentId);if(!p)return;if(p.pending.size)throw fail(409,'ha_busy');p.config=config;p.ready=false;send(p,{type:'configure',revision:config.revision,entities:entitiesOf(config)});changed(p);},
  subscribe(owner,callback){const fn=event=>{if(event.owner===owner)callback(event);};events.on('changed',fn);return ()=>events.off('changed',fn);},
  revoke(agentId){const p=peers.get(agentId);if(p){disconnect(p);p.socket.close(4003,'Revoked');}},
  stop(){if(interval)clearInterval(interval);for(const p of [...peers.values()]){disconnect(p);p.socket.terminate();}wss?.close();}
 };
};
