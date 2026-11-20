'use strict';
module.exports=function createFCM({enabled=false,projectId,accessToken,fetch=globalThis.fetch}){
 const configured=enabled&&!!projectId&&typeof accessToken==='function';
 return {configured,async invalidate(sub){
  if(!configured)throw Object.assign(new Error('fcm_not_configured'),{code:'fcm_not_configured'});
  if(sub.transport!=='fcm'||typeof sub.token!=='string'||sub.token.length<16||sub.token.length>4096)throw new Error('invalid_push_token');
  const response=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,{method:'POST',headers:{Authorization:'Bearer '+await accessToken(),'Content-Type':'application/json'},body:JSON.stringify({message:{token:sub.token,data:{type:'pace_widgets_changed'},android:{priority:'normal',collapse_key:'pace-widgets-state',ttl:'86400s',restricted_package_name:'it.gm83.pacewidgets'}}}),signal:AbortSignal.timeout(15000)});
  if(response.ok)return;
  const body=await response.json().catch(()=>({}));
  const code=body.error?.details?.find(d=>d.errorCode)?.errorCode||body.error?.status||'UNKNOWN';
  const expired=code==='UNREGISTERED';
  throw Object.assign(new Error('fcm_rejected'),{code:'fcm_rejected',status:response.status,reason:code,invalidSubscription:expired});
 }};
};
