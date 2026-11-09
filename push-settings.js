/* Notifiche push: attivabili su ogni dispositivo da Menu > Impostazioni app.
   Il server avvisa i dispositivi iscritti quando una programmazione viene eseguita. */
(()=>{
 'use strict';
 const supported=()=>'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 const isIos=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 let section=null,busy=false;
 const $=id=>document.getElementById(id);

 function label(){
  const ua=navigator.userAgent;
  const device=/iPad/.test(ua)?'iPad':/iPhone/.test(ua)?'iPhone':/Android/.test(ua)?(/Mobile/.test(ua)?'Telefono Android':'Tablet Android'):/Mac/.test(ua)?'Mac':/Windows/.test(ua)?'PC Windows':'Dispositivo';
  return device+' · '+new Date().toLocaleDateString('it-IT');
 }
 function urlBase64ToUint8Array(base64){const padding='='.repeat((4-base64.length%4)%4),raw=atob((base64+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
 async function registration(){const reg=await Promise.race([navigator.serviceWorker.ready,new Promise(r=>setTimeout(()=>r(null),4000))]);if(!reg)throw new Error('App non ancora pronta per le notifiche: chiudila, riaprila e riprova.');return reg;}
 async function currentSubscription(){if(!supported())return null;try{return await (await registration()).pushManager.getSubscription();}catch{return null;}}
 function setStatus(text,kind){const el=$('pushStatus');if(!el)return;el.textContent=text;el.dataset.kind=kind||'';}
 function call(path,body){if(typeof apiRequest!=='function')throw new Error('App non pronta.');return apiRequest(path,body);}

 async function refresh(){
  if(!section)return;
  const toggle=$('pushEnabled'),test=$('pushTest');
  if(!supported()){
   toggle.disabled=true;toggle.checked=false;test.hidden=true;
   setStatus(isIos&&!standalone()?'Su iPhone e iPad le notifiche funzionano solo dall’app installata: tocca Condividi → “Aggiungi alla schermata Home”, poi apri l’app dall’icona e torna qui.':'Questo browser non supporta le notifiche push.','warn');
   return;
  }
  const sub=await currentSubscription(),permission=Notification.permission;if(busy)return;
  toggle.disabled=busy;toggle.checked=Boolean(sub)&&permission==='granted';test.hidden=!toggle.checked;
  if(permission==='denied')setStatus('Le notifiche sono bloccate per questa app. Riattivale dalle impostazioni del telefono (Notifiche) e poi torna qui.','warn');
  else if(toggle.checked)setStatus('Attive su questo dispositivo: ricevi un avviso quando una programmazione viene eseguita o non riesce.','ok');
  else setStatus('Disattivate su questo dispositivo. Ogni telefono o tablet si attiva separatamente.','');
 }

 async function enable(){
  const permission=await Notification.requestPermission();
  if(permission!=='granted')throw new Error(permission==='denied'?'Permesso negato: riattiva le notifiche dalle impostazioni del telefono.':'Permesso non concesso.');
  const reg=await registration(),{publicKey}=await call('/api/push/key');
  let sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(publicKey)});
  await call('/api/push/subscribe',{subscription:sub.toJSON(),label:label()});
 }
 async function disable(){
  const sub=await currentSubscription();if(!sub)return;
  try{await call('/api/push/unsubscribe',{endpoint:sub.endpoint});}finally{await sub.unsubscribe().catch(()=>{});}
 }

 function build(){
  const content=document.querySelector('#textSizeSettings .text-size-content');if(!content)return;
  section=document.createElement('section');section.className='push-settings';section.setAttribute('aria-labelledby','pushSettingsTitle');
  section.innerHTML=`<h3 id="pushSettingsTitle">Notifiche</h3>
   <label class="menu-bar-toggle"><input id="pushEnabled" type="checkbox"><span>Avvisami quando viene eseguito un programma</span></label>
   <p id="pushStatus" class="text-size-status" role="status"></p>
   <button id="pushTest" type="button" hidden>Invia notifica di prova</button>`;
  const menuBar=content.querySelector('.menu-bar-settings'),sizeTitle=[...content.querySelectorAll('h3')].find(h=>/Dimensione/i.test(h.textContent));
  content.insertBefore(section,menuBar||sizeTitle||null);
  $('pushEnabled').addEventListener('change',async e=>{
   const on=e.target.checked;if(busy)return;busy=true;e.target.disabled=true;setStatus(on?'Attivazione in corso…':'Disattivazione in corso…','');
   try{if(on)await enable();else await disable();busy=false;await refresh();if(on)setStatus('Notifiche attivate su questo dispositivo. Prova con “Invia notifica di prova”.','ok');}
   catch(error){busy=false;await refresh();setStatus(error.message||'Operazione non riuscita.','warn');}
  });
  $('pushTest').addEventListener('click',async e=>{
   const button=e.currentTarget;button.disabled=true;setStatus('Invio della notifica di prova…','');
   try{const sub=await currentSubscription();if(!sub)throw new Error('Questo dispositivo non è iscritto.');await call('/api/push/test',{endpoint:sub.endpoint});setStatus('Notifica di prova inviata: dovrebbe arrivare tra pochi secondi.','ok');}
   catch(error){setStatus(error.message||'Invio non riuscito.','warn');}
   finally{button.disabled=false;}
  });
  $('textSizeSettings')?.addEventListener('toggle',()=>{if($('textSizeSettings').open)void refresh();});
  void refresh();
 }
 document.addEventListener('DOMContentLoaded',build);
})();
