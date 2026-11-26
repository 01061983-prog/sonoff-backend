'use strict';
const crypto=require('node:crypto'),{fail,id,legacyChannels,channels,validOutlets}=require('./protocol.cjs');
module.exports=function createProvider({load,authorize,bridge,secret}){
 const prefix='paceha1:',sign=(owner,revision)=>crypto.createHmac('sha256',secret).update('pace-ha:'+owner+':'+revision).digest('hex');
 const supports=token=>typeof token==='string'&&token.startsWith(prefix);
 async function config(owner,{required=false}={}){const c=await load(owner);if(!c||!c.enabled){if(required)throw fail(409,'ha_disabled','Provider Home Assistant non attivo.');return null;}const account=await authorize(owner);if(!account||account.id!==c.accountId||account.status!=='active')throw fail(403,'app_blocked','Plancia non autorizzata.');return c;}
 const homes=c=>[{id:c.workspaceId,name:c.workspaceName},...(c.workspaces||[]).filter(h=>h.id!==c.workspaceId)];
 async function resolve(token){const parts=String(token).split(':');if(parts.length!==4||parts[0]!=='paceha1'||!id(parts[1])||! /^[1-9][0-9]{0,8}$/.test(parts[2])||! /^[a-f0-9]{64}$/.test(parts[3])||!crypto.timingSafeEqual(Buffer.from(sign(parts[1],parts[2])),Buffer.from(parts[3])))throw fail(401,'ha_context','Contesto Home Assistant non valido.');const c=await config(parts[1],{required:true});if(c.revision!==Number(parts[2]))throw fail(409,'app_provider_context_changed','La configurazione Home Assistant è cambiata. Ricarica la plancia.');return c;}
 function normalized(c,snapshot){return c.devices.map(d=>{const observed=channels(d).map(ch=>{const s=snapshot.states.get(ch.entityId);return {outlet:ch.outlet,switch:snapshot.ready&&['on','off'].includes(s?.state)?s.state:'unknown',observedAt:s?.receivedAt||null};});return {deviceid:d.deviceId,name:d.name,online:snapshot.ready&&observed.every(s=>s.switch!=='unknown'),params:d.kind==='multi'?{switches:observed.map(({outlet,switch:state})=>({outlet,switch:state}))}:{switch:observed[0].switch},familyId:c.workspaceId,productModel:d.model||'MINIR4',controlOutlets:channels(d).map(c=>c.outlet),provider:'home_assistant',ownership:{type:'unknown',source:'home_assistant'},observedAt:observed.every(s=>s.observedAt!==null)?Math.min(...observed.map(s=>s.observedAt)):null};}).concat((c.excludedDevices||[]).map(d=>({deviceid:d.deviceId,name:d.name,online:false,params:{switches:d.outlets.map(outlet=>({outlet,switch:'unknown'}))},familyId:c.workspaceId,productModel:'Non collegato al ponte',controlOutlets:[],provider:'home_assistant',ownership:{type:'unknown',source:'home_assistant'},observedAt:null,unavailableReason:'Dispositivo escluso dalla prima attivazione locale'})));}
 return {
  supports,
  async isConfigured(owner){return !!(await load(owner))?.enabled;},
  async credentials(owner){const c=await config(owner);return c?{provider:'home_assistant',owner,accessToken:prefix+c.owner+':'+c.revision+':'+sign(c.owner,c.revision),atExpiredTime:Number.MAX_SAFE_INTEGER}:null;},
  async owner(token){return (await resolve(token)).owner;},
  async families(token){const c=await resolve(token);return homes(c);},
  async devices(token,homes,{deviceIds}={}){const c=await resolve(token);if(homes?.some(h=>h.id!==c.workspaceId&&!c.workspaces?.some(w=>w.id===h.id)))throw fail(403,'workspace_forbidden');return normalized(c,bridge.snapshot(c)).filter(d=>!deviceIds||deviceIds.includes(d.deviceid));},
  async assertChannels(token,deviceId,outlets){const c=await resolve(token),d=c.devices.find(d=>d.deviceId===deviceId);if(!d)throw fail(403,'ha_device','Dispositivo non associato a questa plancia.');if(outlets!==null&&outlets!==undefined&&!validOutlets(d,outlets)&&!legacyChannels(d,outlets))throw fail(400,'ha_channels','Seleziona soltanto i canali fisici collegati al ponte.');},
  async call(path,token,body){
   const c=await resolve(token),url=new URL(path,'https://provider.invalid');
   if(url.pathname==='/v2/family'&&body===undefined)return {error:0,data:{familyList:homes(c)}};
   if(url.pathname==='/v2/device/thing/status'&&body!==undefined){
    if(body.type!==1||typeof body.id!=='string'||!body.params||typeof body.params!=='object')throw fail(400,'ha_command');
    const keys=Object.keys(body.params),d=c.devices.find(d=>d.deviceId===body.id);let commands;
    if(!d)throw fail(400,'ha_command');
    if(keys.length===1&&keys[0]==='switch'&&channels(d).length===1)commands=[{outlet:0,switch:body.params.switch}];
    else if(keys.length===1&&keys[0]==='switches'&&Array.isArray(body.params.switches)){
     const requested=body.params.switches;
     if(requested.length&&requested.every(s=>s&&typeof s==='object'&&Object.keys(s).every(k=>['outlet','switch'].includes(k)))){
      if(validOutlets(d,requested.map(s=>s.outlet)))commands=requested;
      else if(legacyChannels(d,requested.map(s=>s.outlet))&&requested.every(s=>s.switch===requested[0].switch))commands=[{outlet:0,switch:requested[0].switch}];
     }
    }
    if(!commands||commands.some(s=>!['on','off'].includes(s.switch)))throw fail(400,'ha_command','Sono consentiti soltanto comandi espliciti ON/OFF ai relè verificati.');
    const snapshot=bridge.snapshot(c);if(!snapshot.ready)throw fail(503,'ha_offline','Raspberry o Home Assistant non disponibile.');
    if(commands.some(command=>!['on','off'].includes(snapshot.states.get(channels(d).find(ch=>ch.outlet===command.outlet).entityId)?.state)))throw fail(503,'ha_device_offline','Uno dei canali richiesti non è disponibile in Home Assistant. Nessun comando inviato.');
    const results=[];for(const command of commands)results.push({...await bridge.command(c,{deviceId:body.id,state:command.switch,outlet:command.outlet}),outlet:command.outlet});
    const result=results.length===1?results[0]:{status:'confirmed',channels:results,source:'home_assistant',observedAt:Math.max(...results.map(r=>r.observedAt))};return {error:0,data:result,provider:'home_assistant'};
   }
   if(url.pathname==='/v2/scene'&&body===undefined)return {error:0,data:{sceneList:[]}};
   throw fail(400,'ha_unsupported','Operazione non disponibile per il provider Home Assistant.');
  },
  async watch(token,callback){const c=await resolve(token);return bridge.subscribe(c.owner,callback);},
  async snapshot(token){const c=await resolve(token),s=bridge.snapshot(c);return {...s,devices:normalized(c,s)};}
 };
};
