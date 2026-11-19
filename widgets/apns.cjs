'use strict';
const crypto=require('node:crypto'),http2=require('node:http2');
module.exports=function createAPNs({teamId,keyId,privateKey,topic,production=true,now=Date.now}){
 let jwt='',until=0;
 function authorization(){
  if(jwt&&now()<until)return jwt;
  const h=Buffer.from(JSON.stringify({alg:'ES256',kid:keyId})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:teamId,iat:Math.floor(now()/1000)})).toString('base64url');
  jwt=h+'.'+p+'.'+crypto.sign('sha256',Buffer.from(h+'.'+p),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');until=now()+45*60000;return jwt;
 }
 return {configured:!!(teamId&&keyId&&privateKey&&topic),async invalidate(sub){
  if(!this.configured)throw new Error('apns_not_configured');
  if(sub.transport!=='apns'||!/^[a-f0-9]{32,512}$/i.test(sub.token))throw new Error('invalid_push_token');
  await new Promise((resolve,reject)=>{
   const connection=http2.connect(production?'https://api.push.apple.com':'https://api.sandbox.push.apple.com');
   const done=error=>{connection.close();error?reject(error):resolve();};connection.on('error',done);
   const req=connection.request({':method':'POST',':path':'/3/device/'+sub.token,authorization:'bearer '+authorization(),'apns-push-type':'widgets','apns-topic':topic,'apns-priority':'5','apns-expiration':'0','apns-collapse-id':'pace-widget-state'});
   let status=0;req.on('response',headers=>{status=Number(headers[':status']);});req.on('data',()=>{});req.on('error',done);req.setTimeout(10000,()=>{req.close();done(new Error('apns_timeout'));});
   req.on('end',()=>done(status===200?null:Object.assign(new Error('apns_rejected'),{status})));req.end(JSON.stringify({aps:{'content-changed':true}}));
  });
 }};
};
