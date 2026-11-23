'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),create=require('../programming'),core=require('../programming-core');
function fixture(){
 const store=new Map(),listeners=[],queries=[];let chain=Promise.resolve();const copy=v=>v===undefined?undefined:structuredClone(v);
 const matches=(data,filters)=>filters.every(([field,op,value])=>{const v=field.split('.').reduce((a,k)=>a?.[k],data);return op==='=='?v===value:v<=value;});
 const notify=()=>{for(const l of listeners)if(l.active){const snap=l.snapshot(),signature=JSON.stringify(snap.docs.map(d=>[d.id,d.data()]));if(signature!==l.signature){l.signature=signature;queueMicrotask(()=>{if(l.active)l.next(snap);});}}};
 function ref(col,id){return {id,path:col+'/'+id,get:async()=>snapshot(col,id),set:async(data,opts)=>{store.set(col+'/'+id,copy(opts?.merge?{...store.get(col+'/'+id),...data}:data));notify();}};}
 function snapshot(col,id){return {id,ref:ref(col,id),exists:store.has(col+'/'+id),data:()=>copy(store.get(col+'/'+id))};}
 function query(col,filters=[],limit=Infinity){const result=()=>({docs:[...store].filter(([k,v])=>k.startsWith(col+'/')&&matches(v,filters)).slice(0,limit).map(([k])=>snapshot(col,k.slice(col.length+1)))});return {doc:id=>ref(col,id),where:(...f)=>query(col,[...filters,f],limit),limit:n=>query(col,filters,n),get:async()=>{queries.push({col,filters});return result();},onSnapshot(next){const l={active:true,next,snapshot:result};listeners.push(l);notify();return ()=>l.active=false;}};}
 return {store,queries,notify,collection:query,runTransaction(fn){const task=chain.then(async()=>{const writes=[];const result=await fn({get:r=>r.get(),set:(r,d)=>writes.push(()=>store.set(r.path,copy(d))),delete:r=>writes.push(()=>store.delete(r.path))});writes.forEach(f=>f());notify();return result;});chain=task.catch(()=>{});return task;}};
}
const drain=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
test('live schedule changes arm exact deadlines without polling schedule collections',async()=>{
 const db=fixture();let time=core.localTime('2026-11-25','14:00'),serial=0;const tasks=new Map(),commands=[];
 const device={deviceid:'fixture-light',name:'Fixture',online:true,params:{switch:'off'}};
 const s=create({db:()=>db,now:()=>time,appid:'fixture',secret:'fixture-only',listDevices:async()=>[device],saveSession(){},wakeSetTimeout:(fn,ms)=>{tasks.set(++serial,{fn,at:time+ms});return serial;},wakeClearTimeout:id=>tasks.delete(id),api:async(path,token,body)=>{if(path==='/v2/user/profile')return {data:{region:'eu',user:{apikey:'fixture-owner'}}};if(path==='/v2/device/thing/status'){commands.push({at:time,state:body.params.switch});device.params.switch=body.params.switch;return {error:0};}throw Error('unexpected fixture API '+path);}});
 s.start();await drain();
 try{
 const req={cookies:{ewelink_access:'fixture-access',ewelink_refresh:'fixture-refresh',ewelink_expires:String(time+86400000)},body:{op:'save',authorize:true,schedule:{deviceId:'fixture-light',action:'on',repeat:'date',date:'2026-11-25',start:'14:01',end:'14:02',enabled:true}}};
 await s.mutate(req);await drain();
 // At 14:00:40 the regular safety tick only consults the live execution index.
 time=core.localTime('2026-11-25','14:00')+40000;await s.tick();await drain();
 const due=core.localTime('2026-11-25','14:01');assert.ok([...tasks.values()].some(t=>t.at===due));assert.equal(commands.length,0);
 const before=db.queries.filter(q=>q.col==='ewelinkProgrammingSchedules').length;
 for(let i=0;i<20;i++)await s.tick();assert.equal(db.queries.filter(q=>q.col==='ewelinkProgrammingSchedules').length,before);
 time=due;const next=[...tasks].find(([,t])=>t.at===due);tasks.delete(next[0]);next[1].fn();await drain();assert.deepEqual(commands,[{at:due,state:'on'}]);
 // Another tick cannot duplicate a command; the transaction is authoritative.
 await s.tick();assert.equal(commands.length,1);
 time=due+40000;await s.tick();await drain();const offAt=core.localTime('2026-11-25','14:02');assert.ok([...tasks.values()].some(t=>t.at===offAt));
 time=offAt;const off=[...tasks].find(([,t])=>t.at===offAt);tasks.delete(off[0]);off[1].fn();await drain();assert.deepEqual(commands,[{at:due,state:'on'},{at:offAt,state:'off'}]);
 }finally{s.stop();}
});
