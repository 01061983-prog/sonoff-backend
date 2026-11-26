'use strict';
const crypto=require('node:crypto'),{fail,id,legacyChannels}=require('./protocol.cjs');
module.exports=function createProvider({load,authorize,bridge,secret}){
 const prefix='paceha1:',sign=(owner,revision)=>crypto.createHmac('sha256',secret).update('pace-ha:'+owner+':'+revision).digest('hex');
 const supports=token=>typeof token==='string'&&token.startsWith(prefix);
 async function config(owner,{required=false}={}){const c=await load(owner);if(!c||!c.enabled){if(required)throw fail(409,'ha_disabled','Provider Home Assistant non attivo.');return null;}const account=await authorize(owner);if(!account||account.id!==c.accountId||account.status!=='active')throw fail(403,'app_blocked','Plancia non autorizzata.');return c;}
 const homes=c=>[{id:c.workspaceId,name:c.workspaceName},...(c.workspaces||[]).filter(h=>h.id!==c.workspaceId)];
 async function resolve(token){const parts=String(token).split(':');if(parts.length!==4||parts[0]!=='paceha1'||!id(parts[1])||! /^[1-9][0-9]{0,8}$/.test(parts[2])||! /^[a-f0-9]{64}$/.test(parts[3])||!crypto.timingSafeEqual(Buffer.from(sign(parts[1],parts[2])),Buffer.from(parts[3])))throw fail(401,'ha_context','Contesto Home Assistant non valido.');const c=await config(parts[1],{required:true});if(c.revision!==Number(parts[2]))throw fail(409,'app_provider_context_changed','La configurazione Home Assistant è cambiata. Ricarica la plancia.');return c;}
 function normalized(c,snapshot){return c.devices.map(d=>{const s=snapshot.states.get(d.entityId),state=snapshot.ready&&['on','off'].includes(s?.state)?s.state:'unknown';return {deviceid:d.deviceId,name:d.name,online:snapshot.ready&&state!=='unknown',params:d.kind==='multi'?{switches:[{outlet:0,switch:state}]}:{switch:state},familyId:c.workspaceId,productModel:d.model||'MINIR4',controlOutlets:[0],provider:'home_assistant',ownership:{type:'unknown',source:'home_assistant'},observedAt:s?.receivedAt||null};}).concat((c.excludedDevices||[]).map(d=>({deviceid:d.deviceId,name:d.name,online:false,params:{switches:d.outlets.map(outlet=>({outlet,switch:'unknown'}))},familyId:c.workspaceId,productModel:'Non collegato al ponte',controlOutlets:[],provider:'home_assistant',ownership:{type:'unknown',source:'home_assistant'},observedAt:null,unavailableReason:'Dispositivo escluso dalla prima attivazione locale'})));}
 return {
  supports,
  async isConfigured(owner){return !!(await load(owner))?.enabled;},
  async credentials(owner){const c=await config(owner);return c?{provider:'home_assistant',owner,accessToken:prefix+c.owner+':'+c.revision+':'+sign(c.owner,c.revision),atExpiredTime:Number.MAX_SAFE_INTEGER}:null;},
  async owner(token){return (await resolve(token)).owner;},
  async families(token){const c=await resolve(token);return homes(c);},
  async devices(token,homes,{deviceIds}={}){const c=await resolve(token);if(homes?.some(h=>h.id!==c.workspaceId&&!c.workspaces?.some(w=>w.id===h.id)))throw fail(403,'workspace_forbidden');return normalized(c,bridge.snapshot(c)).filter(d=>!deviceIds||deviceIds.includes(d.deviceid));},
  async assertChannels(token,deviceId,outlets){const c=await resolve(token),d=c.devices.find(d=>d.deviceId===deviceId);if(!d)throw fail(403,'ha_device','Dispositivo non associato a questa plancia.');if(outlets!==null&&outlets!==undefined&&(!Array.isArray(outlets)||outlets.length!==1||outlets[0]!==0)&&!legacyChannels(d,outlets))throw fail(400,'ha_channels','MINIR4 dispone soltanto del canale fisico 1.');},
  async call(path,token,body){
   const c=await resolve(token),url=new URL(path,'https://provider.invalid');
   if(url.pathname==='/v2/family'&&body===undefined)return {error:0,data:{familyList:homes(c)}};
   if(url.pathname==='/v2/device/thing/status'&&body!==undefined){
    if(body.type!==1||typeof body.id!=='string'||!body.params||typeof body.params!=='object')throw fail(400,'ha_command');
    const keys=Object.keys(body.params);let state;
    if(keys.length===1&&keys[0]==='switch')state=body.params.switch;
    else if(keys.length===1&&keys[0]==='switches'&&Array.isArray(body.params.switches)){
     const channels=body.params.switches,d=c.devices.find(d=>d.deviceId===body.id);
     if(channels.every(s=>s&&typeof s==='object'&&Object.keys(s).every(k=>['outlet','switch'].includes(k)))&&((channels.length===1&&channels[0].outlet===0)||legacyChannels(d,channels.map(s=>s.outlet)))&&channels.every(s=>s.switch===channels[0].switch))state=channels[0].switch;
    }
    if(!['on','off'].includes(state))throw fail(400,'ha_command','Sono consentiti soltanto comandi espliciti ON/OFF al relè verificato.');
    const result=await bridge.command(c,{deviceId:body.id,state});return {error:0,data:result,provider:'home_assistant'};
   }
   if(url.pathname==='/v2/scene'&&body===undefined)return {error:0,data:{sceneList:[]}};
   throw fail(400,'ha_unsupported','Operazione non disponibile per il provider Home Assistant.');
  },
  async watch(token,callback){const c=await resolve(token);return bridge.subscribe(c.owner,callback);},
  async snapshot(token){const c=await resolve(token),s=bridge.snapshot(c);return {...s,devices:normalized(c,s)};}
 };
};
