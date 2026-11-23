'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const createIndex=require('../schedule-index.cjs'),reads=require('../request-reads.cjs'),quotaFactory=require('../firebase-quota.cjs').create;
const doc=(id,data)=>({id,ref:{id},data:()=>({...data})});
test('one schedule stream serves thousands of deadline and active-window scans without database reads',()=>{
 let subscribed=0,callback,changes=0,closed=0;
 const index=createIndex({query:()=>({onSnapshot(next){subscribed++;callback=next;return ()=>closed++;}}),onChange:()=>changes++});
 index.start();callback({docs:[doc('later',{enabled:true,nextAt:15000}),doc('first',{enabled:true,nextAt:1000}),doc('solar',{enabled:true,solarRefreshAt:3000})]});
 for(let i=0;i<2880;i++){assert.deepEqual(index.due('nextAt',1000,20).docs.map(d=>d.id),['first']);assert.equal(index.all().docs.length,3);}
 callback({docs:[doc('later',{enabled:true,nextAt:15000})]});assert.equal(index.due('nextAt',1000).docs.length,0);assert.equal(changes,2);assert.equal(subscribed,1);
 index.stop();callback({docs:[doc('stale',{nextAt:0})]});assert.equal(index.all(),null);assert.equal(closed,1);
});
test('a failed stream invalidates the index and reconnects with a delay',()=>{
 let next,fail,job,subscribed=0,cancelled=0;
 const index=createIndex({query:()=>({onSnapshot(n,e){subscribed++;next=n;fail=e;return ()=>cancelled++;}}),setTimer:(fn,ms)=>{job={fn,ms};return 1;},clearTimer:()=>{job=null;}});
 index.start();next({docs:[doc('one',{nextAt:0})]});fail(Object.assign(Error('unavailable'),{code:14}));assert.equal(index.all(),null);assert.equal(job.ms,60000);
 job.fn();assert.equal(subscribed,2);next({docs:[]});assert.equal(index.all().docs.length,0);index.stop();assert.equal(cancelled,1);
});
test('confirmed Firebase quota stops work for an hour without extending on locally blocked calls',()=>{
 let time=0;const quota=quotaFactory({now:()=>time});const e=quota.record(Object.assign(Error('8 RESOURCE_EXHAUSTED: Quota exceeded.'),{code:8}));assert.equal(e.status,503);assert.equal(e.code,'firebase_quota');
 for(time=1000;time<3600000;time+=1000){assert.throws(()=>quota.check(),{code:'firebase_quota'});quota.record(e);}
 time=3600000;assert.doesNotThrow(()=>quota.check());assert.equal(quota.wait(),0);
 const provider=Object.assign(Error('invoke too much'),{code:412});assert.equal(quota.record(provider),provider);assert.equal(quota.wait(),0);
});
test('duplicate permission reads are coalesced only inside one request; new requests observe revocations',async()=>{
 let count=0,active=true;const firestore={},ref=()=>({firestore,path:'accounts/a',get:async()=>{count++;return {active};}});
 await reads.run(async()=>{const [a,b]=await Promise.all([reads.get(ref()),reads.get(ref())]);assert.equal(a.active,true);assert.equal(a,b);});assert.equal(count,1);
 active=false;await reads.run(async()=>assert.equal((await reads.get(ref())).active,false));assert.equal(count,2);
 await reads.get(ref());await reads.get(ref());assert.equal(count,4);
});
test('HTTP write requests never reuse permission reads and completed GET scopes are cleared',async()=>{
 let count=0;const ref={path:'accounts/a',get:async()=>++count};
 await new Promise(resolve=>reads.middleware({method:'POST'},new EventEmitter(),async()=>{assert.equal(await reads.get(ref),1);assert.equal(await reads.get(ref),2);resolve();}));
 const res=new EventEmitter();await new Promise(resolve=>reads.middleware({method:'GET'},res,async()=>{assert.equal(await reads.get(ref),3);assert.equal(await reads.get(ref),3);res.emit('finish');assert.equal(await reads.get(ref),4);resolve();}));
});
test('browser database cooldown applies across accounts and API paths without claiming a logout',()=>{
 let time=0;const b=require('../request-backoff.js')(()=>time);b.block('first','/api/programming',3600000,{code:'firebase_quota',message:'Quota Firebase in pausa'});
 assert.equal(b.wait('second','/api/devices'),3600000);assert.equal(b.error('second','/api/devices').status,503);assert.equal(b.error('second','/api/app/session').code,'firebase_quota');
 b.block('third','/api/app/session',1000,{code:'firebase_quota'});assert.equal(b.wait('second','/api/devices'),3600000);
 time=3600001;assert.equal(b.wait('second','/api/devices'),0);
});
