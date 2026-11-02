/* Accesso della plancia. I token Firebase sono scambiati con cookie HttpOnly;
   password e token eWeLink non vengono salvati nel browser dalla webapp. */
(() => {
 'use strict';
 const state={enabled:false,csrf:'',account:null,actor:null,readOnly:false};
 const $=id=>document.getElementById(id);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let base='',sdkPromise,fbAuth,config,busy=false,readyResolve;
 const ready=new Promise(resolve=>{readyResolve=resolve;});
 const request=async(path,body)=>{
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),20000);
  try{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',signal:c.signal,...(body===undefined?{}:{headers:{'Content-Type':'application/json','X-App-CSRF':state.csrf},body:JSON.stringify(body)})});
   let d;try{d=await r.json();}catch{throw new Error('Risposta del server non disponibile. Riprova.');}if(!r.ok||!d.ok)throw Object.assign(new Error(d.msg||'Accesso non disponibile.'),{code:d.error});return d;
  }finally{clearTimeout(timer);}
 };
 function message(text){$('accountMessage').textContent=text;}
 function translate(e){return ({'auth/invalid-credential':'Email o password non corretti.','auth/invalid-email':'Inserisci un indirizzo email valido.','auth/account-exists-with-different-credential':'Questa email usa già un altro metodo. Accedi con Google oppure recupera la password.','auth/operation-not-allowed':'Metodo di accesso non ancora disponibile. Contatta l’amministratore.','auth/user-disabled':'Account sospeso. Contatta l’amministratore.','auth/email-already-in-use':'Email già registrata. Accedi oppure recupera la password.','auth/weak-password':'Scegli una password di almeno 8 caratteri.','auth/too-many-requests':'Troppi tentativi. Attendi prima di riprovare.','auth/popup-closed-by-user':'Accesso Google annullato.','auth/popup-blocked':'Il browser ha bloccato la finestra Google. Usa «Apri Google nella pagina».','auth/network-request-failed':'Connessione assente o cambiata. Riprova.','auth/unauthorized-domain':'Accesso Google non ancora autorizzato per questo sito. Contatta l’amministratore.'})[e.code]||e.message||'Accesso non riuscito.';}
 async function sdk(){
  if(!sdkPromise)sdkPromise=Promise.all([import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js'),import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js')]).then(async([app,auth])=>{fbAuth=auth.getAuth(app.initializeApp(config.firebase,'ewelink-webapp'));await auth.setPersistence(fbAuth,auth.inMemoryPersistence);fbAuth.languageCode='it';return auth;}).catch(e=>{sdkPromise=null;throw e;});
  return sdkPromise;
 }
 function gate(text){
  document.body.classList.add('account-locked');$('accountGate').hidden=false;message(text||'Accedi alla tua plancia. Il collegamento eWeLink si fa solo la prima volta.');
  document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  if(typeof window.finishStartup==='function')window.finishStartup();
 }
 function branding(){
  const name=state.account.name;
  document.title=name+' · Plancia';
  const brand=document.querySelector('.brand-copy');if(brand){brand.textContent='eWeLink';const small=document.createElement('small');small.textContent=name;brand.append(small);}
  const space=document.querySelector('.workspace');if(space){space.textContent='';const label=document.createElement('span');label.textContent=name;space.append(label);}
  const foot=document.querySelector('footer');if(foot)foot.textContent=name+' · La tua plancia';
 }
 function accepted(data){
  Object.assign(state,data);branding();
  $('accountIdentity').textContent=state.account.name;
  $('accountManage').hidden=!state.adminDesktop;
  $('accountReturn').hidden=!state.impersonating;
  $('accountIdentity').hidden=!state.impersonating;
  if(state.impersonating){$('accountIdentity').textContent='Stai gestendo '+state.account.name+(state.readOnly?' · Sola lettura':'');document.body.classList.add('account-delegated');}
  if(state.account.status!=='active'&&!state.impersonating){gate('Account in attesa di ammissione. L’amministratore deve autorizzare il tuo accesso.');$('accountCredentials').hidden=true;$('accountPending').hidden=false;return false;}
  $('accountGate').hidden=true;document.body.classList.remove('account-locked');
  if(readyResolve){readyResolve(true);readyResolve=null;}
  return true;
 }
 async function exchange(user){
  if(!user.emailVerified){message('Conferma l’email ricevuta, poi torna qui e accedi.');return;}
  const data=await request('/api/app/login',{idToken:await user.getIdToken(true),remember:$('accountRemember').checked});
  await (await sdk()).signOut(fbAuth);
  const current=await request('/api/app/session');
  if(accepted(current))location.reload();
 }
 async function run(fn){if(busy)return;busy=true;$('accountGate').setAttribute('aria-busy','true');document.querySelectorAll('#accountGate button').forEach(b=>b.disabled=true);try{await fn();}catch(e){message(translate(e));}finally{busy=false;$('accountGate').setAttribute('aria-busy','false');document.querySelectorAll('#accountGate button').forEach(b=>b.disabled=false);}}
 function mount(){
  const section=document.createElement('section');section.id='accountGate';section.hidden=true;section.setAttribute('aria-label','Accesso alla webapp');
  section.innerHTML=`<div class="account-card"><img src="icons/icon.svg" width="72" height="72" alt=""><p class="account-eyebrow">LA TUA PLANCIA</p><h1>Benvenuto.</h1><p id="accountMessage" role="status" aria-live="polite"></p><div id="accountCredentials"><label class="account-remember"><input id="accountRemember" type="checkbox"> Resta connesso su questo dispositivo</label><p class="account-small">Conserva l’accesso per un massimo di 14 giorni. Usalo soltanto sui tuoi dispositivi.</p><button id="accountGoogle" class="primary-button" type="button">Continua con Google</button><button id="accountGoogleRedirect" class="account-link" type="button">Apri Google nella pagina</button><div class="account-divider">oppure con la tua email</div><form id="accountForm"><label for="accountEmail">Email</label><input id="accountEmail" type="email" autocomplete="username" required maxlength="254"><label for="accountPassword">Password</label><input id="accountPassword" type="password" autocomplete="current-password" required maxlength="4096"><button class="primary-button" type="submit">Accedi</button><button id="accountRegister" class="secondary-button" type="button">Crea il tuo account</button><button id="accountReset" class="account-link" type="button">Password dimenticata?</button><button id="accountVerify" class="account-link" type="button">Invia di nuovo la conferma email</button></form></div><button id="accountRetry" class="account-link" type="button">Ricarica l’accesso</button><div id="accountPending" hidden><button id="accountCheck" class="primary-button">Controlla l’ammissione</button><button id="accountPendingLogout" class="secondary-button">Esci</button></div></div>`;
  document.body.append(section);
  const bar=document.createElement('div');bar.id='accountToolbar';bar.innerHTML='<span id="accountIdentity" hidden></span><button id="accountReturn" hidden>Torna alla gestione</button><button id="accountManage" hidden>Gestione account</button>';document.body.append(bar);
  const dialog=document.createElement('dialog');dialog.id='accountAdmin';dialog.innerHTML='<div class="account-admin-heading"><div><p class="account-eyebrow">AMMINISTRAZIONE</p><h1>Gestione account</h1></div><button id="accountAdminClose" class="secondary-button">Chiudi</button></div><p>Ammetti gli utenti e personalizza la loro plancia. Ogni account vede soltanto i propri dati.</p><form id="accountInvite"><label>Nome della plancia<input id="accountInviteName" required maxlength="80" placeholder="Per esempio: Oratorio San Luigi"></label><label>Email dell’utente<input id="accountInviteEmail" type="email" required maxlength="254"></label><button class="primary-button">Aggiungi account</button></form><p id="accountAdminMessage" role="status"></p><div id="accountList"></div>';document.body.append(dialog);
  window.matchMedia?.('(pointer:fine)').addEventListener('change',event=>{if(!event.matches&&dialog.open)dialog.close();});
  $('accountRetry').onclick=()=>location.reload();
  $('accountForm').addEventListener('submit',e=>{e.preventDefault();void run(async()=>exchange((await (await sdk()).signInWithEmailAndPassword(fbAuth,$('accountEmail').value.trim(),$('accountPassword').value)).user));});
  $('accountGoogle').onclick=()=>void run(async()=>{const a=await sdk();await exchange((await a.signInWithPopup(fbAuth,new a.GoogleAuthProvider())).user);});
  $('accountGoogleRedirect').onclick=()=>void run(async()=>{const a=await sdk();sessionStorage.setItem('ewelink_auth_remember',$('accountRemember').checked?'yes':'no');await a.setPersistence(fbAuth,a.browserSessionPersistence);await a.signInWithRedirect(fbAuth,new a.GoogleAuthProvider());});
  $('accountRegister').onclick=()=>void run(async()=>{if(!$('accountForm').reportValidity())return;if($('accountPassword').value.length<8){message('Per creare l’account scegli una password di almeno 8 caratteri.');return;}const a=await sdk(),c=await a.createUserWithEmailAndPassword(fbAuth,$('accountEmail').value.trim(),$('accountPassword').value);await a.sendEmailVerification(c.user);await a.signOut(fbAuth);$('accountPassword').value='';message('Account creato. Conferma l’email ricevuta e accedi. L’amministratore dovrà ammetterti alla plancia.');});
  $('accountVerify').onclick=()=>void run(async()=>{if(!$('accountForm').reportValidity())return;const a=await sdk(),c=await a.signInWithEmailAndPassword(fbAuth,$('accountEmail').value.trim(),$('accountPassword').value);if(c.user.emailVerified){await exchange(c.user);return;}await a.sendEmailVerification(c.user);await a.signOut(fbAuth);message('Email di conferma inviata. Controlla anche la posta indesiderata.');});
  $('accountReset').onclick=()=>void run(async()=>{if(!$('accountEmail').reportValidity())return;const a=await sdk();try{await a.sendPasswordResetEmail(fbAuth,$('accountEmail').value.trim());}catch(e){if(e.code!=='auth/user-not-found')throw e;}message('Se l’indirizzo è registrato, riceverai un’email per recuperare la password.');});
  $('accountCheck').onclick=()=>void run(async()=>{if(accepted(await request('/api/app/session')))location.reload();});
  $('accountPendingLogout').onclick=()=>void logout();
  $('accountManage').onclick=()=>void openAdmin();$('accountAdminClose').onclick=()=>$('accountAdmin').close();
  $('accountReturn').onclick=()=>void adminMutation({op:'stop-view'},true);
  $('accountInvite').onsubmit=e=>{e.preventDefault();void adminMutation({op:'invite',name:$('accountInviteName').value,email:$('accountInviteEmail').value});};
  $('accountList').onclick=e=>{const b=e.target.closest('[data-account-op]');if(!b)return;const op=b.dataset.accountOp,id=b.dataset.accountId,name=b.dataset.accountName;
   if(op==='rename'){const next=prompt('Nome personalizzato della plancia',name);if(next!==null)void adminMutation({op,id,name:next});return;}
   if(['delete','block'].includes(op)&&!confirm((op==='delete'?'Rimuovere l’accesso? I dati saranno archiviati e i timer sospesi. Potrai riattivare l’account.':'Bloccare l’account? Saranno bloccati accessi e nuovi comandi automatici; i dispositivi già accesi non verranno spenti.')+'\n'+name))return;
   void adminMutation({op,id},op==='enter');
  };
 }
 async function openAdmin(){
  if(!state.adminDesktop)return;if(!$('accountAdmin').open)$('accountAdmin').showModal();$('accountAdminMessage').textContent='Caricamento account…';
  try{const data=await request('/api/app/accounts');$('accountList').innerHTML=data.accounts.map(a=>`<article class="account-row"><div><h2>${esc(a.name)}</h2><p>${esc(a.email)}</p><span class="account-badge">${esc({active:'Ammesso',pending:'In attesa',blocked:'Bloccato',deleted:'Rimosso · archiviato'}[a.status]||a.status)}</span><span>${a.linked?'eWeLink collegato':'eWeLink da collegare'}</span></div><div class="account-actions">${[['enter','Apri plancia'],['rename','Cambia nome'],...(a.id===state.actor.id?[]:a.status==='active'?[['block','Blocca'],['delete','Rimuovi']]:[['approve',a.status==='pending'?'Ammetti':'Riattiva'],['delete','Rimuovi']])].map(([op,label])=>`<button type="button" class="secondary-button" data-account-op="${op}" data-account-id="${a.id}" data-account-name="${esc(a.name)}">${label}</button>`).join('')}</div></article>`).join('');$('accountAdminMessage').textContent=data.accounts.length+' account';}catch(e){$('accountAdminMessage').textContent=e.message;}
 }
 let adminBusy=false;
 async function adminMutation(body,reload=false){if(adminBusy)return;adminBusy=true;try{await request('/api/app/accounts',body);if(reload){location.reload();return;}await openAdmin();$('accountInvite').reset();}catch(e){$('accountAdminMessage').textContent=e.message;if(!$('accountAdmin').open)alert(e.message);}finally{adminBusy=false;}}
 async function logout(){try{await request('/api/app/logout',{});if(fbAuth)await (await sdk()).signOut(fbAuth);location.reload();}catch(e){alert('Uscita non confermata: '+e.message);}}
 async function bootstrap(url){
  base=url;
  try{
   config=await request('/api/app/config');if(!config.enabled)return true;
   state.enabled=true;mount();
   try{const current=await request('/api/app/session');if(accepted(current))return true;}catch(e){gate(e.code==='app_auth_required'?'':e.message);}
   const a=await sdk();const redirected=await a.getRedirectResult(fbAuth);
   if(redirected){$('accountRemember').checked=sessionStorage.getItem('ewelink_auth_remember')==='yes';sessionStorage.removeItem('ewelink_auth_remember');await exchange(redirected.user);}
   return ready;
  }catch(e){
   // Non aprire la plancia con il controllo account indisponibile.
   if(!$('accountGate'))mount();state.enabled=true;gate('Accesso non disponibile: '+translate(e));return ready;
  }
 }
 window.AppAccounts={state,bootstrap,logout,headers:()=>state.enabled?{'X-App-CSRF':state.csrf,'X-App-Account':state.account?.id||''}:{},handleError:d=>{if(state.enabled&&['app_auth_required','app_blocked','app_pending','app_actas_expired','app_context_changed'].includes(d?.error)){gate(d.msg);return true;}return false;}};
})();
