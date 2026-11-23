'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {createWidgetService,installRoutes}=require('./service.cjs');
const createAuth=require('./auth.cjs'),createSnapshots=require('./snapshots.cjs'),createAPNs=require('./apns.cjs'),createUsage=require('./usage-cache.cjs');
const requestReads=require('../request-reads.cjs'),firebaseQuota=require('../firebase-quota.cjs');
const failure=(status,code)=>Object.assign(new Error(code),{status,code});
module.exports=function installWidgets({app,db,accounts,firebaseAuth,programming,api,listDevices,assertNoSceneRunning,assertLinkedDeviceChannels,protectManualCommands,physicalOutlets,appid,region,googleAccessToken,projectId}){
 const collection=name=>db().collection(name),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const auth=createAuth({db,accounts,firebaseAuth,secret:process.env.EWELINK_APP_SECRET});
 const apns=createAPNs({teamId:process.env.PACE_APNS_TEAM_ID,keyId:process.env.PACE_APNS_KEY_ID,privateKey:process.env.PACE_APNS_PRIVATE_KEY,topic:process.env.PACE_APNS_WIDGET_TOPIC,production:process.env.PACE_APNS_PRODUCTION!=='false'});
 const fcm=require('./fcm.cjs')({enabled:process.env.PACE_WIDGETS_FCM_ENABLED==='true',projectId,accessToken:googleAccessToken});
 const directory={
  async account(id){if(!/^[a-f0-9]{64}$/.test(id||''))return null;const s=await requestReads.get(collection('ewelinkAppAccounts').doc(id));return s.exists?{...s.data(),id:s.id}:null;},
  async isSuperadmin(actor){if(actor.role!=='admin')return false;const s=await requestReads.get(collection('ewelinkAppSettings').doc('administrator'));return s.data()?.uid===actor.uid;},
  async activeAccounts(){const s=await collection('ewelinkAppAccounts').where('status','==','active').get();return s.docs.map(d=>({...d.data(),id:d.id}));},
  async grantedAccounts(id){const s=await collection('ewelinkAppAccounts').where('dashboardAccess.'+id+'.control','==',true).get();return s.docs.map(d=>({...d.data(),id:d.id}));}
 };
 const receipts={
  async claim(key,fingerprint){const ref=collection('paceWidgetCommands').doc(key);return db().runTransaction(async t=>{const s=await t.get(ref);if(s.exists)return {...s.data(),fresh:false};const value={fingerprint,createdAt:Date.now(),expireAt:new Date(Date.now()+86400000)};t.create(ref,value);return {...value,fresh:true};});},
  async complete(key,result){await collection('paceWidgetCommands').doc(key).update({result,finishedAt:Date.now()});}
 };
 const subscriptionId=s=>hash(s.actorId+':'+s.grantId+':'+s.workspaceId);
 const subscriptions={
  async save(s){await collection('paceWidgetSubscriptions').doc(subscriptionId(s)).set({...s,updatedAt:Date.now()});},
  async forWorkspace(id){const s=await collection('paceWidgetSubscriptions').where('workspaceId','==',id).get();return s.docs.map(d=>({...d.data(),_id:d.id}));},
  async remove(s){await collection('paceWidgetSubscriptions').doc(s._id||subscriptionId(s)).delete();}
 };
 let service;
 const snapshots=createSnapshots({access:owner=>programming.access(owner),listDevices,appid,region,onChanged:async(id,devices,version)=>{const r=await service.changed(id,devices,version);if(!r.subscribers)snapshots.unwatch(id);}});
 service=createWidgetService({authenticate:token=>auth.authenticate(token),directory,snapshots,receipts,subscriptions,
  push:{async invalidate(sub,event){const g=await collection('paceWidgetGrants').doc(sub.grantId).get();if(!g.exists||g.data().revoked){await subscriptions.remove(sub);return;}if(sub.transport==='fcm')await fcm.invalidate(sub,event);else await apns.invalidate(sub,event);}},
  usage:createUsage({fetchUsage:require('./monitoring.cjs')({projectId,accessToken:googleAccessToken})}),
  commands:{async setState({actor,workspace,device,state}){
   const credentials=await programming.access(workspace.providerOwner),token=credentials.accessToken;
   const req={cookies:{ewelink_access:token},appActor:actor,appAccount:workspace,programmingOwner:workspace.providerOwner,query:{workspaceId:device.homeId}};
   await assertNoSceneRunning(req);
   const outlets=device.outlets?.length?physicalOutlets(device.id,device.outlets):null;
   await assertLinkedDeviceChannels(token,device.id,outlets);
   const action={deviceId:device.id,kind:outlets?'multi':'single',state,...(outlets?{outlets}:{})};
   const guard=await protectManualCommands(token,[action]);
   if(!guard.actions.length)return {protected:true,message:guard.message||'Dispositivo richiesto da una programmazione attiva.'};
   const safe=guard.actions[0],params=safe.kind==='multi'?{switches:safe.outlets.map(outlet=>({outlet,switch:state}))}:{switch:state};
   await api('/v2/device/thing/status',token,{type:1,id:device.id,params});
   // A fresh provider read may confirm the state; do not optimistically mutate the cache.
   await snapshots.refresh(workspace).catch(()=>{});
   return {protected:!!guard.protected?.length,message:guard.message||''};
  }}
 });
 const attempts=new Map();
 function limit(req,res,next){
  const now=Date.now(),ip=req.ip||'unknown';for(const[k,v]of attempts)if(v.until<=now)attempts.delete(k);
  const key=ip+(req.path.includes('/commands')?':command':':read'),window=attempts.get(key)||{until:now+60000,count:0};
  if(++window.count>(key.endsWith(':command')?40:180)){res.set('Retry-After','60');return res.status(429).json({ok:false,error:'rate_limited'});}
  if(attempts.size>5000)return res.status(503).json({ok:false,error:'temporarily_unavailable'});attempts.set(key,window);next();
 }
 const bearer=req=>{const m=/^Bearer ([A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43})$/.exec(req.get('authorization')||'');if(!m)throw failure(401,'login_required');return m[1];};
 const route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await fn(req));}catch(e){e=firebaseQuota.record(e);if(e.retryAfterMs)res.set('Retry-After',String(Math.ceil(e.retryAfterMs/1000)));res.status(e.status||503).json({ok:false,error:e.code||'temporarily_unavailable',retryAfterMs:e.retryAfterMs});}};
 app.get('/widgets/connect.html',(_req,res)=>{res.set('Referrer-Policy','no-referrer');res.set('X-Frame-Options','DENY');res.sendFile(path.join(__dirname,'connect.html'));});
 app.get('/widgets/connect.js',(_req,res)=>res.sendFile(path.join(__dirname,'connect.js')));
 app.get('/api/widgets/config',(_req,res)=>res.json({ok:true,enabled:true,pushAvailable:apns.configured,androidPushAvailable:fcm.configured}));
 app.post('/api/widgets/pair',limit,route(req=>auth.pair(req,req.body)));
 app.post('/api/widgets/token',limit,route(req=>auth.exchange(req.body)));
 app.post('/api/widgets/logout',limit,route(req=>auth.revoke(bearer(req))));
 app.post('/api/widgets/subscriptions/sync',limit,route(async req=>{
  const token=bearer(req),identity=await auth.authenticate(token),body=req.body;
  if(!body||body.installationId!==identity.installationId||!['apns','fcm'].includes(body.transport)||!Array.isArray(body.boards)||body.boards.length>20)throw failure(400,'invalid_subscription');
  if(body.transport==='apns'?!apns.configured:!fcm.configured)throw failure(503,'push_not_configured');
  for(const board of body.boards){
   await service.subscribe(token,{...board,installationId:body.installationId,transport:body.transport,token:body.token});
   const workspace=await directory.account(board.workspaceId);if(workspace)await snapshots.watch(workspace);
  }
  const existing=await collection('paceWidgetSubscriptions').where('grantId','==',identity.grantId).get();
  const wanted=new Set(body.boards.map(b=>b.workspaceId));
  for(const doc of existing.docs)if(!wanted.has(doc.data().workspaceId)){
   const id=doc.data().workspaceId;await doc.ref.delete();
   if(!(await subscriptions.forWorkspace(id)).length)snapshots.unwatch(id);
  }
  return {ok:true};
 }));
 app.get('/api/widgets/me',limit,route(async req=>{const token=bearer(req),identity=await auth.authenticate(token),a=await directory.account(identity.id);return {ok:true,userName:a.name,isSuperadmin:await directory.isSuperadmin(a),primaryWorkspaceId:a.id,boards:await service.boards(token),pushAvailable:apns.configured,androidPushAvailable:fcm.configured};}));
 installRoutes(app,service,{limit});
 // Resume event streams once at process start for existing subscriptions, no periodic DB reads.
 if(apns.configured||fcm.configured)void collection('paceWidgetSubscriptions').get().then(async rows=>{
  for(const id of new Set(rows.docs.map(s=>s.data().workspaceId))){const a=await directory.account(id);if(a?.status==='active')await snapshots.watch(a).catch(()=>{});}
 }).catch(()=>{});
 return {stop:()=>snapshots.stop()};
};
