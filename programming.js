'use strict';
const crypto=require('crypto');
const core=require('./programming-core');
module.exports=function createProgramming({db,api,listDevices,appid,secret,saveSession,now=Date.now}){
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const encryptionKey=crypto.hkdfSync('sha256',Buffer.from(secret),Buffer.from(appid),Buffer.from('ewelink-programming-token-v1'),32);
 const accounts=()=>db().collection('ewelinkProgrammingAccounts'), schedules=()=>db().collection('ewelinkProgrammingSchedules'), aliases=()=>db().collection('ewelinkProgrammingSessions');
 const error=(status,code,msg)=>Object.assign(new Error(msg),{status,code});
 function seal(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv);const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return {v:1,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')};}
 function open(box){const c=crypto.createDecipheriv('aes-256-gcm',encryptionKey,Buffer.from(box.iv,'base64'));c.setAuthTag(Buffer.from(box.tag,'base64'));return JSON.parse(Buffer.concat([c.update(Buffer.from(box.data,'base64')),c.final()]).toString('utf8'));}
 function tokens(cookies){return {accessToken:cookies.ewelink_access,refreshToken:cookies.ewelink_refresh,atExpiredTime:Number(cookies.ewelink_expires)||now()+30*core.DAY,rtExpiredTime:now()+60*core.DAY};}
 const browserCookie={httpOnly:true,secure:true,sameSite:'Lax',path:'/'};
 function browserRef(session){return aliases().doc(hash(appid+':browser:'+session));}
 function automatic(data){return !!data?.credentials&&!data.revoked&&(data.automationEnabled===true||data.automationEnabled===undefined);}
 function applyCredentials(req,data){
  req.cookies.ewelink_access=data.accessToken;req.cookies.ewelink_refresh=data.refreshToken;req.cookies.ewelink_expires=String(data.atExpiredTime);
 }
 function aliasRef(rt){return aliases().doc(hash(appid+':'+rt));}
 async function restoreSession(req,res){
  const session=req.cookies.ewelink_session;
  if(session){
   if(!/^[a-f0-9]{64}$/.test(session))throw error(401,'not_authenticated','Accesso al dispositivo non valido. Accedi nuovamente.');
   const link=await browserRef(session).get();
   if(!link.exists||link.data().kind!=='browser'||link.data().validUntil<=now()){
    res.clearCookie('ewelink_session',browserCookie);
    throw error(401,'not_authenticated','Accesso a questo dispositivo scaduto. Accedi nuovamente.');
   }
   const owner=link.data().owner;req.programmingOwner=owner;req.browserSession=session;
   const data=await access(owner);
   applyCredentials(req,data);return true;
  }
  if(!req.cookies.ewelink_refresh)return false;
  const link=await aliasRef(req.cookies.ewelink_refresh).get();
  if(!link.exists||link.data().validUntil<=now())return false;
  const owner=link.data().owner,doc=await accounts().doc(owner).get();
  if(!doc.exists||doc.data().revoked||!doc.data().credentials||link.data().generation!==doc.data().generation)return false;
  req.programmingOwner=owner;
  const data=open(doc.data().credentials);
  if(data.rtExpiredTime<=now())return false;
  // Lascia il rinnovo al worker con blocco persistente: nessuna rotazione concorrente.
  if(data.atExpiredTime<=now()+60000){const fresh=await access(owner);saveSession(req,res,fresh);return true;}
  saveSession(req,res,data);return true;
 }
 const identityCache=new Map();
 async function identity(req){
  if(req.programmingOwner)return req.programmingOwner;
  const accessToken=req.cookies.ewelink_access,key=hash(accessToken||'');
  const cached=identityCache.get(key);if(cached&&cached.until>now())return cached.owner;
  const response=await api('/v2/user/profile',accessToken);
  const uid=response.data?.user?.apikey;
  if(typeof uid!=='string'||!uid)throw error(401,'not_authenticated','Impossibile verificare l’identità eWeLink. Accedi nuovamente.');
  const owner=hash(appid+':'+String(response.data.region||'eu')+':'+uid);
  for(const[k,v]of identityCache)if(v.until<now())identityCache.delete(k);
  identityCache.set(key,{owner,until:now()+5*60000});req.programmingOwner=owner;return owner;
 }
 async function remember(req,{browserLogin=false}={}){
  const owner=await identity(req),credentials=tokens(req.cookies);
  if(!credentials.accessToken||!credentials.refreshToken)throw error(401,'not_authenticated','Accedi nuovamente a eWeLink per attivare i timer.');
  const ref=accounts().doc(owner);
  await db().runTransaction(async t=>{
   const snap=await t.get(ref),data=snap.exists?snap.data():{};
   if(!browserLogin&&data.refreshUntil>now())throw error(409,'refresh_busy','Rinnovo dell’accesso in corso. Riprova tra poco.');
   const previous=data.credentials?open(data.credentials):null;
   const same=previous?.refreshToken===credentials.refreshToken;
   if(same)credentials.rtExpiredTime=previous.rtExpiredTime;
   const generation=!browserLogin&&same&&data.generation?data.generation:crypto.randomUUID();
   t.set(ref,{...data,generation,credentials:seal(credentials),renewAt:credentials.atExpiredTime-5*60000,revoked:false,reauthRequired:false,
    automationEnabled:browserLogin?automatic(data):true,
    browserUntil:browserLogin?Math.max(data.browserUntil||0,now()+60*core.DAY):(data.browserUntil||0),
    ...(browserLogin?{refreshClaim:null,refreshUntil:0}:{}),lastError:null,updatedAt:now()});
   t.set(aliasRef(credentials.refreshToken),{owner,generation,validUntil:credentials.rtExpiredTime});
  });
  return owner;
 }
 async function connectBrowser(req,res){
  // Il profilo del nuovo token verifica l'account: non usare un owner fornito dal client.
  delete req.programmingOwner;
  const owner=await remember(req,{browserLogin:true});
  const session=crypto.randomBytes(32).toString('hex'),validUntil=now()+60*core.DAY;
  await browserRef(session).set({kind:'browser',owner,validUntil,createdAt:now()});
  if(/^[a-f0-9]{64}$/.test(req.cookies.ewelink_session||''))await browserRef(req.cookies.ewelink_session).delete();
  res.cookie('ewelink_session',session,{...browserCookie,maxAge:validUntil-now()});
  for(const name of ['ewelink_access','ewelink_refresh','ewelink_expires'])res.clearCookie(name,browserCookie);
  req.cookies.ewelink_session=session;req.browserSession=session;req.programmingOwner=owner;
 }
 async function logoutBrowser(req){
  const session=req.cookies.ewelink_session;
  if(!/^[a-f0-9]{64}$/.test(session||''))return;
  const ref=browserRef(session),link=await ref.get();if(!link.exists)return;
  const owner=link.data().owner;
  await ref.delete();
  // Non revoca l'autorizzazione dell'account: appartiene anche agli altri browser e ai timer.
 }
 async function markAuthenticationRequired(req){
  if(!req.programmingOwner)return;
  const ref=accounts().doc(req.programmingOwner),used=req.cookies.ewelink_access;
  await db().runTransaction(async t=>{const snap=await t.get(ref),data=snap.data();
   if(data?.credentials&&open(data.credentials).accessToken===used)t.set(ref,{...data,reauthRequired:true,renewAt:core.NEVER,lastError:'Ricollega eWeLink da un dispositivo: il collegamento verrà aggiornato anche sugli altri.'});
  });
 }
 async function access(owner,{scheduled=false}={}){
  const ref=accounts().doc(owner),claim=crypto.randomUUID();
  const result=await db().runTransaction(async t=>{
   const snap=await t.get(ref),data=snap.exists?snap.data():{};
   if(data.reauthRequired)throw error(401,'not_authenticated','Ricollega eWeLink da questo dispositivo per aggiornare anche gli altri.');
   if(scheduled&&!automatic(data))throw error(401,'automation_disabled','Esecuzione automatica disattivata.');
   if(!automatic(data)&&(data.browserUntil||0)<=now()&&data.automationEnabled===false)throw error(401,'not_authenticated','Accesso della plancia scaduto. Accedi nuovamente.');
   if(data.revoked||!data.credentials)throw error(401,'not_authenticated','Ricollega eWeLink nella sezione Programmazione.');
   const credentials=open(data.credentials);
   if(credentials.atExpiredTime>now()+5*60000)return {credentials};
   if(data.refreshUntil>now())throw error(409,'refresh_busy','Rinnovo dell’accesso in corso.');
   if(credentials.rtExpiredTime<=now())throw error(401,'not_authenticated','Autorizzazione dei timer scaduta. Ricollega eWeLink.');
   t.set(ref,{...data,refreshClaim:claim,refreshUntil:now()+120000});return {credentials,refresh:true};
  });
  if(!result.refresh)return result.credentials;
  try{
   const body={rt:result.credentials.refreshToken};
   const response=await api('/v2/user/refresh',null,body,'Sign '+crypto.createHmac('sha256',secret).update(JSON.stringify(body)).digest('base64'));
   if(!response.data?.at||!response.data?.rt)throw error(502,'refresh_failed','Rinnovo eWeLink non valido.');
   const c={accessToken:response.data.at,refreshToken:response.data.rt,atExpiredTime:Number(response.data.atExpiredTime)||now()+30*core.DAY,rtExpiredTime:Number(response.data.rtExpiredTime)||now()+60*core.DAY};
   await db().runTransaction(async t=>{const snap=await t.get(ref),data=snap.data();if(data.refreshClaim!==claim)throw error(409,'refresh_lost','Rinnovo non confermato.');t.set(ref,{...data,credentials:seal(c),renewAt:c.atExpiredTime-5*60000,refreshUntil:0,lastError:null,updatedAt:now()});t.set(aliasRef(c.refreshToken),{owner,generation:data.generation,validUntil:c.rtExpiredTime});});return c;
  }catch(e){await db().runTransaction(async t=>{const snap=await t.get(ref),data=snap.data();if(data?.refreshClaim===claim)t.set(ref,{...data,refreshUntil:0,...(e.status===401?{reauthRequired:true}:{}),renewAt:e.status===401?core.NEVER:now()+5*60000,lastError:e.status===401?'Ricollega l’account eWeLink per i timer.':'Rinnovo temporaneamente non disponibile. Nuovo tentativo tra 5 minuti.'});});throw e;}
 }
 async function owned(owner){const snap=await schedules().where('owner','==',owner).get();return snap.docs.map(d=>({...d.data(),id:d.id}));}
 function visible(s){const {owner,...result}=s; if(result.last?.status==='claimed'&&result.last.until<now())result.last={...result.last,status:'unknown',message:'Server riavviato: esito da verificare. Nessun reinvio automatico.'};return result;}
 async function list(req){const owner=await identity(req),account=await accounts().doc(owner).get();return {ok:true,accountId:owner,timeZone:core.ZONE,connected:account.exists&&automatic(account.data()),connectionError:account.data()?.lastError||null,schedules:(await owned(owner)).map(visible).sort((a,b)=>a.nextAt-b.nextAt)};}
 async function mutate(req){
  const owner=await identity(req),op=req.body?.op;
  if(op==='connect'){if(req.body.authorize!==true)throw error(400,'consent_required','Consenti l’esecuzione dei timer a webapp chiusa.');await remember(req);return list(req);}
  if(op==='disconnect'){
   const records=await owned(owner);for(const s of records){const ref=schedules().doc(s.id);await db().runTransaction(async t=>{const doc=await t.get(ref);if(doc.data()?.last?.status==='claimed'&&doc.data().last.until>now())throw error(409,'schedule_busy','Un comando programmato è già in corso.');t.set(ref,{...doc.data(),enabled:false,nextAt:core.NEVER,version:doc.data().version+1});});}
   const ref=accounts().doc(owner);
   await db().runTransaction(async t=>{
    const doc=await t.get(ref),data=doc.data()||{},keepBrowser=(data.browserUntil||0)>now();
    t.set(ref,{...data,automationEnabled:false,...(!keepBrowser?{revoked:true,credentials:null,renewAt:core.NEVER}:{}),lastError:null,updatedAt:now()});
   });return list(req);
  }
  const id=req.body?.id||crypto.randomUUID();if(typeof id!=='string'||!/^[\w-]{1,100}$/.test(id))throw error(400,'invalid_id','Programmazione non valida.');
  const ref=schedules().doc(id),records=await owned(owner);
  let clean=null;
  if(op==='save'){
   const devices=await listDevices(req.cookies.ewelink_access),device=devices.find(d=>d.deviceid===req.body.schedule?.deviceId);
   clean=core.validate(req.body.schedule,device,now());
   if(records.length>=100&&!records.some(s=>s.id===id))throw error(400,'limit','Puoi salvare fino a 100 programmazioni.');
   const account=await accounts().doc(owner).get();
   if((!account.exists||!automatic(account.data()))&&req.body.authorize!==true)throw error(400,'consent_required','Consenti l’esecuzione dei timer a webapp chiusa.');
   await remember(req);
  }else if(!['delete','toggle'].includes(op))throw error(400,'invalid_operation','Operazione non valida.');
  if(op==='toggle' && records.some(s=>s.id===id&&!s.enabled)){
   const account=await accounts().doc(owner).get();
   if(!account.exists||!automatic(account.data()))throw error(400,'consent_required','Apri Modifica e consenti di nuovo l’esecuzione dei timer.');
  }
  await db().runTransaction(async t=>{
   const snap=await t.get(ref),old=snap.exists?snap.data():null;
   if(old&&old.owner!==owner)throw error(404,'not_found','Programmazione non trovata.');
   if(old&&old.version!==req.body.expectedVersion)throw error(409,'version_conflict','Programmazione modificata su un altro dispositivo. Aggiorna l’elenco.');
   if(!old&&op!=='save')throw error(404,'not_found','Programmazione non trovata.');
   if(old?.last?.status==='claimed'&&old.last.until>now())throw error(409,'schedule_busy','Un comando è già in corso. Attendi il suo esito.');
   if(op==='delete'){t.delete(ref);return;}
   const next={...(old||{}),...(clean||{}),owner,version:(old?.version||0)+1,updatedAt:now(),createdAt:old?.createdAt||now()};
   if(op==='toggle')next.enabled=!old.enabled;
   next.nextAt=core.nextEvent(next,now())?.at||core.NEVER;
   if(next.enabled&&next.nextAt===core.NEVER)throw error(400,'schedule_past','Gli orari sono già trascorsi. Modifica la programmazione.');
   t.set(ref,next);
  });return list(req);
 }
 async function execute(ref){
  const claimed=await db().runTransaction(async t=>{
   const snap=await t.get(ref),s=snap.exists?{...snap.data(),id:ref.id}:null;
   if(!s||!s.enabled||s.nextAt>now()||s.last?.until>now()&&s.last.status==='claimed')return null;
   const claim=crypto.randomUUID(),time=now();
   // Avanza prima dell'invio: dopo un arresto non ripete un impulso già tentato.
   const nextAt=core.nextEvent(s,time)?.at||core.NEVER;
   t.set(ref,{...s,nextAt,last:{id:claim,status:'claimed',at:time,scheduledAt:s.nextAt,until:time+180000,message:'Comando in esecuzione.'}});return {s,claim,time};
  });if(!claimed)return;
  const {s,claim,time}=claimed;let status='skipped',message='Nessun comando da inviare.';
  try{
   const all=await owned(s.owner),p=core.plan(s,all,time);
   message=p.reason;
   if(p.event&&p.outlets.length){
    const credentials=await access(s.owner,{scheduled:true}),devices=await listDevices(credentials.accessToken),device=devices.find(d=>d.deviceid===s.deviceId);
    if(!device?.online)throw new Error('Dispositivo offline o non più autorizzato. Nessun reinvio automatico.');
    if(s.kind==='multi'&&p.outlets.some(o=>!device.params.switches?.some(c=>c.outlet===o)))throw new Error('I canali del dispositivo sono cambiati. Controlla la programmazione.');
    const params=s.kind==='multi'?{switches:p.outlets.map(outlet=>({outlet,switch:p.event.state}))}:{switch:p.event.state};
    await api('/v2/device/thing/status',credentials.accessToken,{type:1,id:s.deviceId,params});status='succeeded';message=p.event.pulse?'Impulso accettato da eWeLink.':(p.event.state==='on'?'Accensione':'Spegnimento')+' accettato da eWeLink.';
   }
  }catch(e){status='unknown';message=e.status===401?'Accesso scaduto: ricollega eWeLink.':String(e.message||'Esito non confermato.').slice(0,250);}
  await db().runTransaction(async t=>{const snap=await t.get(ref),data=snap.data();if(data?.last?.id===claim)t.set(ref,{...data,last:{...data.last,status,message,finishedAt:now(),until:0}});});
 }
 let busy=false,timer=null;
 async function tick(){
  if(busy)return;busy=true;
  try{
   const due=await schedules().where('nextAt','<=',now()).limit(20).get();for(const doc of due.docs)await execute(doc.ref);
   // Mantiene valida l'autorizzazione anche per prenotazioni lontane nel tempo.
   const renewals=await accounts().where('renewAt','<=',now()).limit(5).get();
   for(const doc of renewals.docs){
    const data=doc.data();
    if(!data.revoked&&(automatic(data)||(data.browserUntil||0)>now()))await access(doc.id).catch(()=>{});
    else if(!automatic(data))await accounts().doc(doc.id).set({credentials:null,revoked:true,renewAt:core.NEVER},{merge:true});
   }
  }finally{busy=false;}
 }
 function start(){if(timer)return;timer=setInterval(()=>{void tick().catch(()=>console.error('Controllo programmazioni non riuscito.'));},30000);timer.unref?.();void tick().catch(()=>console.error('Avvio programmazioni non riuscito.'));}
 return {list,mutate,identity,restoreSession,connectBrowser,logoutBrowser,markAuthenticationRequired,remember,access,start,tick,seal,open,stop(){if(timer)clearInterval(timer);timer=null;}};
};
