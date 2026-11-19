'use strict';
const {createHash}=require('node:crypto');
const error=(status,code)=>Object.assign(new Error(code),{status,code});
// All ports are mandatory. There is deliberately no production fallback to demo data.
function createWidgetService({authenticate,directory,snapshots,commands,receipts,subscriptions,push,usage,now=Date.now}) {
 for(const [key,value] of Object.entries({authenticate,directory,snapshots,commands,receipts,subscriptions,push,usage}))if(!value)throw new Error(`Missing adapter: ${key}`);
 async function actor(credential){
  const identity=await authenticate(credential);
  if(!identity?.id||!identity.uid||!Number.isFinite(identity.authTime))throw error(401,'login_required');
  const profile=await directory.account(identity.id);
  if(!profile||profile.status!=='active'||profile.uid!==identity.uid||identity.authTime<Number(profile.invalidBefore||0))throw error(403,'account_disabled');
  return {...profile,verifiedAuthTime:identity.authTime,verifiedInstallationId:identity.installationId,verifiedGrantId:identity.grantId};
 }
 async function permitted(a,id){
  const target=await directory.account(id);
  if(!target||target.status!=='active')throw error(403,'workspace_forbidden');
  if(target.id!==a.id&&target.dashboardAccess?.[a.id]?.control!==true&&!await directory.isSuperadmin(a))throw error(403,'workspace_forbidden');
  return target;
 }
 async function access(credential,id){const a=await actor(credential);return {actor:a,target:await permitted(a,id)};}
 const publicBoard=b=>({id:b.id,name:b.name,logo:b.logo||''});
 return {
  async boards(credential){
   const a=await actor(credential),root=await directory.isSuperadmin(a);
   const boards=root?await directory.activeAccounts():[a,...await directory.grantedAccounts(a.id)];
   return [...new Map(boards.filter(b=>b.status==='active'&&(root||b.id===a.id||b.dashboardAccess?.[a.id]?.control===true)).map(b=>[b.id,publicBoard(b)])).values()];
  },
  async snapshot(credential,workspaceId,deviceIds){
   const {target}=await access(credential,workspaceId);
   const snapshot=await snapshots.read(target);
   const ids=deviceIds?new Set(deviceIds):null;
   return {version:snapshot.version,observedAt:snapshot.observedAt,liveUpdates:snapshot.liveUpdates===true,workspace:publicBoard(target),
    devices:snapshot.devices.filter(d=>!ids||ids.has(d.id)).map(d=>({id:d.id,name:d.name,kind:d.kind,
     online:typeof d.online==='boolean'?d.online:null,state:['on','off','mixed'].includes(d.state)?d.state:'unknown'}))};
  },
  async command(credential,input){
   if(!input||!['on','off'].includes(input.state)||! /^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId||'')||typeof input.deviceId!=='string')throw error(400,'invalid_command');
   const {actor:a,target}=await access(credential,input.workspaceId);
   const snapshot=await snapshots.read(target),device=snapshot.devices.find(d=>d.id===input.deviceId);
   if(!device)throw error(403,'device_forbidden');
   if(device.kind!=='switch')throw error(409,'open_pace_for_this_device');
   if(device.online!==true)throw error(409,'device_offline');
   const key=createHash('sha256').update(a.id+':'+input.requestId).digest('hex');
   const fingerprint=createHash('sha256').update(JSON.stringify([target.id,device.id,input.state])).digest('hex');
   // claim() MUST be atomic and durable in production; claimed commands are never retried automatically.
   const claim=await receipts.claim(key,fingerprint);
   if(claim.fingerprint!==fingerprint)throw error(409,'request_id_reused');
   if(!claim.fresh)return claim.result||{status:'pending',requestId:input.requestId};
   try {
    // Adapter must use PACE's existing device/channel checks AND protectManualCommands.
    const result=await commands.setState({actor:a,workspace:target,device,state:input.state});
    const receipt={status:result.protected?'protected':'accepted',requestId:input.requestId,message:result.message||''};
    // Accepted is not confirmed: only provider feedback changes the LED.
    await receipts.complete(key,receipt);return receipt;
   } catch(e){
    await receipts.complete(key,{status:'uncertain',requestId:input.requestId});throw e;
   }
  },
  async usage(credential){const a=await actor(credential);if(!await directory.isSuperadmin(a))throw error(403,'superadmin_only');return usage.read();},
  async subscribe(credential,{workspaceId,deviceIds,installationId,transport,token}){
   const {actor:a}=await access(credential,workspaceId);
   if(a.verifiedInstallationId!==installationId)throw error(403,'installation_forbidden');
   if(!Array.isArray(deviceIds)||!deviceIds.length||deviceIds.length>20||!deviceIds.every(x=>typeof x==='string')||! /^[a-zA-Z0-9_-]{16,100}$/.test(installationId||'')||!['apns','fcm'].includes(transport)||typeof token!=='string'||token.length<16||token.length>4096)throw error(400,'invalid_subscription');
   const snapshot=await this.snapshot(credential,workspaceId);
   if(deviceIds.some(id=>!snapshot.devices.some(d=>d.id===id)))throw error(403,'device_forbidden');
   await subscriptions.save({actorId:a.id,uid:a.uid,authTime:a.verifiedAuthTime,grantId:a.verifiedGrantId,workspaceId,deviceIds:[...new Set(deviceIds)],installationId,transport,token});return {ok:true};
  },
  // Feed only verified provider changes here. Recheck grants before every push.
  async changed(workspaceId,deviceId,version){
   const registered=await subscriptions.forWorkspace(workspaceId);let remaining=registered.length;
   for(const sub of registered){
    const changed=Array.isArray(deviceId)?deviceId:[deviceId];
    if(!sub.deviceIds.some(id=>changed.includes(id)))continue;
    const a=await directory.account(sub.actorId);
    if(!a||a.uid!==sub.uid||a.status!=='active'||sub.authTime<Number(a.invalidBefore||0)){await subscriptions.remove(sub);remaining--;continue;}
    try{await permitted(a,workspaceId);}catch(e){if(e.status===403){await subscriptions.remove(sub);remaining--;continue;}throw e;}
    // Invalidation only: no device names, tokens or state in lock-screen payloads.
    await push.invalidate(sub,{workspaceId,version});
   }
   return {subscribers:remaining};
  }
 };
}
function installRoutes(app,service,{limit}) {
 if(typeof limit!=='function')throw new Error('A per-installation rate limiter is required');
 const route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await fn(req));}catch(e){res.status(e.status||503).json({ok:false,error:e.code||'temporarily_unavailable'});}};
 const credential=req=>{const match=/^Bearer (\S{16,8192})$/.exec(req.get('authorization')||'');if(!match)throw error(401,'login_required');return match[1];};
 app.get('/api/widgets/boards',limit,route(req=>service.boards(credential(req))));
 app.get('/api/widgets/snapshot/:id',limit,route(req=>service.snapshot(credential(req),req.params.id)));
 app.get('/api/widgets/usage',limit,route(req=>service.usage(credential(req))));
 app.post('/api/widgets/commands',limit,route(req=>service.command(credential(req),req.body)));
 app.post('/api/widgets/subscriptions',limit,route(req=>service.subscribe(credential(req),req.body)));
}
module.exports={createWidgetService,installRoutes};
