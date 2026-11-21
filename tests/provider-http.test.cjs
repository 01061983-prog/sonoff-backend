'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{spawn}=require('node:child_process'),path=require('node:path');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('real device route coalesces a burst and returns a cooldown without logging the user out',{timeout:20000},async()=>{
 let familyCalls=0,deviceCalls=0;const upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/v2/family'){familyCalls++;res.end(JSON.stringify({error:0,data:{familyList:[{id:'fixture-home'}]}}));}else if(req.url.startsWith('/v2/device/thing?')){deviceCalls++;res.end(JSON.stringify({error:406,msg:'invoke too much:fictional-appid'}));}else{res.statusCode=404;res.end('{}');}});
 const upstreamPort=await listen(upstream),reservation=http.createServer();const port=await listen(reservation);await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{PATH:process.env.PATH,PORT:String(port),EWELINK_APP_ID:'fictional-test-app',EWELINK_APP_SECRET:'fictional-test-secret',EWELINK_API_BASE:'http://127.0.0.1:'+upstreamPort,EWELINK_APP_AUTH_ENABLED:'false',EWELINK_PROGRAMMING_ENABLED:'false',PACE_WIDGETS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 try{
  let started=false;for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(300)})).ok){started=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(started,output);
  const headers={Cookie:'ewelink_access=fictional-token; ewelink_expires='+String(Date.now()+3600000)};
  const responses=await Promise.all(Array.from({length:9},()=>fetch('http://127.0.0.1:'+port+'/api/devices',{headers})));
  for(const response of responses){assert.equal(response.status,429);assert.ok(Number(response.headers.get('retry-after'))>=59);assert.equal(response.headers.get('set-cookie'),null);const body=await response.json();assert.equal(body.error,'rate_limited');assert.ok(body.retryAfterMs>=59000);assert.ok(!body.msg.includes('fictional-appid'));}
  assert.equal(familyCalls,1);assert.equal(deviceCalls,1);
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/devices',{headers})).status,429);assert.equal(deviceCalls,1);
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/session',{headers})).status,200);
  const asset=await fetch('http://127.0.0.1:'+port+'/app/request-backoff.js?v=92');assert.equal(asset.status,200);assert.match(await asset.text(),/PaceRequestBackoff/);
 }finally{child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));await new Promise(resolve=>upstream.close(resolve));}
});
