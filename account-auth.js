/* Accesso della plancia. I token Firebase sono scambiati con cookie HttpOnly;
   password e token eWeLink non vengono salvati nel browser dalla webapp. */
(() => {
 'use strict';
 const dashboardUrl=()=>new URL(location.pathname,location.origin);
 const adminPage=new URLSearchParams(location.search).get('view')==='accounts';
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
 function translate(e){return ({'auth/invalid-credential':'Email o password non corretti.','auth/invalid-email':'Inserisci un indirizzo email valido.','auth/account-exists-with-different-credential':'Questa email usa già un altro metodo. Accedi con Google oppure recupera la password.','auth/operation-not-allowed':'Metodo di accesso non ancora disponibile. Contatta l’amministratore.','auth/user-disabled':'Account sospeso. Contatta l’amministratore.','auth/email-already-in-use':'Email già registrata. Accedi oppure recupera la password.','auth/weak-password':'Scegli una password di almeno 8 caratteri.','auth/too-many-requests':'Troppi tentativi. Attendi prima di riprovare.','auth/popup-closed-by-user':'Accesso Google annullato.','auth/popup-blocked':'Il browser ha bloccato la finestra Google. Apri la plancia direttamente in Safari o Chrome e riprova.','auth/network-request-failed':'Connessione assente o cambiata. Riprova.','auth/unauthorized-domain':'Accesso Google non ancora autorizzato per questo sito. Contatta l’amministratore.'})[e.code]||e.message||'Accesso non riuscito.';}
 async function sdk(){
  if(!sdkPromise)sdkPromise=Promise.all([import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js'),import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js')]).then(async([app,auth])=>{fbAuth=auth.getAuth(app.initializeApp(config.firebase,'ewelink-webapp'));fbAuth.languageCode='it';return auth;}).catch(e=>{sdkPromise=null;throw e;});
  return sdkPromise;
 }
 function gate(text){
  document.body.classList.add('account-locked');$('accountGate').hidden=false;message(text||'Accedi alla tua plancia. Il collegamento eWeLink si fa solo la prima volta.');
  document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  if(typeof window.finishStartup==='function')window.finishStartup();
  const splash=$('startupScreen');if(splash)splash.hidden=true;
  document.body.classList.remove('app-starting');
 }
 function branding(){
  const name=state.account.name;
  document.title=name+' · Plancia';
  const brand=document.querySelector('.brand-copy');if(brand){brand.textContent='eWeLink';const small=document.createElement('small');small.textContent=name;brand.append(small);}
  const space=document.querySelector('.workspace');if(space){space.textContent='';const label=document.createElement('span');label.textContent=name;space.append(label);}
  if(state.account.logo){
   const logo=document.querySelector('.customer-logo')||document.createElement('img');
   logo.src=state.account.logo;logo.alt=name;logo.className='customer-logo';
   document.querySelector('.topbar')?.append(logo);
  }
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
  if(state.account.needsSetup&&!state.impersonating){showSetup();return false;}
  $('accountGate').hidden=true;document.body.classList.remove('account-locked');
  if(readyResolve){readyResolve(true);readyResolve=null;}
  return true;
 }
 async function signInPersistence(redirect=false){
  const a=await sdk();
  await a.setPersistence(fbAuth,$('accountRemember').checked?a.browserLocalPersistence:redirect?a.browserSessionPersistence:a.inMemoryPersistence);
  return a;
 }
 function completing(){
  $('accountGate').hidden=true;
  document.body.classList.add('account-locked','app-starting');
  const splash=$('startupScreen');
  if(splash){splash.hidden=false;splash.setAttribute('aria-busy','true');}
  const status=$('startupStatus');if(status)status.textContent='Completamento dell’accesso…';
 }
 async function exchange(user,{renew=false}={}){
  if(!user.emailVerified){message('Conferma l’email ricevuta, poi torna qui e accedi.');return;}
  completing();
  const remember=renew||$('accountRemember').checked;
  await request(renew?'/api/app/renew':'/api/app/login',{idToken:await user.getIdToken(true),remember});
  if(!remember)void (await sdk()).signOut(fbAuth).catch(()=>{});
  let current;
  for(const delay of [0,250,750]){
   if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
   try{current=await request('/api/app/session');}
   catch(e){if(e.code!=='app_auth_unavailable'&&e.name!=='TypeError')throw e;continue;}
   if(current.authenticated!==false)break;
  }
  if(!current)throw new Error('Verifica della sessione non disponibile. Riprova tra poco.');
  if(current.authenticated===false)throw new Error('Il browser non ha conservato l’accesso. Consenti i cookie per questo sito e riprova.');
  const firstAccess=Boolean(readyResolve);
  if(accepted(current)&&!firstAccess)location.reload();
 }
 async function run(fn){if(busy)return;busy=true;$('accountGate').setAttribute('aria-busy','true');document.querySelectorAll('#accountGate button').forEach(b=>b.disabled=true);try{await fn();}catch(e){gate(translate(e));}finally{busy=false;$('accountGate').setAttribute('aria-busy','false');document.querySelectorAll('#accountGate button').forEach(b=>b.disabled=false);}}
 async function signUp(){
  if(busy)return;busy=true;
  const form=$('accountSignupForm'),note=$('accountSignupMessage');form.querySelectorAll('button').forEach(b=>b.disabled=true);note.textContent='';
  try{
   const first=$('accountSignupFirst').value.trim(),last=$('accountSignupLast').value.trim(),email=$('accountSignupEmail').value.trim();
   if($('accountSignupPassword').value.length<8){note.textContent='Scegli una password di almeno 8 caratteri.';return;}
   const a=await sdk(),c=await a.createUserWithEmailAndPassword(fbAuth,email,$('accountSignupPassword').value);
   await a.updateProfile(c.user,{displayName:(first+' '+last).trim()});
   await a.sendEmailVerification(c.user);await a.signOut(fbAuth);
   $('accountSignup').close();$('accountEmail').value=email;$('accountPassword').value='';
   message('Ti abbiamo inviato un’email a '+email+'. Apri il link di conferma (controlla anche la posta indesiderata), poi torna qui e premi Accedi con email e password. Al primo accesso completerai l’iscrizione.');
  }catch(e){note.textContent=translate(e);}
  finally{busy=false;form.querySelectorAll('button').forEach(b=>b.disabled=false);}
 }
 let setupLogo='';
 async function readSetupLogo(){
  const input=$('accountSetupLogo'),file=input.files[0],preview=$('accountSetupPreview');
  if(!file)return;
  try{
   if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5000000)throw Error('Scegli un logo PNG, JPEG o WebP di massimo 5 MB.');
   const image=await createImageBitmap(file);
   try{
    const canvas=document.createElement('canvas'),scale=Math.min(1,160/Math.max(image.width,image.height));
    canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    setupLogo=canvas.toDataURL('image/png');preview.src=setupLogo;preview.hidden=false;
   }finally{image.close();}
  }catch(e){input.value='';setupLogo='';preview.hidden=true;message(e.message);}
 }
 function showSetup(){
  gate('Ultimo passo: dai un nome alla tua plancia e, se vuoi, aggiungi il logo. Poi collega il tuo account eWeLink.');
  $('accountCredentials').hidden=true;$('accountPending').hidden=true;$('accountRetry').hidden=true;$('accountSetup').hidden=false;
  if(!$('accountSetupName').value)$('accountSetupName').value=state.account.name||'';
  if(state.account.logo&&!setupLogo){setupLogo=state.account.logo;$('accountSetupPreview').src=setupLogo;$('accountSetupPreview').hidden=false;}
 }
 async function saveSetup(link){
  if(busy)return;busy=true;$('accountSetup').querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
   await request('/api/app/setup',{name:$('accountSetupName').value,logo:setupLogo});
   if(link)location.assign(base+'/login?returnUrl='+encodeURIComponent(base+'/app/index.html'));else location.reload();
  }catch(e){message(e.message);}
  finally{busy=false;$('accountSetup').querySelectorAll('button').forEach(b=>b.disabled=false);}
 }
 function mount(){
  const section=document.createElement('section');section.id='accountGate';section.hidden=true;section.setAttribute('aria-label','Accesso alla webapp');
  section.innerHTML=`<div class="app-login-card"><img src="icons/icon.svg" width="72" height="72" alt=""><p class="account-eyebrow">LA TUA PLANCIA</p><h1>Benvenuto.</h1><p id="accountMessage" role="status" aria-live="polite"></p><div id="accountCredentials"><label class="account-remember"><input id="accountRemember" type="checkbox"> Ricorda questo dispositivo</label><p class="account-small">Rimani connesso fino a quando esci o l’amministratore revoca l’accesso. Usalo soltanto sui tuoi dispositivi.</p><button id="accountGoogle" class="primary-button" type="button">Continua con Google</button><button id="accountGoogleRedirect" class="account-link" type="button">Apri Google nella pagina</button><div class="account-divider">oppure con la tua email</div><form id="accountForm"><label for="accountEmail">Email</label><input id="accountEmail" type="email" autocomplete="username" required maxlength="254"><label for="accountPassword">Password</label><input id="accountPassword" type="password" autocomplete="current-password" required maxlength="4096"><button class="primary-button" type="submit">Accedi</button><button id="accountRegister" class="secondary-button" type="button">Crea il tuo account</button><button id="accountReset" class="account-link" type="button">Password dimenticata?</button><button id="accountVerify" class="account-link" type="button">Invia di nuovo la conferma email</button></form></div><button id="accountRetry" class="account-link" type="button">Ricarica l’accesso</button><div id="accountPending" hidden><button id="accountCheck" class="primary-button">Controlla l’ammissione</button><button id="accountPendingLogout" class="secondary-button">Esci</button></div><form id="accountSetup" hidden><label>Nome della plancia<input id="accountSetupName" required maxlength="80" placeholder="Es. Oratorio San Luigi"></label><label>Logo (facoltativo)<input id="accountSetupLogo" type="file" accept="image/png,image/jpeg,image/webp"></label><img id="accountSetupPreview" class="account-setup-logo" alt="Anteprima logo" hidden><button class="primary-button" type="submit">Salva e collega eWeLink</button><button id="accountSetupLater" class="account-link" type="button">Salva e collega eWeLink più tardi</button><button id="accountSetupLogout" class="account-link" type="button">Esci</button></form><dialog id="accountSignup" aria-labelledby="accountSignupTitle"><form id="accountSignupForm"><h2 id="accountSignupTitle">Crea il tuo account</h2><p class="account-small">Ti invieremo un’email di conferma. Dopo il primo accesso completerai l’iscrizione con il nome e il logo della tua plancia.</p><div class="account-signup-names"><label>Nome<input id="accountSignupFirst" autocomplete="given-name" required maxlength="60"></label><label>Cognome<input id="accountSignupLast" autocomplete="family-name" required maxlength="60"></label></div><label>Email<input id="accountSignupEmail" type="email" autocomplete="email" required maxlength="254"></label><label>Password<input id="accountSignupPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="4096"></label><p id="accountSignupMessage" role="alert"></p><button class="primary-button" type="submit">Crea account</button><div class="account-divider">oppure</div><button id="accountSignupGoogle" class="secondary-button" type="button">Continua con Google</button><button id="accountSignupCancel" class="account-link" type="button">Annulla</button></form></dialog></div>`;
  document.body.append(section);
  const bar=document.createElement('div');bar.id='accountToolbar';bar.innerHTML='<span id="accountIdentity" hidden></span><button id="accountReturn" hidden>Torna alla gestione</button><button id="accountManage" hidden>Gestione account</button>';document.body.append(bar);
  $('accountRetry').onclick=()=>location.reload();
  $('accountForm').addEventListener('submit',e=>{e.preventDefault();void run(async()=>exchange((await (await signInPersistence()).signInWithEmailAndPassword(fbAuth,$('accountEmail').value.trim(),$('accountPassword').value)).user));});
  $('accountGoogle').onclick=()=>void run(async()=>{const a=await signInPersistence();await exchange((await a.signInWithPopup(fbAuth,new a.GoogleAuthProvider())).user);});
  const redirect = $('accountGoogleRedirect');
  redirect.hidden = !config?.firebase?.authDomain || config.firebase.authDomain !== location.host;
  redirect.onclick=()=>void run(async()=>{
   const a=await signInPersistence(true);
   sessionStorage.setItem('ewelink_auth_remember',$('accountRemember').checked?'yes':'no');
   await a.signInWithRedirect(fbAuth,new a.GoogleAuthProvider());
  });
  $('accountRegister').onclick=()=>{$('accountSignupForm').reset();$('accountSignupMessage').textContent='';$('accountSignupEmail').value=$('accountEmail').value.trim();$('accountSignup').showModal();};
  $('accountSignupCancel').onclick=()=>$('accountSignup').close();
  $('accountSignupGoogle').onclick=()=>{$('accountSignup').close();$('accountGoogle').click();};
  $('accountSignupForm').addEventListener('submit',e=>{e.preventDefault();void signUp();});
  $('accountSetup').addEventListener('submit',e=>{e.preventDefault();void saveSetup(true);});
  $('accountSetupLater').onclick=()=>{if($('accountSetup').reportValidity())void saveSetup(false);};
  $('accountSetupLogout').onclick=()=>void logout();
  $('accountSetupLogo').onchange=()=>void readSetupLogo();
  $('accountVerify').onclick=()=>void run(async()=>{if(!$('accountForm').reportValidity())return;const a=await sdk(),c=await a.signInWithEmailAndPassword(fbAuth,$('accountEmail').value.trim(),$('accountPassword').value);if(c.user.emailVerified){await exchange(c.user);return;}await a.sendEmailVerification(c.user);await a.signOut(fbAuth);message('Email di conferma inviata. Controlla anche la posta indesiderata.');});
  $('accountReset').onclick=()=>void run(async()=>{if(!$('accountEmail').reportValidity())return;const a=await sdk();try{await a.sendPasswordResetEmail(fbAuth,$('accountEmail').value.trim());}catch(e){if(e.code!=='auth/user-not-found')throw e;}message('Se l’indirizzo è registrato, riceverai un’email per recuperare la password.');});
  $('accountCheck').onclick=()=>void run(async()=>{if(accepted(await request('/api/app/session')))location.reload();});
  $('accountPendingLogout').onclick=()=>void logout();
  $('accountManage').onclick=()=>navigateAdmin(true);
  $('accountReturn').onclick=()=>void adminMutation({op:'stop-view'},'accounts');
 }
 function navigateAdmin(show){
  const url=dashboardUrl();
  if(show)url.searchParams.set('view','accounts');
  location.assign(url.href);
 }
 function showAdmin(){
  document.body.classList.add('account-admin-page');
  const page=document.createElement('section');
  page.id='accountAdmin';
  page.innerHTML=`<header class="account-admin-heading"><div><p class="account-eyebrow">AMMINISTRAZIONE</p><h1>Gestione account</h1></div><button id="accountBack" class="secondary-button">Torna alla plancia</button></header>
   <div class="account-admin-heading"><p>Gestisci l’accesso e il logo delle plance dei clienti.</p><button id="accountNew" class="primary-button">Nuova plancia</button></div>
   <p id="accountAdminMessage" role="status"></p><div id="accountList"></div>
   <dialog id="accountEditor"><form id="accountInvite"><h2 id="accountEditorTitle"></h2><label>Nome della plancia<input id="accountInviteName" required maxlength="80"></label><label id="accountEmailField">Email dell’utente<input id="accountInviteEmail" type="email" maxlength="254"></label><label id="accountEnabledField" class="account-enabled"><input id="accountEnabled" type="checkbox"> Abilitato</label><label>Logo del cliente (facoltativo)<input id="accountLogo" type="file" accept="image/png,image/jpeg,image/webp"></label><img id="accountLogoPreview" alt="Anteprima logo" hidden><button id="accountLogoRemove" class="account-link" type="button">Rimuovi logo</button><p id="accountEditorMessage" role="alert"></p><div class="account-actions"><button id="accountEditorCancel" type="button" class="secondary-button">Annulla</button><button class="primary-button">Salva</button></div></form></dialog>
   <dialog id="accountRemove"><h2>Rimuovere la plancia?</h2><p>La plancia sarà eliminata definitivamente: l’utente non potrà più accedere e le sue programmazioni non verranno più eseguite. Potrai ricrearla con la stessa email. Per bloccarla temporaneamente usa invece la spunta Abilitato.</p><div class="account-actions"><button id="accountRemoveCancel" class="secondary-button">Annulla</button><button id="accountRemoveConfirm" class="primary-button">Rimuovi</button></div></dialog>`;
  document.body.append(page);
  $('accountBack').onclick=()=>navigateAdmin(false);
  $('accountNew').onclick=()=>editAccount();
  $('accountEditorCancel').onclick=()=>$('accountEditor').close();
  $('accountLogoRemove').onclick=()=>{$('accountLogo').value='';$('accountLogo').setCustomValidity('');setLogo('');};
  $('accountLogo').onchange=async()=>{
   const file=$('accountLogo').files[0];
   if(!file)return;
   const input=$('accountLogo');
   input.setCustomValidity('Attendi il caricamento del logo.');
   $('accountEditorMessage').textContent='';
   try{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5000000)throw Error('Scegli un logo PNG, JPEG o WebP di massimo 5 MB.');
    const image=await createImageBitmap(file);
    try{
     const canvas=document.createElement('canvas'),scale=Math.min(1,160/Math.max(image.width,image.height));
     canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
     canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
     if(input.files[0]===file){setLogo(canvas.toDataURL('image/png'));input.setCustomValidity('');}
    }finally{image.close();}
   }catch(e){if(input.files[0]===file){input.value='';input.setCustomValidity('');$('accountEditorMessage').textContent=e.message;}}
  };
  $('accountInvite').onsubmit=async event=>{
   event.preventDefault();
   const editor=$('accountEditor');
   const button=editor.querySelector('button[type=submit],button:not([type])');
   button.disabled=true;
   const body={name:$('accountInviteName').value,logo:editorLogo};
   if(editing)Object.assign(body,{op:'edit',id:editing.id});
   else Object.assign(body,{op:'invite',email:$('accountInviteEmail').value,enabled:$('accountEnabled').checked});
   try{await request('/api/app/accounts',body);editor.close();await openAdmin();}
   catch(e){$('accountEditorMessage').textContent=e.message;}
   finally{button.disabled=false;}
  };
  $('accountRemoveCancel').onclick=()=>$('accountRemove').close();
  $('accountList').onclick=e=>{
   const control=e.target.closest('[data-account-op]');
   if(!control)return;
   const {accountOp:op,accountId:id}=control.dataset;
   if(op==='edit'){editAccount(accounts.find(a=>a.id===id));return;}
   if(op==='delete'){
    $('accountRemoveConfirm').onclick=()=>{$('accountRemove').close();void adminMutation({op,id});};
    $('accountRemove').showModal();return;
   }
   if(op==='toggle')return void adminMutation({op:control.checked?'approve':'block',id});
   void adminMutation({op,id},'dashboard');
  };
  void openAdmin();
 }
 let accounts=[],editing,editorLogo='',adminBusy=false;
 function setLogo(logo){
  editorLogo=logo;
  const preview=$('accountLogoPreview');
  if(logo)preview.src=logo;else preview.removeAttribute('src');
  preview.hidden=!logo;$('accountLogoRemove').hidden=!logo;
 }
 function editAccount(account){
  editing=account;
  $('accountInvite').reset();
  $('accountLogo').setCustomValidity('');
  $('accountEditorTitle').textContent=account?'Modifica plancia':'Nuova plancia';
  $('accountInviteName').value=account?.name||'';
  $('accountEmailField').hidden=Boolean(account);$('accountInviteEmail').required=!account;
  $('accountEnabledField').hidden=Boolean(account);$('accountEnabled').checked=true;
  $('accountEditorMessage').textContent='';
  setLogo(account?.logo||'');
  $('accountEditor').showModal();
 }
 async function openAdmin(){
  const message=$('accountAdminMessage');
  message.textContent='Caricamento account…';
  try{
   const data=await request('/api/app/accounts');
   accounts=data.accounts;
   $('accountList').innerHTML=accounts.map(a=>`<article class="account-row"><div>${a.logo?`<img class="account-row-logo" src="${esc(a.logo)}" alt="">`:''}<h2>${esc(a.name)}</h2>${a.person&&a.person!==a.name?`<p>${esc(a.person)}</p>`:''}<p>${esc(a.email)}</p><span class="account-badge">${esc({active:'Ammesso',pending:'In attesa',blocked:'Disattivata',deleted:'Archiviata'}[a.status]||a.status)}</span><span>${a.linked?'eWeLink collegato':'eWeLink da collegare'}</span></div><div class="account-actions"><label class="account-enabled"><input type="checkbox" data-account-op="toggle" data-account-id="${a.id}" ${a.status==='active'?'checked':''} ${a.id===state.actor.id?'disabled':''}> Abilitato</label><button class="secondary-button" data-account-op="enter" data-account-id="${a.id}">Apri plancia</button><button class="secondary-button" data-account-op="edit" data-account-id="${a.id}">Modifica</button>${a.id!==state.actor.id?`<button class="secondary-button" data-account-op="delete" data-account-id="${a.id}">Rimuovi</button>`:''}</div></article>`).join('');
   message.textContent=accounts.length+' account';
  }catch(e){message.textContent=e.message;}
 }
 async function adminMutation(body,destination){
  if(adminBusy)return;
  adminBusy=true;
  const list=$('accountList');
  if(list)list.inert=true;
  try{
   await request('/api/app/accounts',body);
   if(destination){navigateAdmin(destination==='accounts');return;}
   await openAdmin();
  }catch(e){
   if(list){await openAdmin();$('accountAdminMessage').textContent=e.message;}
   else message(e.message);
  }finally{adminBusy=false;if(list)list.inert=false;}
 }
 async function logout(){try{await request('/api/app/logout',{});if(fbAuth)await (await sdk()).signOut(fbAuth);location.reload();}catch(e){alert('Uscita non confermata: '+e.message);}}
 async function bootstrap(url){
  base=url;
  try{
   config=await request('/api/app/config');if(!config.enabled)return true;
   state.enabled=true;mount();
   let sessionError='';
   try{
    const current=await request('/api/app/session');
    if(current.authenticated!==false){if(accepted(current))return true;return ready;}
   }catch(e){
    if(e.code!=='app_auth_required')sessionError=e.message;
   }
   const a=await sdk();
   const redirected=await a.getRedirectResult(fbAuth);
   await fbAuth.authStateReady();
   if(redirected){
    $('accountRemember').checked=sessionStorage.getItem('ewelink_auth_remember')==='yes';
    sessionStorage.removeItem('ewelink_auth_remember');
    await exchange(redirected.user);
   }else if(fbAuth.currentUser){
    $('accountRemember').checked=true;
    await exchange(fbAuth.currentUser,{renew:true});
   }else gate(sessionError);
   return ready;
  }catch(e){
   // Non aprire la plancia con il controllo account indisponibile.
   if(!$('accountGate'))mount();state.enabled=true;gate('Accesso non disponibile: '+translate(e));return ready;
  }
 }
 window.AppAccounts={state,bootstrap,logout,openPage:()=>{
  if(!adminPage||!state.enabled)return false;
  if(!state.adminDesktop){navigateAdmin(false);return true;}
  document.title="Gestione account · "+state.actor.name;
  if(typeof window.finishStartup==="function")window.finishStartup();
  showAdmin();return true;
 },headers:()=>state.enabled?{'X-App-CSRF':state.csrf,'X-App-Account':state.account?.id||''}:{},handleError:d=>{if(state.enabled&&['app_auth_required','app_blocked','app_pending','app_actas_expired','app_context_changed'].includes(d?.error)){gate(d.msg);return true;}return false;}};
})();
