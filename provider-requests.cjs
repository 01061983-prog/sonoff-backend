'use strict';
const {createHash}=require('node:crypto');
const limited=(retryAfterMs,providerError)=>Object.assign(new Error(providerError===412?'eWeLink segnala che la quota di chiamate dell’integrazione PACE è stata raggiunta. Verifica la quota nel portale sviluppatori eWeLink.':'eWeLink sta limitando le richieste. Attendi il ripristino automatico del collegamento.'),{status:429,code:providerError===412?'provider_quota':'rate_limited',providerError:Number.isSafeInteger(providerError)?providerError:undefined,retryAfterMs:Math.max(1000,retryAfterMs)});
module.exports=function createProviderRequests({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,globalGap=550,endpointGap=1100,cooldown=60000,onLimit=()=>{}}={}){
 const pending=[],last=new Map(),blocked=new Map(),limitCodes=new Map(),cache=new Map(),inflight=new Map(),epochs=new Map();let globalLast=-Infinity,timer=null,quotaUntil=0;
 const endpoint=path=>path.split('?')[0],scope=token=>createHash('sha256').update(token||'').digest('hex');
 function pump(){
  if(timer!==null){clearTimer(timer);timer=null;}
  const time=now();for(let i=pending.length-1;i>=0;i--){const job=pending[i],until=Math.max(blocked.get(job.endpoint)||0,quotaUntil);if(until>time){pending.splice(i,1);job.reject(limited(until-time,quotaUntil>time?412:limitCodes.get(job.endpoint)));}}
  if(!pending.length)return;
  const ready=job=>Math.max(globalLast+globalGap,(last.get(job.endpoint)??-Infinity)+endpointGap);
  const eligible=pending.filter(job=>ready(job)<=time).sort((a,b)=>a.priority-b.priority||a.order-b.order);
  if(!eligible.length){timer=setTimer(pump,Math.max(1,Math.min(...pending.map(ready))-time));return;}
  const job=eligible[0];pending.splice(pending.indexOf(job),1);globalLast=time;last.set(job.endpoint,time);
  Promise.resolve().then(job.operation).then(job.resolve,job.reject);pump();
 }
 let order=0;
 function enqueue(path,body,operation,fresh){const ep=endpoint(path),until=Math.max(blocked.get(ep)||0,quotaUntil);if(until>now())return Promise.reject(limited(until-now(),quotaUntil>now()?412:limitCodes.get(ep)));if(pending.length>=200)return Promise.reject(limited(5000));return new Promise((resolve,reject)=>{pending.push({endpoint:ep,priority:fresh||body!==undefined&&ep!=='/v2/device/thing'?0:1,order:order++,operation,resolve,reject});pump();});}
 function invalidate(owner){epochs.set(owner,(epochs.get(owner)||0)+1);for(const [key,value] of cache)if(value.owner===owner)cache.delete(key);for(const key of inflight.keys())if(key.startsWith(owner+':'))inflight.delete(key);}
 return {
  limit(path,retryAfterMs=cooldown,providerError){const ep=endpoint(path),code=Number.isSafeInteger(providerError)?providerError:undefined,until=Math.max(blocked.get(ep)||0,now()+Math.max(code===412?300000:cooldown,Number(retryAfterMs)||0));blocked.set(ep,until);limitCodes.set(ep,code);if(code===412)quotaUntil=Math.max(quotaUntil,until);onLimit(ep,code);pump();return limited(until-now(),code);},
  async run({path,token,body,authorization,fresh=false},operation){
   const ep=endpoint(path),owner=scope(token),mutating=body!==undefined&&ep==='/v2/device/thing/status';
   // Caches never bypass local account ACL checks; only verified provider GETs
   // are shared, keyed by the exact bearer and complete resource path.
   const ttl=body===undefined&&!authorization&&['/v2/family','/v2/device/thing','/v2/device/thing/status'].includes(ep)?(ep==='/v2/family'?5000:2000):0;
   const key=owner+':'+path,epoch=epochs.get(owner)||0;
   if(mutating)invalidate(owner);
   try{
    if(quotaUntil>now())throw limited(quotaUntil-now(),412);
    if(ttl){const saved=cache.get(key);if(!fresh&&saved&&saved.until>now())return structuredClone(saved.value);if(inflight.has(key))return structuredClone(await inflight.get(key));}
    const job=enqueue(path,body,operation,fresh);
    if(ttl)inflight.set(key,job);
    try{const value=await job;if(ttl&&epoch===(epochs.get(owner)||0)){if(cache.size>=500)for(const [id,entry] of cache)if(entry.until<=now())cache.delete(id);if(cache.size<500)cache.set(key,{owner,value:structuredClone(value),until:now()+ttl});}return ttl?structuredClone(value):value;}
    finally{if(ttl&&inflight.get(key)===job)inflight.delete(key);}
   }finally{if(mutating)invalidate(owner);}
  }
 };
};
