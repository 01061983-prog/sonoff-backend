/* Notifiche push: attivabili su ogni dispositivo da Menu > Impostazioni app.
   Il server avvisa i dispositivi iscritti quando una programmazione viene eseguita. */
(()=>{
 'use strict';
 const supported=()=>'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 const isIos=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 let section=null,busy=false,appReady=false,refreshEpoch=0,refreshJob=null,lastRefresh=0;
 const remembered=new Map();
 const preferenceKey=()=>{const s=window.AppAccounts?.state;return 'pace_push_preference_v1:'+String(s?.account?.id||'legacy')+':'+String(s?.selectedProvider||'legacy');};
 function preference(key=preferenceKey()){try{const v=localStorage.getItem(key);if(v==='enabled'||v==='disabled')return v;}catch{}return remembered.get(key)||null;}
 function remember(value,key=preferenceKey()){remembered.set(key,value);try{localStorage.setItem(key,value);}catch{}}
 const $=id=>document.getElementById(id);

 function label(){
  const ua=navigator.userAgent;
  const device=/iPad/.test(ua)?'iPad':/iPhone/.test(ua)?'iPhone':/Android/.test(ua)?(/Mobile/.test(ua)?'Telefono Android':'Tablet Android'):/Mac/.test(ua)?'Mac':/Windows/.test(ua)?'PC Windows':'Dispositivo';
  return device+' · '+new Date().toLocaleDateString('it-IT');
 }
 function urlBase64ToUint8Array(base64){const padding='='.repeat((4-base64.length%4)%4),raw=atob((base64+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
 async function registration(){const reg=await Promise.race([navigator.serviceWorker.ready,new Promise(r=>setTimeout(()=>r(null),4000))]);if(!reg)throw new Error('App non ancora pronta per le notifiche: chiudila, riaprila e riprova.');return reg;}
 async function currentSubscription(){if(!supported())return null;return (await registration()).pushManager.getSubscription();}
 function setStatus(text,kind){const el=$('pushStatus');if(!el)return;el.textContent=text;el.dataset.kind=kind||'';}
 function call(path,body){if(typeof apiRequest!=='function')throw new Error('App non pronta.');return apiRequest(path,body);}

 async function update(){
  if(!section)return;
  const toggle=$('pushEnabled'),test=$('pushTest'),epoch=++refreshEpoch,key=preferenceKey(),desired=preference(key);
  if(desired!==null)toggle.checked=desired==='enabled';
  test.hidden=true;$('pushTestLocked').hidden=true;$('pushRetry').hidden=true;
  if(!appReady){toggle.disabled=true;setStatus('Attendo l’accesso alla plancia…','');return;}
  if(!supported()){
   toggle.disabled=true;toggle.checked=false;test.hidden=true;
   setStatus(isIos&&!standalone()?'Su iPhone e iPad le notifiche funzionano solo dall’app installata: tocca Condividi → “Aggiungi alla schermata Home”, poi apri l’app dall’icona e torna qui.':'Questo browser non supporta le notifiche push.','warn');
   return;
  }
  toggle.disabled=true;
  try{
   let sub=await currentSubscription();const permission=Notification.permission;
   let status=sub&&permission==='granted'?await call('/api/push/status',{endpoint:sub.endpoint}):{subscribed:false};
   if(key!==preferenceKey())return;
   if(permission==='granted'&&desired==='enabled'&&!status.subscribed){sub=await enable(true);status={subscribed:true};}
   else if(permission==='granted'&&desired==='disabled'&&status.subscribed){await call('/api/push/unsubscribe',{endpoint:sub.endpoint});status={subscribed:false};}
   if(status.subscribed)remember('enabled',key);
   if(busy||epoch!==refreshEpoch||key!==preferenceKey())return;
   toggle.disabled=false;toggle.checked=Boolean(sub)&&permission==='granted'&&status.subscribed;test.hidden=!toggle.checked;$('pushTestLocked').hidden=!toggle.checked;
   const name=window.AppAccounts?.state.selectedProviderLabel||'questo account eWeLink';
   if(permission==='denied')setStatus('Le notifiche sono bloccate per questa app. Riattivale dalle impostazioni del telefono, poi torna qui.','warn');
   else if(toggle.checked)setStatus('Notifiche attive per '+name+' su questo dispositivo. Restano attive anche quando passi a un altro account.','ok');
   else if(desired==='enabled')setStatus('La scelta per '+name+' è conservata. Riattiva il permesso notifiche per questa app dal telefono, poi riprova.','warn');
   else setStatus('Notifiche disattivate per '+name+'. Puoi attivarle qui senza modificare gli altri account.','');
  }catch(error){
   if(epoch!==refreshEpoch||busy||key!==preferenceKey())return;
   toggle.disabled=true;test.hidden=true;$('pushRetry').hidden=false;
   setStatus('Impossibile verificare le notifiche di questo account. Le iscrizioni sono state conservate. '+(error.message||''),'warn');
  }
 }

 function refresh(force=true){
  if(busy)return Promise.resolve();if(refreshJob)return refreshJob;if(!force&&Date.now()-lastRefresh<20000)return Promise.resolve();
  lastRefresh=Date.now();const key=preferenceKey();refreshJob=update().finally(()=>{refreshJob=null;if(appReady&&key!==preferenceKey())void refresh();});return refreshJob;
 }
 async function enable(automatic=false){
  if(automatic&&Notification.permission!=='granted')throw new Error('Il telefono deve autorizzare le notifiche per questa app.');
  const key=preferenceKey(),permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();
  if(permission!=='granted')throw new Error(permission==='denied'?'Permesso negato: riattiva le notifiche dalle impostazioni del telefono.':'Permesso non concesso.');
  const reg=await registration(),{publicKey}=await call('/api/push/key');
  let sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(publicKey)});
  if(key!==preferenceKey())throw new Error('Account cambiato: riapri le impostazioni notifiche.');
  await call('/api/push/subscribe',{subscription:sub.toJSON(),label:label()});remember('enabled',key);return sub;
 }
 async function disable(){
  const key=preferenceKey(),sub=await currentSubscription();
  // The native subscription belongs to the installation and can serve other accounts.
  // Remove only this owner's server association; do not unsubscribe the browser.
  if(key!==preferenceKey())throw new Error('Account cambiato: riapri le impostazioni notifiche.');
  if(sub)await call('/api/push/unsubscribe',{endpoint:sub.endpoint});remember('disabled',key);
 }

 function build(){
  const content=document.querySelector('#textSizeSettings .text-size-content');if(!content)return;
  section=document.createElement('section');section.className='push-settings';section.setAttribute('aria-labelledby','pushSettingsTitle');
  section.innerHTML=`<h3 id="pushSettingsTitle">Notifiche</h3>
   <label class="menu-bar-toggle"><input id="pushEnabled" type="checkbox"><span>Avvisami per questo account eWeLink</span></label>
   <p id="pushStatus" class="text-size-status" role="status"></p>
   <button id="pushTest" type="button" hidden>Invia notifica di prova</button><button id="pushTestLocked" type="button" hidden>Prova a schermo bloccato · 20 secondi</button><button id="pushRetry" type="button" hidden>Verifica stato notifiche</button>`;
  if(/Android/i.test(navigator.userAgent)){
   const help=document.createElement('details');help.className='push-android-help';help.innerHTML='<summary>Notifiche sul tablet bloccato</summary><p>Se arrivano soltanto quando sblocchi lo schermo, controlla queste impostazioni di Android. I nomi possono cambiare in base al tablet.</p><ol><li>Impostazioni → Notifiche → Schermata di blocco: consenti la visualizzazione delle notifiche.</li><li>Impostazioni → App → PACE (oppure Chrome, se usi il browser) → Notifiche: consenti le notifiche. In Chrome verifica anche le notifiche del sito PACE.</li><li>Impostazioni → App → PACE o Chrome → Batteria: consenti l’attività in background e, se disponibile, scegli Senza restrizioni. Controlla anche Risparmio energetico e Non disturbare.</li></ol><p>Usa “Prova a schermo bloccato”: dopo il messaggio di conferma, blocca il tablet e attendi. Se il server si riavvia durante i 20 secondi, ripeti la prova.</p><p>La webapp non può cambiare queste impostazioni di Android.</p>';section.append(help);
  }
  const menuBar=content.querySelector('.menu-bar-settings'),sizeTitle=[...content.querySelectorAll('h3')].find(h=>/Dimensione/i.test(h.textContent));
  content.insertBefore(section,menuBar||sizeTitle||null);
  $('pushEnabled').addEventListener('change',async e=>{
   const on=e.target.checked;if(busy)return;busy=true;e.target.disabled=true;setStatus(on?'Attivazione in corso…':'Disattivazione in corso…','');
   try{if(on)await enable();else await disable();busy=false;await refresh();if(on)setStatus('Notifiche attivate per questo account. Gli altri collegamenti restano invariati. Prova con “Invia notifica di prova”.','ok');}
   catch(error){busy=false;await refresh();setStatus(error.message||'Operazione non riuscita.','warn');}
  });
  async function testNotification(button,delaySeconds){
   button.disabled=true;setStatus('Invio della notifica di prova…','');
   try{const sub=await currentSubscription();if(!sub)throw new Error('Questo dispositivo non è iscritto.');await call('/api/push/test',{endpoint:sub.endpoint,delaySeconds});setStatus(delaySeconds?'Prova programmata: blocca adesso lo schermo e attendi 20 secondi.':'Il servizio push ha accettato la prova. Controlla le notifiche del dispositivo.','ok');}
   catch(error){await refresh();setStatus(error.message||'Invio non riuscito.','warn');}
   finally{button.disabled=false;}
  }
  $('pushTest').addEventListener('click',e=>void testNotification(e.currentTarget,0));
  $('pushTestLocked').addEventListener('click',e=>void testNotification(e.currentTarget,20));
  $('textSizeSettings')?.addEventListener('toggle',()=>{if($('textSizeSettings').open)void refresh();});
  $('pushRetry').addEventListener('click',()=>void refresh());
  if(appReady)void refresh();
 }
 const resume=()=>{if(appReady&&document.visibilityState!=='hidden')void refresh(false);};
 for(const event of ['pageshow','focus'])window.addEventListener?.(event,resume);
 window.addEventListener?.('online',()=>{if(appReady)void refresh();});
 window.addEventListener?.('storage',event=>{if(event.key===preferenceKey()&&appReady)void refresh();});
 document.addEventListener('visibilitychange',resume);
 window.PushSettings={accountReady(){appReady=true;void refresh();}};
 document.addEventListener('DOMContentLoaded',build);
})();
