'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {WebSocketServer}=require('ws'),createBridge=require('../home-assistant/bridge.cjs'),createProvider=require('../home-assistant/provider.cjs'),createAgent=require('../home-assistant/agent/index.cjs'),createJournal=require('../home-assistant/agent/journal.cjs'),{binding,hash}=require('../home-assistant/protocol.cjs');
const owner='a'.repeat(64),accountId='b'.repeat(64),agentId='c'.repeat(64),token='d'.repeat(43)+'.'+'e'.repeat(64),deviceId='1000000001',entityId='switch.fixture_relay';
const mapping=()=>({...binding({owner,accountId,workspaceId:'old-home',workspaceName:'Fixture Vidigulfo',devices:[{deviceId,name:'Vialetto fixture',entityId,kind:'multi',outlets:[0]}]}),agentId,revision:1,enabled:true});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
async function until(predicate,timeout=4000){const started=Date.now();while(!predicate()){if(Date.now()-started>timeout)throw Error('Fixture condition timed out');await new Promise(r=>setTimeout(r,10));}}
async function setup(){
 let calls=0,suppressState=false,authorized=true,clock=Date.now(),config=mapping();const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pace-ha-test-'));let state={entity_id:entityId,state:'off',last_updated:new Date(clock).toISOString()};
 const haServer=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer local-ha-secret'){res.statusCode=401;res.end('{}');return;}if(req.url==='/api/states/'+entityId){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));return;}res.statusCode=404;res.end('{}');});
 const haWS=new WebSocketServer({server:haServer,path:'/api/websocket'});
 haWS.on('connection',socket=>{let authenticated=false,subscription;const send=m=>socket.readyState===1&&socket.send(JSON.stringify(m));send({type:'auth_required'});
 socket.on('message',data=>{const m=JSON.parse(data);if(m.type==='auth'){if(m.access_token==='local-ha-secret'){authenticated=true;send({type:'auth_ok'});}else send({type:'auth_invalid'});return;}if(!authenticated)return socket.close();
 if(m.type==='subscribe_events'){subscription=m.id;send({id:m.id,type:'result',success:true,result:null});}
 else if(m.type==='config/entity_registry/list')send({id:m.id,type:'result',success:true,result:[{entity_id:entityId,platform:'sonoff',device_id:'physical-one'},{entity_id:'switch.extra_sonoff_1000000002_1',platform:'sonoff',device_id:'physical-two'}]});
 else if(m.type==='config/device_registry/list')send({id:m.id,type:'result',success:true,result:[{id:'physical-one',model:'MINIR4'},{id:'physical-two',model:'MINIR4'}]});
 else if(m.type==='get_states')send({id:m.id,type:'result',success:true,result:[state,{entity_id:'switch.extra_sonoff_1000000002_1',state:'off',attributes:{friendly_name:'New fixture relay',secret:'not forwarded'}},{entity_id:'sensor.unrelated',state:'23',attributes:{secret:'not forwarded'}}]});
 else if(m.type==='call_service'){calls++;assert.equal(m.target.entity_id,entityId);assert.equal(m.domain,'switch');assert(['turn_on','turn_off'].includes(m.service));if(!suppressState){state={...state,state:m.service==='turn_on'?'on':'off',last_updated:new Date(clock).toISOString()};send({id:subscription,type:'event',event:{event_type:'state_changed',data:{entity_id:entityId,new_state:state}}});}send({id:m.id,type:'result',success:true,result:{context:{id:'fixture'}}});}
 else if(m.type==='ping')send({id:m.id,type:'pong'});});});
 const haPort=await listen(haServer),server=http.createServer((_req,res)=>res.end('fixture'));
 const bridge=createBridge({now:()=>clock,timeout:10000,authenticate:async(id,value)=>id===agentId&&value===token?config:null});bridge.attach(server);const port=await listen(server);
 const agent=createAgent({bridgeURL:'ws://127.0.0.1:'+port+'/api/ha/bridge',agentId,bridgeToken:token,entities:[entityId],restURL:'http://127.0.0.1:'+haPort+'/api',websocketURL:'ws://127.0.0.1:'+haPort+'/api/websocket',haToken:'local-ha-secret',journalFile:path.join(tmp,'commands.json'),now:()=>clock,allowLocalTest:true});
 const provider=createProvider({load:async id=>id===owner?config:null,authorize:async id=>authorized&&id===owner?{id:accountId,status:'active'}:null,bridge,secret:'fixture-app-secret'});agent.start();await until(()=>bridge.snapshot(config).ready);
 return {provider,bridge,agent,config,tmp,commands:()=>calls,setSuppressed:v=>suppressState=v,setAuthorized:v=>authorized=v,setConfig:v=>config=v,setClock:v=>clock=v,
 async close(){agent.stop();bridge.stop();for(const ws of haWS.clients)ws.terminate();haWS.close();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>haServer.close(r))]);fs.rmSync(tmp,{recursive:true,force:true});}};
}
test('LAN bridge confirms real readback, preserves old device IDs and uses no eWeLink API',{timeout:15000},async()=>{
 const f=await setup();try{
 const c=await f.provider.credentials(owner);assert.equal(c.provider,'home_assistant');assert.equal(await f.provider.credentials('f'.repeat(64)),null);assert.equal(await f.provider.owner(c.accessToken),owner);
 assert.deepEqual(await f.provider.families(c.accessToken),[{id:'old-home',name:'Fixture Vidigulfo'}]);
 const before=await f.provider.devices(c.accessToken);assert.equal(before[0].deviceid,deviceId);assert.deepEqual(before[0].params.switches,[{outlet:0,switch:'off'}]);assert.equal(before[0].ownership.type,'unknown');
 const result=await f.provider.call('/v2/device/thing/status',c.accessToken,{type:1,id:deviceId,params:{switches:[{outlet:0,switch:'on'}]}});assert.equal(result.data.status,'confirmed');assert.equal(f.commands(),1);
 const after=await f.provider.devices(c.accessToken);assert.equal(after[0].params.switches[0].switch,'on');assert(!JSON.stringify(after).includes('local-ha-secret'));assert(!JSON.stringify(after).includes('sensor.unrelated'));
 await assert.rejects(f.provider.call('/v2/device/thing/status',c.accessToken,{type:1,id:deviceId,params:{switches:[{outlet:1,switch:'on'}]}}),{code:'ha_command'});assert.equal(f.commands(),1);
 await assert.rejects(f.provider.devices(c.accessToken,[{id:'other-home'}]),{code:'workspace_forbidden'});
 f.setAuthorized(false);await assert.rejects(f.provider.call('/v2/device/thing/status',c.accessToken,{type:1,id:deviceId,params:{switch:'off'}}),{code:'app_blocked'});assert.equal(f.commands(),1);
 }finally{await f.close();}
});
test('agent loss never invents OFF, cached states become unavailable and commands do not fall back',{timeout:15000},async()=>{
 const f=await setup();try{const c=await f.provider.credentials(owner);f.agent.stop();await until(()=>!f.bridge.snapshot(f.config).ready);const devices=await f.provider.devices(c.accessToken);assert.equal(devices[0].online,false);assert.equal(devices[0].params.switches[0].switch,'unknown');await assert.rejects(f.provider.call('/v2/device/thing/status',c.accessToken,{type:1,id:deviceId,params:{switch:'on'}}),{code:'ha_offline'});assert.equal(f.commands(),0);}finally{await f.close();}
});
test('HA service acceptance without the requested state is uncertain, not confirmed and not retried',{timeout:15000},async()=>{
 const f=await setup();try{const c=await f.provider.credentials(owner);f.setSuppressed(true);await assert.rejects(f.provider.call('/v2/device/thing/status',c.accessToken,{type:1,id:deviceId,params:{switch:'on'}}),{code:'ha_uncertain'});assert.equal(f.commands(),1);assert.equal((await f.provider.devices(c.accessToken))[0].params.switches[0].switch,'off');}finally{await f.close();}
});
test('persisted command receipts prohibit replay after a process restart and refuse ID reuse',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pace-journal-')),file=path.join(temp,'commands.json');try{let calls=0;const command={id:crypto.randomUUID(),entityId,state:'on',revision:1,expiresAt:Date.now()+10000};const j=createJournal({file});await j.run(command,async()=>{calls++;return {entity_id:entityId,state:'on'};});const again=createJournal({file});await again.run(command,async()=>{calls++;});assert.equal(calls,1);await assert.rejects(again.run({...command,state:'off'},async()=>{}),{code:'ha_duplicate_mismatch'});
 const pending={id:crypto.randomUUID(),entityId,state:'off',revision:1,expiresAt:Date.now()+10000},fingerprint=hash(JSON.stringify([entityId,'off',1]));fs.writeFileSync(file,JSON.stringify({[pending.id]:{fingerprint,at:Date.now()}}));const crashed=createJournal({file});assert.equal((await crashed.run(pending,async()=>{calls++;})).status,'uncertain');assert.equal(calls,1);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('mapping refuses duplicate entities, virtual channels and non-actuator entities',()=>{
 const m=mapping();assert.throws(()=>binding({...m,devices:[...m.devices,...m.devices]}),{code:'ha_mapping'});assert.throws(()=>binding({...m,devices:[{...m.devices[0],outlets:[0,1]}]}),{code:'ha_channels'});assert.throws(()=>binding({...m,devices:[{...m.devices[0],entityId:'sensor.temperature'}]}),{code:'ha_mapping'});
});

test('new relays require explicit discovery and mapping confirmation, without copying entity IDs',{timeout:15000},async()=>{const f=await setup();try{const c=await f.provider.credentials(owner);assert.equal((await f.provider.devices(c.accessToken)).length,1);const found=await f.bridge.discover(f.config);assert.equal(found.length,1);assert.equal(found[0].deviceId,'1000000002');assert(!JSON.stringify(found).includes('secret'));assert.equal(f.commands(),0);assert.equal((await f.provider.devices(c.accessToken)).length,1);const updated={...f.config,revision:2,devices:[...f.config.devices,{...found[0],kind:'multi',outlets:[0]}]};f.setConfig(updated);f.bridge.configure(updated);await until(()=>f.bridge.snapshot(updated).ready);const next=await f.provider.credentials(owner);assert.equal((await f.provider.devices(next.accessToken)).length,2);await assert.rejects(f.provider.devices(c.accessToken),{code:'app_provider_context_changed'});assert.equal(f.commands(),0);}finally{await f.close();}});
