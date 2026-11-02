// Identità della webapp, separate dai token eWeLink. Nessuna password sul server.
'use strict';
const crypto=require('crypto');
module.exports=function createAccounts({db,auth,secret,appid,adminEmail,origin,webConfig,programming,now=Date.now}){
 const COOKIE='ewelink_app',ACT='ewelink_actas',DAY=86400000;
 const opts={httpOnly:true,secure:true,sameSite:'lax',path:'/'};
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const mac=s=>crypto.createHmac('sha256',secret).update('app-accounts:'+s).digest('hex');
 const fail=(status,code,msg)=>Object.assign(new Error(msg),{status,code});
 const profiles=()=>db().collection('ewelinkAppAccounts');
 const links=()=>db().collection('ewelinkAppProviderLinks');
 const adminRef=()=>db().collection('ewelinkAppSettings').doc('administrator');
 const accountId=email=>hash(appid+':account:'+email.toLowerCase().trim());
 const publicProfile=a=>({id:a.id,name:a.name,email:a.email,status:a.status,role:a.role||'user',linked:!!a.providerOwner});
 function originCheck(req){if(req.headers?.origin!==origin)throw fail(403,'app_origin','Richiesta non autorizzata: riapri la plancia dal suo indirizzo ufficiale.');}
 function csrf(req){originCheck(req);const expected=mac(req.cookies?.[COOKIE]||'');const supplied=req.headers?.['x-app-csrf']||'';if(supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw fail(403,'app_csrf','Sessione aggiornata. Ricarica la pagina prima di riprovare.');}
 function desktop(req){return !/Mobile|Android|iPhone|iPad|Tablet/i.test(req.headers?.['user-agent']||'');}
 async function read(id){if(!/^[a-f0-9]{64}$/.test(id||''))throw fail(400,'app_account','Account non valido.');const s=await profiles().doc(id).get();if(!s.exists)throw fail(404,'app_account','Account non trovato.');return {...s.data(),id};}
 async function audit(actor,action,target){await db().collection('ewelinkAppAudit').doc(crypto.randomBytes(16).toString('hex')).set({actor:actor.uid,action,target,at:now()});}
 async function isAdmin(actor){const s=await adminRef().get();return actor.role==='admin'&&s.data()?.uid===actor.uid;}
 async function session(req,{active=true,allowActAs=true}={}){
  let decoded;try{decoded=await auth().verifySessionCookie(req.cookies?.[COOKIE]||'',true);}catch{throw fail(401,'app_auth_required','Accedi con il tuo account della webapp.');}
  const actor=await read(accountId(decoded.email||''));
  if(actor.uid!==decoded.uid||decoded.email_verified!==true)throw fail(401,'app_auth_required','Identità dell’account non confermata.');
  if(actor.status==='blocked'||actor.status==='deleted')throw fail(403,'app_blocked','Account sospeso o rimosso. Contatta l’amministratore.');
  if(Number(decoded.auth_time)*1000<Number(actor.invalidBefore||0))throw fail(401,'app_auth_required','Accesso revocato: accedi nuovamente.');
  req.appActor=actor;req.appAccount=actor;
  if(allowActAs&&req.cookies?.[ACT]){
   const id=req.cookies[ACT];if(!/^[a-f0-9]{64}$/.test(id))throw fail(401,'app_actas_expired','Accesso alla plancia utente scaduto.');
   const s=await db().collection('ewelinkAppDelegations').doc(hash(id)).get(),d=s.data();
   if(!d||d.actor!==actor.uid||d.until<=now()||!await isAdmin(actor)||!desktop(req))throw fail(401,'app_actas_expired','Accesso amministratore scaduto. Torna alla gestione account.');
   req.appAccount=await read(d.target);req.appImpersonating=true;req.appReadOnly=req.appAccount.status!=='active';
  }
  if(req.query?.accountContext&&req.query.accountContext!==req.appAccount.id)throw fail(409,'app_context_changed','La plancia aperta è cambiata. Ricarica la pagina.');
  if(active&&req.appAccount.status!=='active'&&!req.appImpersonating)throw fail(403,'app_pending','Account in attesa di ammissione da parte dell’amministratore.');
  return req.appAccount;
 }
 async function admin(req){await session(req,{allowActAs:false});if(!desktop(req))throw fail(403,'app_desktop','La gestione account è disponibile da computer.');if(!await isAdmin(req.appActor))throw fail(403,'app_forbidden','Accesso riservato all’amministratore.');return req.appActor;}
 async function identify(token){
  const d=await auth().verifyIdToken(token,true);
  if(d.email_verified!==true||!d.email)throw fail(403,'app_verify_email','Conferma la tua email prima di accedere.');
  if(!Number.isFinite(d.auth_time)||now()/1000-d.auth_time>300||d.auth_time>now()/1000+60)throw fail(401,'app_recent_login','Accedi nuovamente per confermare l’identità.');
  const email=d.email.trim().toLowerCase(),id=accountId(email),ref=profiles().doc(id),ar=adminRef();
  const profile=await db().runTransaction(async t=>{
   const s=await t.get(ref),a=s.data(),root=await t.get(ar);
   if(a?.uid&&a.uid!==d.uid)throw fail(409,'app_identity_conflict','Questa email è già associata a un’altra identità. Contatta l’amministratore.');
   if(['blocked','deleted'].includes(a?.status))throw fail(403,'app_blocked','Account sospeso o rimosso. Contatta l’amministratore.');
   const bootstrap=email===adminEmail&&(!root.exists||root.data().uid===d.uid);
   if(email===adminEmail&&root.exists&&root.data().uid!==d.uid)throw fail(403,'app_admin_identity','Identità amministratore non corrispondente.');
   const next={...(a||{}),email,uid:d.uid,name:a?.name||d.name||email.split('@')[0],status:bootstrap?'active':a?.status||'pending',role:bootstrap?'admin':'user',createdAt:a?.createdAt||now(),updatedAt:now()};
   t.set(ref,next);if(bootstrap&&!root.exists)t.set(ar,{uid:d.uid,email,createdAt:now()});return {...next,id};
  });
  return profile;
 }
 const loginAttempts=new Map();
 async function login(req,res){
  originCheck(req);
  const address=req.ip||req.socket?.remoteAddress||'unknown',time=now();
  for(const [key,v]of loginAttempts)if(v.until<=time)loginAttempts.delete(key);
  const attempt=loginAttempts.get(address)||{count:0,until:time+600000};
  if(++attempt.count>30)throw fail(429,'app_rate_limit','Troppi tentativi di accesso. Attendi qualche minuto.');
  loginAttempts.set(address,attempt);if(typeof req.body?.idToken!=='string'||req.body.idToken.length>20000)throw fail(400,'app_token','Accesso non valido.');
  const a=await identify(req.body.idToken),remember=req.body.remember===true,expiresIn=remember?14*DAY:12*3600000;
  const cookie=await auth().createSessionCookie(req.body.idToken,{expiresIn});
  res.cookie(COOKIE,cookie,{...opts,...(remember?{maxAge:expiresIn}:{})});res.clearCookie(ACT,opts);
  // Solo il proprietario originale può adottare la sessione eWeLink precedente.
  if(a.role==='admin'&&!a.providerOwner){
   try{const old={cookies:{...req.cookies}};await programming().restoreSession(old,res);if(old.programmingOwner)await bind(a,old.programmingOwner);}
   catch(error){if(!['not_authenticated','app_provider_taken'].includes(error.code))throw error;}
  }
  return {ok:true,account:publicProfile(await read(a.id))};
 }
 async function status(req){const a=await session(req,{active:false});return {ok:true,account:publicProfile(a),actor:publicProfile(req.appActor),impersonating:!!req.appImpersonating,readOnly:!!req.appReadOnly,adminDesktop:desktop(req)&&await isAdmin(req.appActor),csrf:mac(req.cookies[COOKIE])};}
 async function bind(a,owner){
  const pr=profiles().doc(a.id),lr=links().doc(owner);
  await db().runTransaction(async t=>{
   const p=await t.get(pr),l=await t.get(lr),current=p.data();
   if(current?.status!=='active')throw fail(403,'app_blocked','Account non attivo.');
   if(l.exists&&l.data().accountId!==a.id)throw fail(409,'app_provider_taken','Questo account eWeLink è già collegato a un’altra plancia.');
   if(current.providerOwner&&current.providerOwner!==owner)throw fail(409,'app_provider_changed','La plancia è già collegata a un altro account eWeLink. Contatta l’amministratore.');
   t.set(lr,{accountId:a.id,updatedAt:now()});t.set(pr,{providerOwner:owner,updatedAt:now()},{merge:true});
  });
 }
 async function providerAccount(owner){const s=await links().doc(owner).get();return s.exists?read(s.data().accountId):null;}
 async function authorizeOwner(owner){const a=await providerAccount(owner);if(a&&a.status!=='active')throw fail(403,'app_blocked','Account sospeso: comandi automatici bloccati.');return a;}
 async function provider(req){
  const a=await session(req);
  const expected=req.headers?.['x-app-account']||req.query?.accountContext;
  if((expected&&expected!==a.id)||(!['GET','HEAD'].includes(req.method)&&expected!==a.id))throw fail(409,'app_context_changed','La plancia aperta è cambiata. Ricarica la pagina prima di inviare comandi.');
  if(req.method!=='GET'&&req.method!=='HEAD'){csrf(req);if(req.appReadOnly)throw fail(403,'app_readonly','Questa plancia è consultabile soltanto: account non attivo.');}
  if(!a.providerOwner)throw fail(401,'not_authenticated','Collega eWeLink per la prima volta dalla tua plancia.');
  const c=await programming().access(a.providerOwner,{inspection:req.appImpersonating===true&&req.appReadOnly===true});req.programmingOwner=a.providerOwner;req.programmingChecked=true;
  req.cookies={...req.cookies,ewelink_access:c.accessToken,ewelink_refresh:c.refreshToken,ewelink_expires:String(c.atExpiredTime)};
 }
 async function tokenAllowed(token){const owner=await programming().identity({cookies:{ewelink_access:token}});await authorizeOwner(owner);}
 function sealPending(data){const payload=Buffer.from(JSON.stringify(data)).toString('base64url');return payload+'.'+mac(payload);}
 function openPending(value){const [p,m]=String(value||'').split('.');if(!p||!m||m.length!==64||!crypto.timingSafeEqual(Buffer.from(mac(p)),Buffer.from(m)))return null;try{return JSON.parse(Buffer.from(p,'base64url'));}catch{return null;}}
 async function context(req,home,legacyRef){
  let a=req.appAccount;if(!a){const owner=await programming().identity(req);a=await authorizeOwner(owner);}
  if(!a)return legacyRef;
  const ref=db().collection('sanLuigiScenarioWorkspaces').doc(hash(appid+':app:'+a.id+':'+home.id));
  // Migrazione non distruttiva, esclusivamente della plancia dell’amministratore.
  if(a.role==='admin')await db().runTransaction(async t=>{const dest=await t.get(ref),old=await t.get(legacyRef);if(!dest.exists&&old.exists){const data=old.data();if(Object.values(data.executions||{}).some(r=>r.status==='running'&&r.expiresAt>now()))throw fail(409,'app_migration_busy','Attendi la fine del comando prima di aprire la nuova plancia.');t.set(ref,{...data,migratedFrom:legacyRef.id,migratedAt:now()});}});
  return ref;
 }
 async function manage(req,res){
  const actor=await admin(req);
  if(req.method==='GET'){const rows=await profiles().get();return {ok:true,accounts:rows.docs.map(s=>publicProfile({...s.data(),id:s.id})).sort((a,b)=>a.name.localeCompare(b.name))};}
  csrf(req);const b=req.body||{};
  if(b.op==='stop-view'){res.clearCookie(ACT,opts);await audit(actor,'stop-view',actor.id);return {ok:true};}
  if(b.op==='invite'){
   const email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!name||name.length>80)throw fail(400,'app_invite','Inserisci un nome (massimo 80 caratteri) e un indirizzo email valido.');
   const id=accountId(email),ref=profiles().doc(id);
   await db().runTransaction(async t=>{const s=await t.get(ref);if(s.exists)throw fail(409,'app_exists','Account già presente: usa Ammetti o Riattiva.');t.set(ref,{email,name,status:'active',role:'user',createdAt:now(),updatedAt:now()});});await audit(actor,'invite',id);return {ok:true};
  }
  const a=await read(b.id);
  if(b.op==='enter'){
   const id=crypto.randomBytes(32).toString('hex');await db().collection('ewelinkAppDelegations').doc(hash(id)).set({actor:actor.uid,target:a.id,until:now()+3600000});
   res.cookie(ACT,id,{...opts,maxAge:3600000});await audit(actor,'enter',a.id);return {ok:true};
  }
  if(a.id===actor.id&&['block','delete'].includes(b.op))throw fail(400,'app_self','Non puoi bloccare o rimuovere l’unico amministratore.');
  if(b.op==='rename'){
   const name=String(b.name||'').trim();if(!name||name.length>80)throw fail(400,'app_name','Inserisci un nome tra 1 e 80 caratteri.');await profiles().doc(a.id).set({name,updatedAt:now()},{merge:true});
  }else if(['approve','block','delete'].includes(b.op)){
   const status={approve:'active',block:'blocked',delete:'deleted'}[b.op];
   // La revoca applicativa è efficace anche se Firebase non risponde.
   await profiles().doc(a.id).set({status,updatedAt:now(),...(['block','delete'].includes(b.op)?{invalidBefore:now()}: {})},{merge:true});
   if(a.uid&&status!=='active')await auth().revokeRefreshTokens(a.uid);
  }else throw fail(400,'app_operation','Operazione account non valida.');
  await audit(actor,b.op,a.id);return {ok:true};
 }
 function install(app,wrap){
  app.get('/api/app/config',(_req,res)=>res.json({ok:true,enabled:true,firebase:webConfig}));
  app.get('/api/app/session',wrap(async(req,res)=>{try{res.json(await status(req));}catch(e){if(e.code==='app_actas_expired')res.clearCookie(ACT,opts);throw e;}}));
  app.post('/api/app/login',wrap(async(req,res)=>res.json(await login(req,res))));
  app.post('/api/app/logout',wrap(async(req,res)=>{csrf(req);res.clearCookie(COOKIE,opts);res.clearCookie(ACT,opts);res.json({ok:true});}));
  app.get('/api/app/accounts',wrap(async(req,res)=>res.json(await manage(req,res))));
  app.post('/api/app/accounts',wrap(async(req,res)=>res.json(await manage(req,res))));
 }
 return {install,session,provider,bind,context,authorizeOwner,tokenAllowed,sealPending,openPending,csrf,publicProfile,providerAccount,accountId};
};
