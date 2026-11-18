// Identità della webapp, separate dai token eWeLink. Nessuna password sul server.
'use strict';
const crypto=require('crypto');
module.exports=function createAccounts({db,auth,secret,appid,adminEmail,origin,webConfig,programming,listDevices=async()=>[],now=Date.now}){
 const COOKIE='ewelink_app',ACT='ewelink_actas',PROVIDER='ewelink_provider',INTENT='ewelink_link_intent',WORKSPACE='ewelink_workspace',DAY=86400000;
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
  const list=connections(a).filter(c=>!req.appPersonal||!c.workspaceAccountId),saved=openPending(req.cookies?.[PROVIDER]);
  return (saved?.accountId===a.id&&list.find(c=>c.owner===saved.owner))||list.find(c=>c.owner===a.providerOwner)||list[0]||null;
 }
 function connectionIdentity(a,c){
  if(!c)return null;
  const primary=c.owner===a.providerOwner,name=primary&&c.label==='Account principale'?(a.name||c.label):c.label;
  return {id:c.owner,label:name,name,person:typeof c.person==='string'?c.person:primary?a.person||'':'',logo:typeof c.logo==='string'?c.logo:primary?a.logo||'':''};
 }
 async function displayConnectionIdentity(a,c){
  const local=connectionIdentity(a,c);if(!local)return null;
  if(!c.brandingAccountId||!await isAdmin(a))return local;
  const ref=await profiles().doc(c.brandingAccountId).get();
  if(!ref.exists)return local;
  const brand=ref.data();
  return {...local,name:brand.name,person:brand.person||'',logo:brand.logo||'',brandingAccountId:c.brandingAccountId,localPerson:local.person,localLogo:local.logo};
 }
 const climateKey=(a,owner)=>owner===a.providerOwner?a.id:hash(a.id+':daikin:'+owner);
 function climateOwner(req){const a=req.appAccount;if(!a)throw fail(403,'climate_account','Account non disponibile.');const c=selectedConnection(req,a);if(!c)throw fail(409,'climate_account','Collega e seleziona un account eWeLink per il clima.');return climateKey(a,c.owner);}
 async function climateScheduleOwner(s){
  const a=await authorizeOwner(s.owner);
  if(!a||!connections(a).some(c=>c.owner===s.owner))throw fail(403,'climate_account','Account della programmazione clima non disponibile.');
  const expected=climateKey(a,s.owner);
  if(s.daikinOwner!==expected)throw fail(403,'climate_account','Questa programmazione clima non appartiene all’account eWeLink selezionato. Modificala dall’account corretto.');
  return expected;
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
  if(c?.workspaceAccountId)throw fail(409,'app_link_workspace','Questo collegamento usa la plancia cliente. Ricollega eWeLink accedendo con l’account del cliente.');
  if(!c)throw fail(403,'app_provider_forbidden','Collegamento non disponibile.');return {...d,slot:c.slot||'',label:c.label};
 }
 // Access grants are stored only on the destination dashboard and rechecked per request.
 function workspaceGrant(actor,target){return target.dashboardAccess?.[actor.id]?.control===true?target.dashboardAccess[actor.id]:null;}
 async function mayOpenWorkspace(req,actor,target){return actor.status==='active'&&target.status==='active'&&(!!workspaceGrant(actor,target)||desktop(req)&&await isAdmin(actor));}
 async function canReconnect(req){
  if(!req.appImpersonating)return true;
  return req.appAccount?.status==='active'&&workspaceGrant(req.appActor,req.appAccount)?.reconnect===true;
 }
 async function workspaceChoices(actor,req){
  const root=await isAdmin(actor),rows=await profiles().get();
  return rows.docs.filter(s=>s.id!==actor.id&&s.data().status==='active'&&s.data().providerOwner&&(root&&(!req||desktop(req))||workspaceGrant(actor,{...s.data(),id:s.id}))).map(s=>({id:'client:'+s.id,label:s.data().name,name:s.data().name,person:s.data().person||'',logo:s.data().logo||'',contextLabel:'Plancia autorizzata'})).sort((a,b)=>a.name.localeCompare(b.name,'it'));
 }
 async function switchChoices(req,a){
  const host=req.appImpersonating?req.appActor:a,root=await isAdmin(host),clients=await workspaceChoices(host,req),rows=[];
  for(const c of connections(host)){
   if(c.workspaceAccountId)continue;
   rows.push({...await displayConnectionIdentity(host,c),id:'provider:'+c.owner,contextLabel:'Collegamento personale'});
  }
  return {selected:req.appImpersonating?'client:'+a.id:'provider:'+(selectedConnection(req,a)?.owner||''),choices:[...rows,...clients]};
 }
 async function selectWorkspace(req,res,id){
  const target=await read(id);
  if(target.id===req.appActor.id||!target.providerOwner||!await mayOpenWorkspace(req,req.appActor,target))throw fail(403,'app_workspace','Questa plancia non è autorizzata per il tuo account. Il consenso si gestisce dal computer in Gestione account.');
  res.clearCookie(ACT,opts);res.cookie(WORKSPACE,sealPending({actorId:req.appActor.id,targetId:target.id}),{...opts,maxAge:365*DAY});
 }
 async function transferPrograms(req,body){
  const delegated=req.appImpersonating;await admin(req);csrf(req);if(delegated)throw fail(403,'app_transfer','Torna alla tua plancia per trasferire programmi.');
  const host=await read(req.appActor.id),source=connections(host).find(c=>c.owner===body.source);
  const customer=await read(body.targetId);
  if(!source||customer.id===host.id||customer.status!=='active'||!customer.providerOwner)throw fail(400,'app_transfer','Seleziona un tuo collegamento e una plancia cliente attiva.');
  const transfer=require('./programming-transfer')({db,programming,listDevices,now});
  if(body.op==='preview-transfer'){
   const snapshot=await transfer.preview({source:source.owner,target:customer.providerOwner});
   return {ok:true,sourceName:source.label,targetName:customer.name,names:snapshot.names,folders:snapshot.folders,proof:sealPending({snapshot,actorId:host.id,targetId:customer.id,until:now()+10*60000})};
  }
  const proof=openPending(body.proof);
  if(!proof||proof.actorId!==host.id||proof.targetId!==customer.id||proof.snapshot.source!==source.owner||proof.snapshot.target!==customer.providerOwner||proof.until<=now())throw fail(409,'app_transfer','Anteprima scaduta o cambiata. Ripeti la verifica.');
  const result=await transfer.execute({proof:proof.snapshot,actorId:host.id,targetId:customer.id,readConnections:connections});
  await audit(req.appActor,'transfer-programming',customer.id);return {ok:true,...result};
 }
 async function manageProviders(req,res){
  if(req.method!=='GET'&&req.body?.op==='stop-workspace'){await session(req,{allowActAs:false});csrf(req);res.clearCookie(ACT,opts);res.cookie(WORKSPACE,sealPending({actorId:req.appActor.id,targetId:''}),{...opts,maxAge:365*DAY});return {ok:true};}
  const a=await session(req),list=connections(a),selected=selectedConnection(req,a);
  if(req.method!=='GET'&&['preview-transfer','transfer-programming'].includes(req.body?.op))return transferPrograms(req,req.body);
  if(req.method==='GET'){
   const adminBranding=!req.appImpersonating&&await isAdmin(req.appActor);
   const brandingAccounts=adminBranding?(await profiles().get()).docs.map(s=>({id:s.id,name:s.data().name})).sort((x,y)=>x.name.localeCompare(y.name)):[];
   const switches=await switchChoices(req,a),canRelink=await canReconnect(req);
   const connectionRows=await Promise.all(list.map(async c=>{const target=c.workspaceAccountId?await read(c.workspaceAccountId):null;return {...await displayConnectionIdentity(a,c),workspaceAccountId:c.workspaceAccountId||'',canSelect:!target||await mayOpenWorkspace(req,req.appActor,target),canReconnect:canRelink&&!c.workspaceAccountId};}));
   return {ok:true,selected:selected?.owner||'',switchSelected:switches.selected,switchChoices:switches.choices,impersonating:!!req.appImpersonating,connections:connectionRows,...(adminBranding?{brandingAccounts,canTransfer:desktop(req),transferTargets:(await workspaceChoices(req.appActor)).map(c=>({id:c.id.slice(7),name:c.name}))}:{})};
  }
  csrf(req);if(req.appReadOnly)throw fail(403,'app_readonly','Plancia disponibile soltanto in consultazione.');
  const b=req.body||{};
  if(b.op==='stop-workspace'){
   if(!req.appWorkspace)throw fail(403,'app_workspace','Nessuna plancia cliente selezionata.');res.cookie(WORKSPACE,sealPending({actorId:req.appActor.id,targetId:''}),{...opts,maxAge:365*DAY});return {ok:true};
  }
  if(b.op==='select'){
   if(typeof b.id==='string'&&b.id.startsWith('client:')){await selectWorkspace(req,res,b.id.slice(7));return {ok:true};}
   if(typeof b.id==='string'&&b.id.startsWith('provider:')){
    const host=await read(req.appActor.id),c=connections(host).find(c=>c.owner===b.id.slice(9));
    if(!c)throw fail(403,'app_provider_forbidden','Collegamento non disponibile.');
    if(c.workspaceAccountId){await selectWorkspace(req,res,c.workspaceAccountId);return {ok:true};}
    res.clearCookie(ACT,opts);res.clearCookie(WORKSPACE,opts);
    res.cookie(PROVIDER,sealPending({accountId:host.id,owner:c.owner}),{...opts,maxAge:365*DAY});return {ok:true};
   }
   const raw=list.find(c=>c.owner===b.id);if(raw?.workspaceAccountId&&await isAdmin(req.appActor)){await selectWorkspace(req,res,raw.workspaceAccountId);return {ok:true};}
   await selectConnection(req,res,b.id);return {ok:true};
  }
  if(req.appImpersonating&&!(b.op==='reauthorize'&&await canReconnect(req)))throw fail(403,'app_link_owner','Non hai il permesso di ricollegare eWeLink per questa plancia. L’amministratore può assegnarlo da Gestione account sul computer.');
  if(b.op==='rename'){
   const label=String(b.label||'').trim();if(!label||label.length>80)throw fail(400,'app_link_name','Inserisci un nome da 1 a 80 caratteri.');
   const identity={};if(Object.hasOwn(b,'logo'))identity.logo=accountLogo(b.logo);if(Object.hasOwn(b,'person')){const person=String(b.person||'').trim();if(person.length>120)throw fail(400,'app_link_name','Il nome del titolare deve contenere al massimo 120 caratteri.');identity.person=person;}
   if(Object.hasOwn(b,'brandingAccountId')){
    if(!await isAdmin(req.appActor))throw fail(403,'app_branding_admin','Solo l’amministratore può associare il logo di una plancia cliente.');
    const id=String(b.brandingAccountId||'');if(id)await read(id);identity.brandingAccountId=id;
   }
   await db().runTransaction(async t=>{const ref=profiles().doc(a.id),snap=await t.get(ref),current=snap.data(),rows=connections(current);if(!rows.some(c=>c.owner===b.id))throw fail(403,'app_provider_forbidden','Collegamento non disponibile.');t.set(ref,{providerConnections:rows.map(c=>c.owner===b.id?{...c,label,...identity}:c),updatedAt:now()},{merge:true});});return {ok:true};
  }
  if(!['add','reauthorize'].includes(b.op))throw fail(400,'app_operation','Operazione non valida.');
  const c=list.find(c=>c.owner===b.id),label=String(b.label||'').trim();
  if(b.op==='add'&&(!label||label.length>80))throw fail(400,'app_link_name','Dai un nome al nuovo account eWeLink (massimo 80 caratteri).');
  if(b.op==='reauthorize'&&c?.workspaceAccountId)throw fail(409,'app_link_workspace','Questo collegamento usa la plancia cliente. Ricollega eWeLink accedendo con l’account del cliente.');
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
 async function isAdmin(actor){if(actor?.role!=='admin')return false;const s=await adminRef().get();return actor.role==='admin'&&s.data()?.uid===actor.uid;}
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
  req.appActor=actor;req.appAccount=actor;req.appImpersonating=false;req.appWorkspace=false;req.appReadOnly=false;req.appPersonal=false;
  const savedWorkspace=allowActAs?openPending(req.cookies?.[WORKSPACE]):null;
  const explicitWorkspace=savedWorkspace?.actorId===actor.id?savedWorkspace:null;
  const mapped=!explicitWorkspace&&allowActAs&&!req.cookies?.[ACT]&&await isAdmin(actor)?selectedConnection(req,actor)?.workspaceAccountId:null;
  const mappedAllowed=!!mapped&&await mayOpenWorkspace(req,actor,await read(mapped));
  req.appPersonal=!!explicitWorkspace&&!explicitWorkspace.targetId||!!mapped&&!mappedAllowed;
  let workspace=explicitWorkspace||(mappedAllowed?{actorId:actor.id,targetId:mapped}:null);
  if(!workspace&&!actor.providerOwner){const first=(await workspaceChoices(actor,req))[0];if(first){workspace={actorId:actor.id,targetId:first.id.slice(7)};req.appAutoWorkspace=workspace;}}
  if(workspace?.actorId===actor.id&&workspace.targetId){
   const target=await read(workspace.targetId);
   if(target.status!=='active'||!target.providerOwner)throw fail(403,'app_blocked',disabledMessage);
   if(!await mayOpenWorkspace(req,actor,target))throw fail(403,'app_workspace','Il tuo account non è autorizzato ad aprire questa plancia su questo dispositivo. Contatta l’amministratore.');
   req.appAccount=target;req.appImpersonating=true;req.appWorkspace=true;req.appReadOnly=false;
  }
  if(allowActAs&&req.cookies?.[ACT]){
   const id=req.cookies[ACT];if(!/^[a-f0-9]{64}$/.test(id))throw fail(401,'app_actas_expired','Accesso alla plancia utente scaduto.');
   const s=await db().collection('ewelinkAppDelegations').doc(hash(id)).get(),d=s.data();
   if(!d||d.actor!==actor.uid||d.until<=now()||!await isAdmin(actor)||!desktop(req))throw fail(401,'app_actas_expired','Accesso amministratore scaduto. Torna alla gestione account.');
   req.appWorkspace=false;req.appAccount=await read(d.target).catch(error=>{if(error.status===404)throw fail(401,'app_actas_expired','Plancia rimossa. Torna alla gestione account.');throw error;});req.appImpersonating=true;req.appReadOnly=req.appAccount.status!=='active';
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
  res.cookie(COOKIE,cookie,{...opts,...(remember?{maxAge:expiresIn}:{})});res.clearCookie(ACT,opts);if(!renew)res.clearCookie(WORKSPACE,opts);
  // Solo il proprietario originale può adottare la sessione eWeLink precedente.
  if(a.role==='admin'&&!a.providerOwner){
   try{const old={cookies:{...req.cookies}};await programming().restoreSession(old,res);if(old.programmingOwner)await bind(a,old.programmingOwner);}
   catch(error){if(!['not_authenticated','app_provider_taken'].includes(error.code))throw error;}
  }
  return {ok:true,account:publicProfile(await read(a.id))};
 }
 async function status(req){const a=await session(req,{active:false}),identity=await displayConnectionIdentity(a,selectedConnection(req,a));return {ok:true,authenticated:true,account:publicProfile(a),actor:publicProfile(req.appActor),impersonating:!!req.appImpersonating,workspaceView:!!req.appWorkspace,quickSelection:req.appWorkspace?'client:'+a.id:'provider:'+(selectedConnection(req,a)?.owner||''),readOnly:!!req.appReadOnly,canReconnectProvider:await canReconnect(req),adminDesktop:desktop(req)&&await isAdmin(req.appActor),primaryProvider:a.providerOwner||'',selectedProvider:selectedConnection(req,a)?.owner||'',selectedProviderLabel:connectionIdentity(a,selectedConnection(req,a))?.label||'',selectedProviderIdentity:identity,providerCount:connections(a).length,csrf:mac(req.cookies[COOKIE])};}
 async function bind(a,owner,{add=false,slot='',label,expectedOwner}={}){
  const pr=profiles().doc(a.id),lr=links().doc(owner);
  await db().runTransaction(async t=>{
   const p=await t.get(pr),l=await t.get(lr),current=p.data();
   if(current?.status!=='active')throw fail(403,'app_blocked','Account non attivo.');
   if(l.exists&&!l.data().deleted&&l.data().accountId!==a.id)throw fail(409,'app_provider_taken','Questo account eWeLink è già collegato a un’altra plancia.');
   const rows=connections(current),known=rows.find(c=>c.owner===owner);
   if(rows.some(c=>c.owner===(expectedOwner||owner)&&c.workspaceAccountId))throw fail(409,'app_link_workspace','Il collegamento appartiene alla plancia cliente. Accedi con l’account del cliente per ricollegarlo.');
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
 async function authorizeOwner(owner){const a=await providerAccount(owner);if(a&&a.status!=='active')throw fail(403,'app_blocked','Account sospeso: comandi automatici bloccati.');if(a&&connections(a).some(c=>c.owner===owner&&c.workspaceAccountId))throw fail(403,'app_link_workspace','Questo vecchio collegamento è stato sostituito dalla plancia cliente. Usa la plancia cliente per dispositivi e programmazioni.');return a;}
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
  return {ok:true,accounts:[...records.values()].map(a=>({...publicProfile(a),dashboardAccess:a.dashboardAccess||{}})).sort((a,b)=>a.name.localeCompare(b.name)),...(warning?{registrationWarning:warning}:{})};
 }
 async function manage(req,res){
  const actor=await admin(req);
  if(req.method==='GET')return registrationList();
  csrf(req);const b=req.body||{};
  if(b.op==='stop-view'){res.clearCookie(ACT,opts);res.clearCookie(WORKSPACE,opts);await audit(actor,'stop-view',actor.id);return {ok:true};}
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
   res.clearCookie(WORKSPACE,opts);res.cookie(ACT,id,{...opts,maxAge:3600000});await audit(actor,'enter',a.id);return {ok:true};
  }
  if(a.id===actor.id&&['block','delete'].includes(b.op))throw fail(400,'app_self','Non puoi bloccare o rimuovere l’unico amministratore.');
  if(b.op==='edit'){
   const permissions={};
   if(Object.hasOwn(b,'dashboardAccess')){
    if(a.id===actor.id)throw fail(400,'app_self','Assegna i permessi dalla plancia cliente.');
    if(!b.dashboardAccess||typeof b.dashboardAccess!=='object'||Array.isArray(b.dashboardAccess)||Object.keys(b.dashboardAccess).length>200)throw fail(400,'app_permissions','Elenco permessi non valido.');
    const grants={};
    for(const[id,g]of Object.entries(b.dashboardAccess)){
     if(!/^[a-f0-9]{64}$/.test(id)||id===a.id||!g||g.control!==true||typeof g.reconnect!=='boolean')throw fail(400,'app_permissions','Permessi non validi.');
     const recipient=await read(id);if(recipient.status!=='active'&&!a.dashboardAccess?.[id]?.control)throw fail(400,'app_permissions','Puoi autorizzare soltanto account abilitati.');
     grants[id]={control:true,reconnect:g.reconnect};
    }
    permissions.dashboardAccess=grants;
   }
   const name=String(b.name||'').trim();
   if(!name||name.length>80)throw fail(400,'app_name','Inserisci un nome tra 1 e 80 caratteri.');
   const logo=accountLogo(b.logo??'');await db().runTransaction(async t=>{const ref=profiles().doc(a.id),current=await t.get(ref);if(!current.exists)throw fail(404,'app_account','Account non trovato.');t.set(ref,{...current.data(),name,logo,...permissions,updatedAt:now()});});
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
  app.get('/api/app/session',wrap(async(req,res)=>{try{const data=await status(req);if(req.appAutoWorkspace)res.cookie(WORKSPACE,sealPending(req.appAutoWorkspace),{...opts,maxAge:365*DAY});res.json(data);}catch(e){if(e.code==='app_auth_required'){if(req.cookies?.[COOKIE])res.clearCookie(COOKIE,opts);return res.json({ok:true,authenticated:false});}if(e.code==='app_actas_expired')res.clearCookie(ACT,opts);throw e;}}));
  app.post('/api/app/login',wrap(async(req,res)=>res.json(await login(req,res))));
  app.post('/api/app/renew',wrap(async(req,res)=>res.json(await login(req,res,{renew:true}))));
  app.get('/api/app/providers',wrap(async(req,res)=>res.json(await manageProviders(req,res))));
  app.post('/api/app/providers',wrap(async(req,res)=>res.json(await manageProviders(req,res))));
  app.post('/api/app/setup',wrap(async(req,res)=>res.json(await setup(req))));
  app.post('/api/app/logout',wrap(async(req,res)=>{csrf(req);res.clearCookie(COOKIE,opts);res.clearCookie(ACT,opts);res.clearCookie(WORKSPACE,opts);res.clearCookie(PROVIDER,opts);res.clearCookie(INTENT,{...opts,path:'/login'});res.json({ok:true});}));
  app.get('/api/app/accounts',wrap(async(req,res)=>res.json(await manage(req,res))));
  app.post('/api/app/accounts',wrap(async(req,res)=>res.json(await manage(req,res))));
 }
 return {install,session,provider,canReconnect,bind,selectedConnection,connectionIdentity,climateOwner,climateScheduleOwner,selectConnection,linkIntent,context,authorizeOwner,tokenAllowed,sealPending,openPending,csrf,publicProfile,providerAccount,accountId};
};
