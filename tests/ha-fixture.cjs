'use strict';
function fixture(){
 const store=new Map(),listeners=[],queries=[];let chain=Promise.resolve();const copy=v=>v===undefined?undefined:structuredClone(v);
 const matches=(data,filters)=>filters.every(([field,op,value])=>{const v=field.split('.').reduce((a,k)=>a?.[k],data);return op==='=='?v===value:v<=value;});
 const notify=()=>{for(const l of listeners)if(l.active){const snap=l.snapshot(),signature=JSON.stringify(snap.docs.map(d=>[d.id,d.data()]));if(signature!==l.signature){l.signature=signature;queueMicrotask(()=>{if(l.active)l.next(snap);});}}};
 function ref(col,id){return {id,path:col+'/'+id,get:async()=>snapshot(col,id),set:async(data,opts)=>{store.set(col+'/'+id,copy(opts?.merge?{...store.get(col+'/'+id),...data}:data));notify();}};}
 function snapshot(col,id){return {id,ref:ref(col,id),exists:store.has(col+'/'+id),data:()=>copy(store.get(col+'/'+id))};}
 function query(col,filters=[],limit=Infinity){const result=()=>({docs:[...store].filter(([k,v])=>k.startsWith(col+'/')&&matches(v,filters)).slice(0,limit).map(([k])=>snapshot(col,k.slice(col.length+1)))});return {doc:id=>ref(col,id),where:(...f)=>query(col,[...filters,f],limit),limit:n=>query(col,filters,n),get:async()=>{queries.push({col,filters});return result();},onSnapshot(next){const l={active:true,next,snapshot:result};listeners.push(l);notify();return ()=>l.active=false;}};}
 return {store,queries,notify,collection:query,runTransaction(fn){const task=chain.then(async()=>{const writes=[];const result=await fn({get:r=>r.get(),set:(r,d)=>writes.push(()=>store.set(r.path,copy(d))),delete:r=>writes.push(()=>store.delete(r.path))});writes.forEach(f=>f());notify();return result;});chain=task.catch(()=>{});return task;}};
}

module.exports=fixture;
