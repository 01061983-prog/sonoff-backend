'use strict';
const crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const digest=s=>crypto.createHash('sha256').update(s).digest('base64url');
const bad=(status,code)=>Object.assign(new Error(code),{status,code});
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
module.exports=function createNativeAuth({db,accounts,firebaseAuth,secret,now=Date.now}){
 if(typeof secret!=='string'||!secret)throw new Error('Native authentication secret required');
 const signed=(kind,nonce)=>nonce+'.'+crypto.createHmac('sha256',secret).update('pace-widget-v1:'+kind+':'+nonce).digest('base64url');
 const valid=(kind,value)=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value)&&equal(value,signed(kind,value.slice(0,43)));
 const codes=()=>db().collection('paceWidgetCodes'),grants=()=>db().collection('paceWidgetGrants');
 const profiles=()=>db().collection('ewelinkAppAccounts');
 async function profile(id,uid){const s=await profiles().doc(id).get(),a=s.data();if(!s.exists||a.status!=='active'||a.uid!==uid)throw bad(403,'account_disabled');return {...a,id:s.id};}
 return {
  async pair(req,input){
   // Existing PACE session, verified identity, current active profile and same-origin CSRF.
   await accounts.session(req,{allowActAs:false});accounts.csrf(req);
   const actor=req.appActor;
   if(!actor||actor.status!=='active')throw bad(403,'account_disabled');
   if(!/^[A-Za-z0-9_-]{43}$/.test(input?.challenge||'')||!/^[A-Za-z0-9_-]{32,100}$/.test(input?.state||'')||!/^[A-Za-z0-9_-]{16,100}$/.test(input?.installationId||''))throw bad(400,'invalid_pairing');
   const code=signed('code',crypto.randomBytes(32).toString('base64url'));
   await codes().doc(hash(code)).create({actorId:actor.id,uid:actor.uid,challenge:input.challenge,state:input.state,installationId:input.installationId,issuedAt:now(),expiresAt:now()+120000,expireAt:new Date(now()+120000)});
   const url=new URL('pacewidgets://authorize');url.searchParams.set('code',code);url.searchParams.set('state',input.state);
   return {ok:true,callback:url.href};
  },
  async exchange(input){
   if(!valid('code',input?.code)||!/^[A-Za-z0-9._~-]{43,128}$/.test(input?.verifier||''))throw bad(400,'invalid_pairing');
   const ref=codes().doc(hash(input.code)),token=signed('token',crypto.randomBytes(32).toString('base64url')),grant=grants().doc(hash(token));
   await db().runTransaction(async tx=>{
    const c=await tx.get(ref),data=c.data();
    if(!c.exists||data.expiresAt<=now()||!equal(data.challenge,digest(input.verifier)))throw bad(401,'pairing_expired');
    const p=await tx.get(profiles().doc(data.actorId)),a=p.data();
    if(!p.exists||a.uid!==data.uid||a.status!=='active'||data.issuedAt<Number(a.invalidBefore||0))throw bad(403,'account_disabled');
    tx.delete(ref);tx.create(grant,{actorId:data.actorId,uid:data.uid,installationId:data.installationId,issuedAt:data.issuedAt,revoked:false,createdAt:now()});
   });
   return {ok:true,token};
  },
  async authenticate(token){
   if(!valid('token',token))throw bad(401,'login_required');
   const key=hash(token),s=await grants().doc(key).get(),g=s.data();
   if(!s.exists||g.revoked)throw bad(401,'login_required');
   // Auth disabling/revocation is authoritative too, even outside the PACE admin page.
   const user=await firebaseAuth().getUser(g.uid);
   if(user.disabled||Date.parse(user.tokensValidAfterTime||0)>g.issuedAt)throw bad(401,'login_required');
   const a=await profile(g.actorId,g.uid);
   if(g.issuedAt<Number(a.invalidBefore||0))throw bad(401,'login_required');
   return {id:a.id,uid:g.uid,authTime:g.issuedAt,grantId:key,installationId:g.installationId};
  },
  async revoke(token){
   const identity=await this.authenticate(token);
   await grants().doc(identity.grantId).update({revoked:true,revokedAt:now()});
   return {ok:true};
  }
 };
};
module.exports.hash=hash;
