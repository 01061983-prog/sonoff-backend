'use strict';
const createHA=require('./ha-client.cjs'),createJournal=require('./journal.cjs'),{entity}=require('../protocol.cjs');
module.exports=function createAgent({bridgeURL,agentId,bridgeToken,entities,restURL='http://supervisor/core/api',websocketURL='ws://supervisor/core/websocket',haToken,journalFile='/data/commands.json',WebSocket=globalThis.WebSocket,fetch=globalThis.fetch,now=Date.now,allowLocalTest=false}){
 const url=new URL(bridgeURL);if((url.protocol!=='wss:'&&!(allowLocalTest&&url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname)))||url.username||url.password||url.search||url.pathname!=='/api/ha/bridge')throw Error('An HTTPS/WSS PACE bridge URL is required');
 if(!/^[a-f0-9]{64}$/.test(agentId)||! /^[A-Za-z0-9_-]{43}\.[a-f0-9]{64}$/.test(bridgeToken)||!haToken||!Array.isArray(entities)||!entities.length||entities.some(e=>!entity(e))||new Set(entities).size!==entities.length)throw Error('Invalid local agent configuration');
 let catalogue=new Map();const allowed=new Set(entities),ha=createHA({restURL,websocketURL,token:haToken,entities,WebSocket,fetch,now}),journal=createJournal({file:journalFile,now});let socket=null,stopped=true,retry=null,heartbeat=null,failures=0,revision=null,seq=0,snapshotSent=false;
 function send(message){if(socket?.readyState===1)socket.send(JSON.stringify(message));}
 function snapshot(){const s=ha.snapshot();if(revision===null)return;if(!s.ready){snapshotSent=false;send({type:'availability',available:false});return;}snapshotSent=true;send({type:'snapshot',revision,seq:++seq,states:s.states});}
 ha.events.on('availability',snapshot);ha.events.on('state',state=>{if(snapshotSent)send({type:'states',seq:++seq,states:[state]});});
 function connect(){if(stopped||socket)return;const ws=new WebSocket(bridgeURL);socket=ws;revision=null;snapshotSent=false;seq=0;
  const authTimer=setTimeout(()=>ws.close(),10000);authTimer.unref?.();
  ws.addEventListener('open',()=>ws.send(JSON.stringify({type:'auth',agentId,token:bridgeToken})));
  ws.addEventListener('message',async event=>{try{
   const m=JSON.parse(event.data);
   if(m.type==='welcome'){
    if(revision!==null||!Number.isSafeInteger(m.revision)||!Array.isArray(m.entities)||!m.entities.length||m.entities.length>200)throw Error('Invalid mapping');if(m.entities.some(e=>!allowed.has(e))){const found=await ha.discover();catalogue=new Map(found.filter(d=>d.supported!==false).flatMap(d=>(d.channels||[{entityId:d.entityId}]).map(c=>[c.entityId,d])));if(m.entities.some(e=>!allowed.has(e)&&!catalogue.has(e)))throw Error('Mapping differs from local actuators');}allowed.clear();for(const e of m.entities)allowed.add(e);await ha.select(m.entities);
    revision=m.revision;failures=0;clearTimeout(authTimer);snapshot();heartbeat=setInterval(()=>send({type:'heartbeat'}),25000);heartbeat.unref?.();return;
   }
   if(m.type==='heartbeat_ack')return;
   if(m.type==='discover'){const devices=await ha.discover();catalogue=new Map(devices.filter(d=>d.supported!==false).flatMap(d=>(d.channels||[{entityId:d.entityId}]).map(c=>[c.entityId,d])));send({type:'catalogue',id:m.id,devices});return;}
   if(m.type==='configure'){
    if(!Number.isSafeInteger(m.revision)||m.revision<=revision||!Array.isArray(m.entities)||!m.entities.length||m.entities.length>200||m.entities.some(e=>!allowed.has(e)&&!catalogue.has(e)))throw Error('Unapproved entity');
    snapshotSent=false;allowed.clear();for(const e of m.entities)allowed.add(e);await ha.select(m.entities);revision=m.revision;snapshot();return;
   }
   if(m.type!=='command'||revision===null||m.revision!==revision||! /^[a-f0-9-]{36}$/.test(m.id||'')||!allowed.has(m.entityId)||!['on','off'].includes(m.state)||!Number.isFinite(m.expiresAt)||m.expiresAt>now()+15000)throw Error('Invalid command');
   const result=await journal.run(m,()=>ha.set(m.entityId,m.state));if(socket===ws&&ws.readyState===1)send({type:'result',id:m.id,...result});
  }catch{ws.close(1008,'Invalid bridge command');}});
  const disconnected=()=>{if(socket!==ws)return;socket=null;revision=null;snapshotSent=false;clearTimeout(authTimer);if(heartbeat)clearInterval(heartbeat);heartbeat=null;if(!stopped&&!retry){retry=setTimeout(()=>{retry=null;connect();},Math.min(60000,1000*2**Math.min(failures++,6))+Math.floor(Math.random()*500));retry.unref?.();}};
  ws.addEventListener('close',disconnected);ws.addEventListener('error',()=>{ws.close();disconnected();});
 }
 return {start(){stopped=false;ha.start();connect();},stop(){stopped=true;if(retry)clearTimeout(retry);if(heartbeat)clearInterval(heartbeat);ha.stop();socket?.close();},ha};
};
if(require.main===module){
 const fs=require('node:fs'),options=JSON.parse(fs.readFileSync(process.env.PACE_AGENT_OPTIONS||'/data/options.json','utf8'));
 const agent=module.exports({bridgeURL:options.bridge_url,agentId:options.agent_id,bridgeToken:options.bridge_token,entities:options.entities,haToken:process.env.SUPERVISOR_TOKEN||process.env.HA_TOKEN,restURL:process.env.HA_REST_URL||undefined,websocketURL:process.env.HA_WS_URL||undefined,journalFile:process.env.PACE_AGENT_JOURNAL||'/data/commands.json'});
 agent.start();for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{agent.stop();setTimeout(()=>process.exit(0),250).unref();});
}
