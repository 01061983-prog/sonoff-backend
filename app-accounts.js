// Identità della webapp, separate dai token eWeLink. Nessuna password sul server.
'use strict';
const crypto=require('crypto');
module.exports=function createAccounts({db,auth,secret,appid,adminEmail,origin,webConfig,programming,now=Date.now}){
 const COOKIE='ewelink_app',ACT='ewelink_actas',PROVIDER='ewelink_provider',INTENT='ewelink_link_intent',DAY=86400000;
 const opts={httpOnly:true,secure:true,sameSite:'lax',path:'/'};
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const mac=s=>crypto.createHmac('sha256',secret).update('app-accounts:'+s).digest('hex');
 const fail=(status,code,msg)=>Object.assign(new Error(msg),{status,code});
 const profiles=()=>db().collection('ewelinkAppAccounts');
 const links=()=>db().collection('ewelinkAppProviderLinks');
 const adminRef=()=>db().collection('ewelinkAppSettings').doc('administrator');
 const accountId=email=>hash(appid+':account:'+email.toLowerCase().trim());
 const disabledMessage='Plancia disattivata. Contatta l’amministratore.';
 const needsSetup=a=>(a.role||'user')!=='admin'&&!a.providerOwner&&a.setupDone!==true;
 const publicProfile=a=>({id:a.id,name:a.name,person:a.person||'',email:a.email,status:a.status,role:a.role||'user',linked:!!a.providerOwner,logo:a.logo||'',needsSetup:needsSetup(a),registrationIncomplete:a.registrationIncomplete===true,...(typeof a.emailVerified==='boolean'?{emailVerified:a.emailVerified}:{})});
 function connections(a){
  const list=Array.isArray(a.providerConnections)?a.providerConnections.filter(c=>c&&typeof c.owner==='string'&&c.owner&&typeof c.label==='string'):[];
  if(a.providerOwner&&!list.some(c=>c.owner===a.providerOwner))list.unshift({owner:a.providerOwner,label:'Account principale',slot:''});
  return list;
 }
 function selectedConnection(req,a){
  const list=connections(a),saved=openPending(req.cookies?.[PROVIDER]);
  return (saved?.accountId===a.id&&list.find(c=>c.owner===saved.owner))||list.find(c=>c.owner===a.providerOwner)||list[0]||null;
 }
 async function selectConnection(req,res,owner){
  const a=await read(req.appAccount.id),c=connections(a).find(c=>c.owner===owner);
  if(!c)throw fail(403,'app_provider_forbidden','Questo account eWeLink non appartiene alla tua plancia.');
  res.cookie(PROVIDER,sealPending({accountId:a.id,owner}),{...opts,maxAge:365*DAY});return c;
 }
 function linkIntent(req){
  const d=openPending(req.cookies?.[INTENT]);
  if(!d)return null;
  if(d.accountId!==req.appAccount.id||d.uid!==req.appActor.uid||d.until<=now())throw fail(403,'app_oauth_account','Richiesta di collegamento scaduta. Riparti dalla tua plancia.');
  if(d.add){if(!/^[a-f0-9]{64}$/.test(d.slot||''))throw fail(400,'app_link','Collegamento non valido.');return d;}
  const c=connections(req.appAccount).find(c=>c.owner===d.owner);
  if(!c)throw fail(403,'app_provider_forbidden','Collegamento non disponibile.');return {...d,slot:c.slot||'',label:c.label};
 }
 async function manageProviders(req,res){
  const a=await session(req),list=connections(a),selected=selectedConnection(req,a);
  if(req.method==='GET')return {ok:true,selected:selected?.owner||'',impersonating:!!req.appImpersonating,connections:list.map(c=>({id:c.owner,label:c.label}))};
  csrf(req);if(req.appReadOnly)throw fail(403,'app_readonly','Plancia disponibile soltanto in consultazione.');
  const b=req.body||{};
  if(b.op==='select'){await selectConnection(req,res,b.id);return {ok:true};}
  if(req.appImpersonating)throw fail(403,'app_link_owner','Solo il titolare può collegare o modificare i propri account eWeLink.');
  if(b.op==='rename'){
   const label=String(b.label||'').trim();if(!label||label.length>80)throw fail(400,'app_link_name','Inserisci un nome da 1 a 80 caratteri.');
   await db().runTransaction(async t=>{const ref=profiles().doc(a.id),snap=await t.get(ref),current=snap.data(),rows=connections(current);if(!rows.some(c=>c.owner===b.id))throw fail(403,'app_provider_forbidden','Collegamento non disponibile.');t.set(ref,{providerConnections:rows.map(c=>c.owner===b.id?{...c,label}:c),updatedAt:now()},{merge:true});});return {ok:true};
  }
  if(!['add','reauthorize'].includes(b.op))throw fail(400,'app_operation','Operazione non valida.');
  const c=list.find(c=>c.owner===b.id),label=String(b.label||'').trim();
  if(b.op==='add'&&(!label||label.length>80))throw fail(400,'app_link_name','Dai un nome al nuovo account eWeLink (massimo 80 caratteri).');
  if(b.op==='reauthorize'&&!c)throw fail(403,'app_provider_forbidden','Collegamento non disponibile.');
  const d={accountId:a.id,uid:req.appActor.uid,until:now()+10*60000,add:b.op==='add',...(b.op==='add'?{slot:crypto.randomBytes(32).toString('hex'),label}:{owner:c.owner})};
  res.cookie(INTENT,sealPending(d),{...opts,path:'/login',maxAge:10*60000});
  return {ok:true,url:origin+'/login?returnUrl='+encodeURIComponent(origin+'/app/index.html')};
 }
 function originCheck(req){if(req.headers?.origin!==origin)throw fail(403,'app_origin','Richiesta non autorizzata: riapri la plancia dal suo indirizzo ufficiale.');}
 function csrf(req){originCheck(req);const expected=mac(req.cookies?.[COOKIE]||'');const supplied=req.headers?.['x-app-csrf']||'';if(supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw fail(403,'app_csrf','Sessione aggiornata. Ricarica la pagina prima di riprovare.');}
 function desktop(req){return !/Mobile|Android|iPhone|iPad|Tablet/i.test(req.headers?.['user-agent']||'');}
 async function read(id){if(!/^[a-f0-9]{64}$/.test(id||''))throw fail(400,'app_account','Account non valido.');const s=await profiles().doc(id).get();if(!s.exists)throw fail(404,'app_account','Account non trovato.');return {...s.data(),id};}
 async function audit(actor,action,target){await db().collection('ewelinkAppAudit').doc(crypto.randomBytes(16).toString('hex')).set({actor:actor.uid,action,target,at:now()});}
 async function isAdmin(actor){const s=await adminRef().get();return actor.role==='admin'&&s.data()?.uid===actor.uid;}
 async function session(req,{active=true,allowActAs=true}={}){
  const cookie=req.cookies?.[COOKIE];
  if(!cookie)throw fail(401,'app_auth_required','Accedi con il tuo account della webapp.');
  let decoded;
  try{decoded=await auth().verifySessionCookie(cookie,true);}
  catch(error){
   if(['auth/session-cookie-expired','auth/session-cookie-revoked','auth/argument-error','auth/invalid-session-cookie','auth/user-disabled','auth/user-not-found','auth/id-token-revoked'].includes(error.code))throw fail(401,'app_auth_required','Accedi con il tuo account della webapp.');
   throw fail(503,'app_auth_unavailable','Verifica dell’accesso temporaneamente non disponibile. Riprova tra poco: la sessione è stata conservata.');
  }
  const actor=await read(accountId(decoded.email||'')).catch(error=>{if(error.status===404)throw fail(401,'app_auth_required','Accedi con il tuo account della webapp.');throw error;});
  if(actor.uid!==decoded.uid||decoded.email_verified!==true)throw fail(401,'app_auth_required','Identità dell’account non confermata.');
  if(actor.status==='blocked'||actor.status==='deleted')throw fail(403,'app_blocked',disabledMessage);
  if(Number(decoded.auth_time)*1000<Number(actor.invalidBefore||0))throw fail(401,'app_auth_required','Accesso revocato: accedi nuovamente.');
  req.appActor=actor;req.appAccount=actor;
  if(allowActAs&&req.cookies?.[ACT]){
   const id=req.cookies[ACT];if(!/^[a-f0-9]{64}$/.test(id))throw fail(401,'app_actas_expired','Accesso alla plancia utente scaduto.');
   const s=await db().collection('ewelinkAppDelegations').doc(hash(id)).get(),d=s.data();
   if(!d||d.actor!==actor.uid||d.until<=now()||!await isAdmin(actor)||!desktop(req))throw fail(401,'app_actas_expired','Accesso amministratore scaduto. Torna alla gestione account.');
   req.appAccount=await read(d.target).catch(error=>{if(error.status===404)throw fail(401,'app_actas_expired','Plancia rimossa. Torna alla gestione account.');throw error;});req.appImpersonating=true;req.appReadOnly=req.appAccount.status!=='active';
  }
  if(req.query?.accountContext&&req.query.accountContext!==req.appAccount.id)throw fail(409,'app_context_changed','La plancia aperta è cambiata. Ricarica la pagina.');
  if(active&&req.appAccount.status!=='active'&&!req.appImpersonating)throw fail(403,'app_pending','Account in attesa di ammissione da parte dell’amministratore.');
  return req.appAccount;
 }
 async function admin(req){await session(req,{allowActAs:false});if(!desktop(req))throw fail(403,'app_desktop','La gestione account è disponibile da computer.');if(!await isAdmin(req.appActor))throw fail(403,'app_forbidden','Accesso riservato all’amministratore.');return req.appActor;}
 async function identify(token,{renew=false}={}){
  const d=await auth().verifyIdToken(token,true);
  if(d.email_verified!==true||!d.email)throw fail(403,'app_verify_email','Conferma la tua email prima di accedere.');
  const verifiedTime=renew?d.iat:d.auth_time;
  if(!Number.isFinite(verifiedTime)||now()/1000-verifiedTime>300||verifiedTime>now()/1000+60)throw fail(401,'app_recent_login','Accedi nuovamente per confermare l’identità.');
  const email=d.email.trim().toLowerCase(),id=accountId(email),ref=profiles().doc(id),ar=adminRef();
  const profile=await db().runTransaction(async t=>{
   const s=await t.get(ref),a=s.data(),root=await t.get(ar);
   if(renew&&(!a?.uid||a.uid!==d.uid||!Number.isFinite(d.auth_time)||d.auth_time*1000<Number(a.invalidBefore||0)))throw fail(401,'app_auth_required','Accedi nuovamente per confermare il dispositivo.');
   if(a?.uid&&a.uid!==d.uid)throw fail(409,'app_identity_conflict','Questa email è già associata a un’altra identità. Contatta l’amministratore.');
   if(['blocked','deleted'].includes(a?.status))throw fail(403,'app_blocked',disabledMessage);
   if(renew&&a.status!=='active')throw fail(403,'app_pending','Account in attesa di ammissione da parte dell’amministratore.');
   const bootstrap=email===adminEmail&&(!root.exists||root.data().uid===d.uid);
   if(email===adminEmail&&root.exists&&root.data().uid!==d.uid)throw fail(403,'app_admin_identity','Identità amministratore non corrispondente.');
   const next={...(a||{}),email,uid:d.uid,name:a?.name||d.name||email.split('@')[0],person:a?.person||String(d.name||'').trim().slice(0,120),emailVerified:true,registrationIncomplete:false,status:bootstrap?'active':a?.status||'pending',role:bootstrap?'admin':'user',createdAt:a?.createdAt||now(),updatedAt:now()};
   t.set(ref,next);if(bootstrap&&!root.exists)t.set(ar,{uid:d.uid,email,createdAt:now()});return {...next,id};
  });
  return profile;
 }
 const loginAttempts=new Map();
 async function login(req,res,{renew=false}={}){
  originCheck(req);
  const address=req.ip||req.socket?.remoteAddress||'unknown',time=now();
  for(const [key,v]of loginAttempts)if(v.until<=time)loginAttempts.delete(key);
  const attempt=loginAttempts.get(address)||{count:0,until:time+600000};
  if(++attempt.count>30)throw fail(429,'app_rate_limit','Troppi tentativi di accesso. Attendi qualche minuto.');
  loginAttempts.set(address,attempt);if(typeof req.body?.idToken!=='string'||req.body.idToken.length>20000)throw fail(400,'app_token','Accesso non valido.');
  const a=await identify(req.body.idToken,{renew}),remember=renew||req.body.remember===true,expiresIn=remember?14*DAY:12*3600000;
  const cookie=await auth().createSessionCookie(req.body.idToken,{expiresIn});
  res.cookie(COOKIE,cookie,{...opts,...(remember?{maxAge:expiresIn}:{})});res.clearCookie(ACT,opts);
  // Solo il proprietario originale può adottare la sessione eWeLink precedente.
  if(a.role==='admin'&&!a.providerOwner){
   try{const old={cookies:{...req.cookies}};await programming().restoreSession(old,res);if(old.programmingOwner)await bind(a,old.programmingOwner);}
   catch(error){if(!['not_authenticated','app_provider_taken'].includes(error.code))throw error;}
  }
  return {ok:true,account:publicProfile(await read(a.id))};
 }
 async function status(req){const a=await session(req,{active:false});return {ok:true,authenticated:true,account:publicProfile(a),actor:publicProfile(req.appActor),impersonating:!!req.appImpersonating,readOnly:!!req.appReadOnly,adminDesktop:desktop(req)&&await isAdmin(req.appActor),primaryProvider:a.providerOwner||'',selectedProvider:selectedConnection(req,a)?.owner||'',selectedProviderLabel:selectedConnection(req,a)?.label||'',providerCount:connections(a).length,csrf:mac(req.cookies[COOKIE])};}
 async function bind(a,owner,{add=false,slot='',label,expectedOwner}={}){
  const pr=profiles().doc(a.id),lr=links().doc(owner);
  await db().runTransaction(async t=>{
   const p=await t.get(pr),l=await t.get(lr),current=p.data();
   if(current?.status!=='active')throw fail(403,'app_blocked','Account non attivo.');
   if(l.exists&&!l.data().deleted&&l.data().accountId!==a.id)throw fail(409,'app_provider_taken','Questo account eWeLink è già collegato a un’altra plancia.');
   const rows=connections(current),known=rows.find(c=>c.owner===owner);
   if(!add&&(expectedOwner||current.providerOwner)&&(expectedOwner||current.providerOwner)!==owner)throw fail(409,'app_provider_changed','Hai scelto un account eWeLink diverso. Usa Aggiungi account per conservarli entrambi.');
   if(!known)rows.push({owner,label:label||'Account principale',slot});
   t.set(lr,{accountId:a.id,deleted:false,updatedAt:now()});t.set(pr,{providerOwner:current.providerOwner||owner,providerConnections:rows,setupDone:true,updatedAt:now()},{merge:true});
  });
 }
 // Rimozione definitiva: cancella profilo e accesso, libera l’email e blocca i timer dell’account eWeLink collegato.
 async function remove(a){
  const pr=profiles().doc(a.id);let uid=null,email=null;
  await db().runTransaction(async t=>{
   const p=await t.get(pr);if(!p.exists)return;const current=p.data();uid=current.uid||null;email=current.email||null;
   const linked=await Promise.all(connections(current).map(async c=>{const ref=links().doc(c.owner);return {ref,snap:await t.get(ref)};}));
   for(const {ref,snap}of linked)if(!snap.exists||snap.data().accountId===a.id)t.set(ref,{accountId:a.id,deleted:true,updatedAt:now()});
   t.delete(pr);
  });
  // Copie d’archivio create dalle versioni precedenti: eliminate insieme alla plancia.
  if(email){const old=await db().collection('ewelinkAppDeletedAccounts').where('email','==',email).get();for(const d of old.docs)await d.ref.delete();}
  if(uid){await auth().revokeRefreshTokens(uid).catch(()=>{});await auth().deleteUser(uid).catch(()=>{});}
 }
 async function providerAccount(owner){const s=await links().doc(owner).get();if(!s.exists)return null;if(s.data().deleted)throw fail(403,'app_blocked','Plancia rimossa: comandi automatici bloccati.');return read(s.data().accountId);}
 async function authorizeOwner(owner){const a=await providerAccount(owner);if(a&&a.status!=='active')throw fail(403,'app_blocked','Account sospeso: comandi automatici bloccati.');return a;}
 async function provider(req){
  const a=await session(req);
  const expected=req.headers?.['x-app-account']||req.query?.accountContext;
  if((expected&&expected!==a.id)||(!['GET','HEAD'].includes(req.method)&&expected!==a.id))throw fail(409,'app_context_changed','La plancia aperta è cambiata. Ricarica la pagina prima di inviare comandi.');
  if(req.method!=='GET'&&req.method!=='HEAD'){csrf(req);if(req.appReadOnly)throw fail(403,'app_readonly','Questa plancia è consultabile soltanto: account non attivo.');}
  const selected=selectedConnection(req,a),expectedProvider=req.headers?.['x-app-provider']||req.query?.providerContext;
  if(!selected)throw fail(401,'not_authenticated','Collega eWeLink per la prima volta dalla tua plancia.');
  if(expectedProvider&&expectedProvider!==selected.owner||!['GET','HEAD'].includes(req.method)&&connections(a).length>1&&expectedProvider!==selected.owner)throw fail(409,'app_provider_context_changed','Account eWeLink cambiato. Ricarica la plancia prima di inviare comandi.');
  const c=await programming().access(selected.owner,{inspection:req.appImpersonating===true&&req.appReadOnly===true});req.programmingOwner=selected.owner;req.programmingChecked=true;
  req.cookies={...req.cookies,ewelink_access:c.accessToken,ewelink_refresh:c.refreshToken,ewelink_expires:String(c.atExpiredTime)};
 }
 async function tokenAllowed(token){const owner=await programming().identity({cookies:{ewelink_access:token}});await authorizeOwner(owner);}
 function sealPending(data){const payload=Buffer.from(JSON.stringify(data)).toString('base64url');return payload+'.'+mac(payload);}
 function openPending(value){const [p,m]=String(value||'').split('.');if(!p||!m||m.length!==64||!crypto.timingSafeEqual(Buffer.from(mac(p)),Buffer.from(m)))return null;try{return JSON.parse(Buffer.from(p,'base64url'));}catch{return null;}}
 async function context(req,home,legacyRef){
  let a=req.appAccount,owner=req.programmingOwner;if(!owner)owner=await programming().identity(req);if(!a)a=await authorizeOwner(owner);
  if(!a)return legacyRef;
  const ref=db().collection('sanLuigiScenarioWorkspaces').doc(hash(appid+':app:'+a.id+':'+home.id+(owner!==a.providerOwner?':provider:'+owner:'')));
  // Migrazione non distruttiva, esclusivamente della plancia dell’amministratore.
  if(a.role==='admin'&&owner===a.providerOwner)await db().runTransaction(async t=>{const dest=await t.get(ref),old=await t.get(legacyRef);if(!dest.exists&&old.exists){const data=old.data();if(Object.values(data.executions||{}).some(r=>r.status==='running'&&r.expiresAt>now()))throw fail(409,'app_migration_busy','Attendi la fine del comando prima di aprire la nuova plancia.');t.set(ref,{...data,migratedFrom:legacyRef.id,migratedAt:now()});}});
  return ref;
 }
 function accountLogo(value){
  if(value==='')return '';
  if(typeof value!=='string'||value.length>140000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)){
   throw fail(400,'app_logo','Logo non valido o troppo grande.');
  }
  const bytes=Buffer.from(value.slice(22),'base64');
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw fail(400,'app_logo','Logo PNG non valido.');
  return value;
 }
 async function registrationList(){
  const rows=await profiles().get(),records=new Map(rows.docs.map(s=>[s.id,{...s.data(),id:s.id}]));
  let pageToken,warning='';
  try{
   do{
    const page=await auth().listUsers(1000,pageToken);
    for(const user of page.users){
     const email=String(user.email||'').trim().toLowerCase();
     if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||email===adminEmail)continue;
     const id=accountId(email),existing=records.get(id);
     if(existing){if(existing.uid===user.uid)existing.emailVerified=user.emailVerified===true;continue;}
     const ref=profiles().doc(id);
     const record=await db().runTransaction(async t=>{
      const snap=await t.get(ref);if(snap.exists)return {...snap.data(),id};
      // Recover an interrupted registration without granting access or changing credentials.
      const person=String(user.displayName||'').trim().slice(0,120);
      const next={email,uid:user.uid,name:person.slice(0,80)||email.split('@')[0],person,status:user.disabled?'blocked':'pending',role:'user',registrationIncomplete:true,emailVerified:user.emailVerified===true,createdAt:Number.isFinite(Date.parse(user.metadata?.creationTime))?Date.parse(user.metadata.creationTime):now(),updatedAt:now()};
      t.set(ref,next);return {...next,id};
     });records.set(id,record);
    }
    pageToken=page.pageToken;
   }while(pageToken);
  }catch{warning='Non è stato possibile verificare tutti gli accessi Firebase. Le plance già salvate sono conservate: aggiorna l’elenco per riprovare.';}
  return {ok:true,accounts:[...records.values()].map(publicProfile).sort((a,b)=>a.name.localeCompare(b.name)),...(warning?{registrationWarning:warning}:{})};
 }
 async function manage(req,res){
  const actor=await admin(req);
  if(req.method==='GET')return registrationList();
  csrf(req);const b=req.body||{};
  if(b.op==='stop-view'){res.clearCookie(ACT,opts);await audit(actor,'stop-view',actor.id);return {ok:true};}
  if(b.op==='invite'){
   const email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!name||name.length>80)throw fail(400,'app_invite','Inserisci un nome (massimo 80 caratteri) e un indirizzo email valido.');
   const id=accountId(email),ref=profiles().doc(id);
   const previous=await ref.get();if(previous.exists&&previous.data().status==='deleted')await remove({id});
   await db().runTransaction(async t=>{const s=await t.get(ref);if(s.exists)throw fail(409,'app_exists','Account già presente: usa Ammetti o Riattiva.');t.set(ref,{email,name,logo:accountLogo(b.logo??''),status:b.enabled===false?'blocked':'active',role:'user',createdAt:now(),updatedAt:now()});});await audit(actor,'invite',id);return {ok:true};
  }
  const a=await read(b.id);
  if(b.op==='enter'){
   const id=crypto.randomBytes(32).toString('hex');await db().collection('ewelinkAppDelegations').doc(hash(id)).set({actor:actor.uid,target:a.id,until:now()+3600000});
   res.cookie(ACT,id,{...opts,maxAge:3600000});await audit(actor,'enter',a.id);return {ok:true};
  }
  if(a.id===actor.id&&['block','delete'].includes(b.op))throw fail(400,'app_self','Non puoi bloccare o rimuovere l’unico amministratore.');
  if(b.op==='edit'){
   const name=String(b.name||'').trim();
   if(!name||name.length>80)throw fail(400,'app_name','Inserisci un nome tra 1 e 80 caratteri.');
   await profiles().doc(a.id).set({name,logo:accountLogo(b.logo??''),updatedAt:now()},{merge:true});
  }else if(b.op==='rename'){
   const name=String(b.name||'').trim();if(!name||name.length>80)throw fail(400,'app_name','Inserisci un nome tra 1 e 80 caratteri.');await profiles().doc(a.id).set({name,updatedAt:now()},{merge:true});
  }else if(b.op==='delete'){
   await remove(a);
  }else if(['approve','block'].includes(b.op)){
   const status={approve:'active',block:'blocked'}[b.op];
   // La revoca applicativa è efficace anche se Firebase non risponde.
   await profiles().doc(a.id).set({status,updatedAt:now(),...(b.op==='block'?{invalidBefore:now()}: {})},{merge:true});
   if(a.uid&&status!=='active')await auth().revokeRefreshTokens(a.uid).catch(()=>{});
  }else throw fail(400,'app_operation','Operazione account non valida.');
  await audit(actor,b.op,a.id);return {ok:true};
 }
 async function setup(req){
  const a=await session(req,{allowActAs:false});csrf(req);
  const name=String(req.body?.name||'').trim();
  if(!name||name.length>80)throw fail(400,'app_name','Inserisci il nome della plancia (massimo 80 caratteri).');
  await profiles().doc(a.id).set({name,logo:accountLogo(req.body?.logo??''),setupDone:true,updatedAt:now()},{merge:true});
  return {ok:true,account:publicProfile(await read(a.id))};
 }
 function install(app,wrap){
  app.get('/api/app/config',(_req,res)=>res.json({ok:true,enabled:true,firebase:webConfig}));
  app.get('/api/app/session',wrap(async(req,res)=>{try{res.json(await status(req));}catch(e){if(e.code==='app_auth_required'){if(req.cookies?.[COOKIE])res.clearCookie(COOKIE,opts);return res.json({ok:true,authenticated:false});}if(e.code==='app_actas_expired')res.clearCookie(ACT,opts);throw e;}}));
  app.post('/api/app/login',wrap(async(req,res)=>res.json(await login(req,res))));
  app.post('/api/app/renew',wrap(async(req,res)=>res.json(await login(req,res,{renew:true}))));
  app.get('/api/app/providers',wrap(async(req,res)=>res.json(await manageProviders(req,res))));
  app.post('/api/app/providers',wrap(async(req,res)=>res.json(await manageProviders(req,res))));
  app.post('/api/app/setup',wrap(async(req,res)=>res.json(await setup(req))));
  app.post('/api/app/logout',wrap(async(req,res)=>{csrf(req);res.clearCookie(COOKIE,opts);res.clearCookie(ACT,opts);res.clearCookie(PROVIDER,opts);res.clearCookie(INTENT,{...opts,path:'/login'});res.json({ok:true});}));
  app.get('/api/app/accounts',wrap(async(req,res)=>res.json(await manage(req,res))));
  app.post('/api/app/accounts',wrap(async(req,res)=>res.json(await manage(req,res))));
 }
 return {install,session,provider,bind,selectedConnection,selectConnection,linkIntent,context,authorizeOwner,tokenAllowed,sealPending,openPending,csrf,publicProfile,providerAccount,accountId};
};
