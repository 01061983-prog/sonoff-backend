'use strict';
const crypto=require('node:crypto'),createBridge=require('./bridge.cjs'),createProvider=require('./provider.cjs'),{fail,hash,id,binding,legacyChannels,entitiesOf,validOutlets}=require('./protocol.cjs');
module.exports=function install({app,db,accounts,programming,secret,appid,allowedAccounts=[],allowedEmails=[],origin}){
 const allowed=new Set(allowedAccounts),configs=()=>db().collection('paceHomeAssistantBindings');let bridge;
 const configIndex=require('../schedule-index.cjs')({query:configs});configIndex.start();
 const rows=()=>{const current=configIndex.all();if(!current)throw fail(503,'ha_configuration_unavailable','Configurazione dei collegamenti in aggiornamento. Riprova tra poco.');return current.docs;};
 const load=async owner=>{if(!id(owner))return null;return rows().find(d=>d.id===owner)?.data()||null;};
 async function scoped(owner){const a=await accounts.authorizeOwner(owner);if(!a||a.status!=='active'||(!allowed.has(a.id)&&!allowedEmails.includes(a.email)))throw fail(403,'ha_scope','Home Assistant non autorizzato per questa plancia.');return a;}
 bridge=createBridge({authenticate:async(agentId,token)=>{
  const [nonce,signature]=token.split('.'),expected=crypto.createHmac('sha256',secret).update('ha-agent:'+agentId+':'+nonce).digest('hex');
  if(!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw fail(401,'ha_auth');const tokenHash=hash(token);
  const matches=rows().filter(d=>d.data().agentId===agentId);if(matches.length!==1)throw fail(401,'ha_auth');const c=matches[0].data();
  if(c.revoked||typeof c.tokenHash!=='string'||c.tokenHash.length!==64||!crypto.timingSafeEqual(Buffer.from(c.tokenHash),Buffer.from(tokenHash)))throw fail(401,'ha_auth');
  const a=await scoped(c.owner);if(a.id!==c.accountId)throw fail(401,'ha_auth');return c;
 }});
 const provider=createProvider({load,authorize:scoped,bridge,secret});
 const publicConfig=c=>c?{owner:c.owner,accountId:c.accountId,workspaceId:c.workspaceId,workspaceName:c.workspaceName,...(c.workspaces?{workspaces:c.workspaces}:{}),revision:c.revision,agentId:c.agentId,enabled:c.enabled,revoked:!!c.revoked,devices:c.devices,excludedDevices:c.excludedDevices||[]}:null;
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{if(accounts.bridgeManager&&(req.method==='GET'||req.body?.op==='add')){const permission=await accounts.bridgeManager(req,req.method==='GET'?req.query?.owner:req.body?.owner);req.bridgeCanConfigure=permission.canConfigure;}else{await accounts.bridgeAdmin(req);req.bridgeCanConfigure=true;}res.json(await fn(req));}catch(e){e=require('../firebase-quota.cjs').record(e);if(e.retryAfterMs)res.set('Retry-After',String(Math.ceil(e.retryAfterMs/1000)));res.status(e.status||503).json({ok:false,error:e.code||'ha_unavailable',msg:e.message,retryAfterMs:e.retryAfterMs});}};
 async function coverage(t,c,a,{allowUnmapped=false}={}){
  const schedules=await t.get(db().collection('ewelinkProgrammingSchedules').where('owner','==',c.owner));
  const homes=c.workspaces||[{id:c.workspaceId,name:c.workspaceName}],workspaces=[];
  for(const home of homes){const workspaceKey=hash(appid+':app:'+a.id+':'+home.id+(c.owner!==a.providerOwner?':provider:'+c.owner:''));workspaces.push(await t.get(db().collection('sanLuigiScenarioWorkspaces').doc(workspaceKey)));}
  const mapped=new Set(c.devices.map(d=>d.deviceId)),excluded=new Map((c.excludedDevices||[]).map(d=>[d.deviceId,d]));const check=action=>{if(!mapped.has(action.deviceId)){if(excluded.has(action.deviceId))return;if(allowUnmapped&&typeof action.deviceId==='string'&&/^[a-f0-9]{10}$/.test(action.deviceId)){excluded.set(action.deviceId,{deviceId:action.deviceId,name:String(action.deviceName||'Dispositivo '+action.deviceId).slice(0,100),outlets:[0]});return;}}if(!mapped.has(action.deviceId)||((action.kind==='gate'||action.action==='pulse'||action.pulse===true)&&c.devices.find(d=>d.deviceId===action.deviceId)?.controlMode!=='pulse')||(action.outlets?.length&&!validOutlets(c.devices.find(d=>d.deviceId===action.deviceId),action.outlets)&&!legacyChannels(c.devices.find(d=>d.deviceId===action.deviceId),action.outlets)))throw fail(409,'ha_coverage','Dispositivo o canali non mappati: '+String(action.deviceId)+' (canali '+JSON.stringify(action.outlets||[])+'). Nessuna attivazione eseguita.');};
  for(const doc of schedules.docs){const s=doc.data();if(s.last?.status==='claimed'&&s.last.until>Date.now())throw fail(409,'ha_busy','Attendi la fine del comando programmato.');if(s.kind==='daikin')continue;if(s.kind==='scene'&&!homes.some(h=>h.id===s.workspaceId))throw fail(409,'ha_coverage','Una programmazione fa riferimento a una casa non associata.');for(const target of s.kind==='scene'?s.targets||[]:[s])check(target);}
  for(const workspace of workspaces){if(Object.values(workspace.data()?.executions||{}).some(r=>r.status==='running'&&r.expiresAt>Date.now())||bridge.busy(c))throw fail(409,'ha_busy','Attendi la fine dei comandi in corso.');
  for(const room of workspace.data()?.rooms||[])for(const member of room.members||[])if(member.type==='device'||member.kind==='device')check({deviceId:member.deviceId||member.id});
  for(const scene of workspace.data()?.scenes||[])for(const action of scene.actions||[])check(action);}
  return {excludedDevices:[...excluded.values()],schedules:schedules.docs.length,workspaceExists:workspaces.some(w=>w.exists)};
 }
 app.get('/api/app/home-assistant/devices',wrap(async req=>{await scoped(req.query.owner);const c=await load(req.query.owner);if(!c)throw fail(409,'ha_prepare','Prepara prima il collegamento.');return {ok:true,devices:await bridge.discover(c),revision:c.revision};}));
 app.get('/api/app/home-assistant',wrap(async req=>{
  const a=await scoped(req.query.owner),c=await load(req.query.owner);if(c&&c.accountId!==a.id)throw fail(403,'ha_scope');const s=c?bridge.snapshot(c):null;
  let initialDevices=[],initialExcluded=[];let bootstrapWorkspace=null;if(a.email==='sansiroora@gmail.com'){const homes=require('./san-siro-workspaces.json'),existing=[];for(const home of homes){const key=hash(appid+':app:'+a.id+':'+home.id+(req.query.owner!==a.providerOwner?':provider:'+req.query.owner:'')),s=await db().collection('sanLuigiScenarioWorkspaces').doc(key).get();if(s.exists&&((s.data().scenes||[]).length||(s.data().rooms||[]).length))existing.push(home);}const primary=existing.length===1?existing[0]:homes[0];bootstrapWorkspace={workspaceId:primary.id,workspaceName:primary.name,workspaces:homes};initialDevices=require('./san-siro-devices.json');}
  if(a.email==='gabriele.maini83@gmail.com'&&req.query.owner===a.providerOwner){const profile=require('./landriano-initial.json');bootstrapWorkspace={workspaceId:profile.workspaceId,workspaceName:profile.workspaceName};initialDevices=profile.devices;initialExcluded=profile.excludedDevices;}
  return {ok:true,canConfigure:req.bridgeCanConfigure,bootstrapWorkspace,initialDevices,initialExcluded,config:publicConfig(c),bridge:s?{ready:s.ready,observedAt:s.observedAt,states:[...s.states.values()]}:null};
 }));
 app.post('/api/app/home-assistant',wrap(async req=>{
  const b=req.body||{},a=await scoped(b.owner),ref=configs().doc(b.owner);
  if(b.op==='prepare'){
   const clean=binding({...b.mapping,owner:b.owner,accountId:a.id}),agentId=crypto.randomBytes(32).toString('hex'),nonce=crypto.randomBytes(32).toString('base64url'),token=nonce+'.'+crypto.createHmac('sha256',secret).update('ha-agent:'+agentId+':'+nonce).digest('hex');let created,oldAgent;
   await db().runTransaction(async t=>{const current=await t.get(ref),old=current.data();if(old?.enabled)throw fail(409,'ha_active','Disattiva il provider prima di cambiare la mappatura.');if((old?.revision||0)!==b.expectedRevision)throw fail(409,'ha_revision');oldAgent=old?.agentId;const proof=await coverage(t,clean,a,{allowUnmapped:b.allowUnmapped===true});const verified=binding({...clean,excludedDevices:proof.excludedDevices});created={...verified,agentId,tokenHash:hash(token),revision:(old?.revision||0)+1,enabled:false,revoked:false,preparedBy:req.appActor.uid,preparedAt:Date.now(),coverage:proof};t.set(ref,created);});
   if(oldAgent)bridge.revoke(oldAgent);return {ok:true,config:publicConfig(created),agentOptions:{bridge_url:new URL('/api/ha/bridge',origin).href.replace(/^https:/,'wss:'),agent_id:agentId,bridge_token:token,entities:entitiesOf(created)}};
  }
  if(b.op==='add'){
   let updated;
   await db().runTransaction(async t=>{const current=await t.get(ref),c=current.data();if(!c||c.revoked||c.revision!==b.expectedRevision)throw fail(409,'ha_revision');
    if(!Array.isArray(b.entityIds)||!b.entityIds.length||b.entityIds.length>200)throw fail(400,'ha_mapping');
    const devices=require('./catalogue.cjs').addDevices(c,b.entityIds,bridge.catalogue(c),b.replacements);
    const clean=binding({...c,devices,excludedDevices:c.excludedDevices?.filter(d=>!devices.some(mapped=>mapped.deviceId===d.deviceId))});await coverage(t,clean,a);updated={...c,...clean,revision:c.revision+1,updatedAt:Date.now(),updatedBy:req.appActor.uid};t.set(ref,updated);
   });bridge.configure(updated);return {ok:true,config:publicConfig(updated)};
  }
  if(!['activate','deactivate','revoke'].includes(b.op))throw fail(400,'ha_operation');
  let previous;
  await db().runTransaction(async t=>{const current=await t.get(ref),c=current.data();if(!c||c.accountId!==a.id||c.revision!==b.expectedRevision)throw fail(409,'ha_revision');previous=c;
   if(b.op==='activate'){
    if(c.revoked||!bridge.snapshot(c).ready||b.confirmedLocalDeviceIds?.length!==c.devices.length||new Set(b.confirmedLocalDeviceIds).size!==c.devices.length||c.devices.some(d=>!b.confirmedLocalDeviceIds.includes(d.deviceId)))throw fail(409,'ha_verify','Verifica prima ogni dispositivo in locale e collega il ponte.');
    const s=bridge.snapshot(c);require('./activation.cjs')(c,s,b.availableOnly);
    await coverage(t,c,a);
   }
   if(b.op!=='activate')await coverage(t,c,a);
   // Keep every existing schedule, credential and scene document in place.
   t.set(ref,{...c,enabled:b.op==='activate',revoked:b.op==='revoke',updatedAt:Date.now(),updatedBy:req.appActor.uid});
  });
  if(b.op==='revoke')bridge.revoke(previous.agentId);
  return {ok:true,enabled:b.op==='activate'};
 }));
 return {provider,bridge,load,stop:()=>{configIndex.stop();bridge.stop();}};
};
