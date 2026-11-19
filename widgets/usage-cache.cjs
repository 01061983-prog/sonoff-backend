'use strict';
// Shared server cache: widget refreshes do not trigger one Monitoring call each.
module.exports=function createUsageCache({fetchUsage,now=Date.now,ttl=15*60*1000}){
 let cached=null,expires=0,inflight=null;
 return {async read(){
  if(cached&&now()<expires)return cached;
  if(inflight)return inflight;
  inflight=Promise.resolve().then(async()=>{
   try{
    if(typeof fetchUsage!=='function')return {status:'unavailable',reason:'monitoring_not_configured'};
    const value=await fetchUsage();
    if(!Number.isFinite(value.reads)||value.reads<0||!value.periodStart||!value.periodEnd)throw new Error('invalid_metric');
    cached={status:'available',estimated:true,project:value.project,reads:value.reads,freeDailyReads:50000,observedAt:Number.isFinite(value.observedAt)?value.observedAt:now(),periodStart:value.periodStart,periodEnd:value.periodEnd};
    expires=now()+ttl;return cached;
   }catch(e){return cached?{...cached,status:'stale'}:{status:'unavailable',reason:'monitoring_unavailable'};}
  });
  let result;
  try{result=await inflight;}finally{inflight=null;}
  // Cache unavailability too; a missing configuration must not cause repeated queries.
  if(!cached||result.status!=='available'){cached=result;expires=now()+ttl;}
  return result;
 }};
};
