'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),create=require('../provider-requests.cjs');
const request=(path,token='alice',body)=>({path,token,body});
const quick=()=>create({globalGap:0,endpointGap:0});
test('concurrent web/widget reads coalesce, clone results, and never share another account',async()=>{
 const c=quick();let calls=0,release;const operation=()=>{calls++;return new Promise(r=>release=r);};
 const a=c.run(request('/v2/device/thing?home=one'),operation),b=c.run(request('/v2/device/thing?home=one'),operation);await Promise.resolve();release({devices:[{state:'off'}]});
 const [x,y]=await Promise.all([a,b]);x.devices[0].state='on';assert.equal(y.devices[0].state,'off');assert.equal(calls,1);
 assert.equal((await c.run(request('/v2/device/thing?home=one'),()=>{throw Error('cached');})).devices[0].state,'off');
 await c.run(request('/v2/device/thing?home=one','bob'),async()=>{calls++;return {devices:[]};});assert.equal(calls,2);
 await c.run(request('/v2/device/thing?home=two'),async()=>{calls++;return {devices:[]};});assert.equal(calls,3);
});
test('a physical command is never cached/replayed and invalidates pre-command reads',async()=>{
 const c=quick();let resolveOld,reads=0,commands=0;
 const old=c.run(request('/v2/device/thing'),()=>{reads++;return new Promise(r=>resolveOld=r);});await Promise.resolve();
 await c.run(request('/v2/device/thing/status','alice',{state:'on'}),async()=>{commands++;return {accepted:true};});
 const fresh=await c.run(request('/v2/device/thing'),async()=>{reads++;return {state:'on'};});resolveOld({state:'off'});await old;
 assert.equal((await c.run(request('/v2/device/thing'),()=>{throw Error('cached fresh');})).state,'on');assert.equal(fresh.state,'on');assert.equal(reads,2);
 await assert.rejects(c.run(request('/v2/device/thing/status','alice',{state:'off'}),async()=>{commands++;throw Error('uncertain');}),/uncertain/);assert.equal(commands,2);
});
test('rate limit suppresses provider retries while keeping other endpoints usable',async()=>{
 let time=1000;const c=create({now:()=>time,globalGap:0,endpointGap:0});let calls=0;
 await assert.rejects(c.run(request('/v2/device/thing'),async()=>{calls++;throw c.limit('/v2/device/thing',90000);}),e=>e.status===429&&e.retryAfterMs===90000);
 for(let i=0;i<20;i++)await assert.rejects(c.run(request('/v2/device/thing','user-'+i),async()=>{calls++;}),{code:'rate_limited'});
 await c.run(request('/v2/device/thing/status','alice',{state:'on'}),async()=>{calls++;return {accepted:true};});assert.equal(calls,2);
 time+=90001;await c.run(request('/v2/device/thing'),async()=>{calls++;return {};});assert.equal(calls,3);
});
test('cached reads expire instead of inventing a fresh provider observation',async()=>{
 let time=0,calls=0;const c=create({now:()=>time,globalGap:0,endpointGap:0});const op=async()=>({version:++calls});
 assert.equal((await c.run(request('/v2/device/thing'),op)).version,1);time=1999;assert.equal((await c.run(request('/v2/device/thing'),op)).version,1);time=2001;assert.equal((await c.run(request('/v2/device/thing'),op)).version,2);
});
test('shared IP pacing applies per interface and commands overtake queued reads',async()=>{
 let time=0,serial=0;const timers=new Map(),starts=[];
 const c=create({now:()=>time,setTimer:(fn,delay)=>{timers.set(++serial,{fn,due:time+delay});return serial;},clearTimer:id=>timers.delete(id)});
 const advance=async target=>{for(;;){const due=[...timers].filter(([,v])=>v.due<=target).sort((a,b)=>a[1].due-b[1].due)[0];if(!due)break;time=due[1].due;timers.delete(due[0]);due[1].fn();await Promise.resolve();}time=target;await Promise.resolve();};
 const op=name=>async()=>{starts.push([name,time]);return {};};
 const a=c.run(request('/v2/device/thing','alice'),op('read-a'));await Promise.resolve();
 const b=c.run(request('/v2/device/thing','bob'),op('read-b'));
 const command=c.run(request('/v2/device/thing/status','alice',{state:'on'}),op('command'));
 await advance(550);await advance(1100);await Promise.all([a,b,command]);
 assert.deepEqual(starts,[['read-a',0],['command',550],['read-b',1100]]);
});
test('browser cooldown is per plancia and endpoint, and expires at the advertised time',()=>{
 let time=0;const b=require('../request-backoff.js')(()=>time);b.block('san-siro','/api/devices',60000);
 assert.equal(b.wait('san-siro','/api/devices'),60000);assert.equal(b.wait('san-luigi','/api/devices'),0);assert.equal(b.wait('san-siro','/api/toggle'),0);
 time=15000;b.block('san-siro','/api/devices',1000);assert.equal(b.wait('san-siro','/api/devices'),45000);assert.equal(b.error('san-siro','/api/devices').status,429);time=60001;assert.equal(b.wait('san-siro','/api/devices'),0);
});

test('scheduled reads bypass the short display cache and refresh it for other clients',async()=>{
 const c=quick();let reads=0;const op=async()=>({version:++reads});const args=request('/v2/device/thing');
 assert.equal((await c.run(args,op)).version,1);
 assert.equal((await c.run({...args,fresh:true},op)).version,2);
 assert.equal((await c.run(args,op)).version,2);assert.equal(reads,2);
});
