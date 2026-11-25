(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PaceCommandFeedback=factory();})(typeof window==='object'?window:this,()=>{
 'use strict';
 // Use only the bridge's read-back confirmation, never the requested state alone.
 return function confirmedDevices(devices,result,body){
  const raw=result?.raw,confirmation=raw?.data,sent=result?.sent;
  if(raw?.provider!=='home_assistant'||raw.error!==0||confirmation?.status!=='confirmed'||confirmation.source!=='home_assistant'||!['on','off'].includes(confirmation.state)||confirmation.state!==body?.state||sent?.id!==body.deviceId||!Number.isFinite(confirmation.observedAt))return null;
  const device=devices.find(d=>d.deviceid===body.deviceId);
  if(device?.provider!=='home_assistant')return null;
  if(device.observedAt>confirmation.observedAt)return devices;
  const multi=Array.isArray(device.params?.switches);
  if(multi&&(!Array.isArray(body.outlets)||body.outlets.length!==1||body.outlets[0]!==0||sent.params?.switches?.length!==1||sent.params.switches[0].outlet!==0||sent.params.switches[0].switch!==confirmation.state))return null;
  if(!multi&&sent.params?.switch!==confirmation.state)return null;
  return devices.map(d=>d!==device?d:{...d,online:true,observedAt:confirmation.observedAt,params:{...d.params,...(multi?{switches:d.params.switches.map(c=>c.outlet===0?{...c,switch:confirmation.state}:c)}:{switch:confirmation.state})}});
 };
});
