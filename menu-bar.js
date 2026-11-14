/* Barra menu in basso, personalizzabile. Si salva solo su questo dispositivo
   (per account): ogni telefono o tablet può avere una barra diversa. */
(()=>{
 'use strict';
 const MAX_ITEMS=5;
 const PAGES={
  scenes:{label:'Scenari',icon:'layers'},
  rooms:{label:'Stanze',icon:'building'},
  devices:{label:'Dispositivi',icon:'bulb'},
  programming:{label:'Programmazione',short:'Programmi',icon:'calendar'},
 climate:{label:'Clima',icon:'thermo'},
  home:{label:'Panoramica',icon:'grid'},
  install:{label:'La tua webapp',short:'Webapp',icon:'download'}
 };
 const DEFAULT_CONFIG={enabled:true,items:[{type:'view',id:'scenes'},{type:'view',id:'rooms'},{type:'view',id:'devices'},{type:'view',id:'programming'}]};
 let config=null,configKey=null,bar=null,settings=null,lastBarSignature='',lastSettingsSignature='';

 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const svg=name=>typeof icon==='function'?icon(name):'';
 const accountId=()=>window.AppAccounts?.state?.account?.id||'local';
 const storageKey=()=>'ewelink_menu_bar_v1:'+accountId()+(window.AppAccounts?.state?.selectedProvider&&window.AppAccounts.state.selectedProvider!==window.AppAccounts.state.primaryProvider?':'+window.AppAccounts.state.selectedProvider:'');

 function validItem(item){return item&&['view','scene','room'].includes(item.type)&&typeof item.id==='string'&&item.id&&(item.type!=='view'||PAGES[item.id]);}
 function normalize(raw){
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.items))return structuredClone(DEFAULT_CONFIG);
  const seen=new Set(),items=[];
  for(const item of raw.items){if(!validItem(item))continue;const key=item.type+':'+item.id;if(seen.has(key))continue;seen.add(key);items.push({type:item.type,id:item.id,...(typeof item.label==='string'?{label:item.label.slice(0,60)}:{})});if(items.length>=MAX_ITEMS)break;}
  return {enabled:raw.enabled!==false,items};
 }
 function load(){
  const key=storageKey();if(config&&key===configKey)return config;
  configKey=key;
  try{const raw=localStorage.getItem(key);config=normalize(raw===null?DEFAULT_CONFIG:JSON.parse(raw));}
  catch{config=structuredClone(DEFAULT_CONFIG);}
  return config;
 }
 function save(statusText){
  let text=statusText;
  try{localStorage.setItem(configKey,JSON.stringify(config));}
  catch{text='Questo browser non permette di salvare la barra: alla riapertura potrebbe tornare quella predefinita.';}
  refresh(true);setStatus(text);
 }
 function setStatus(text){const el=document.getElementById('menuBarStatus');if(el&&text)el.textContent=text;}

 // Dati dell'app (definiti nello script principale)
 function scenes(){try{return typeof loadUserScenes==='function'?loadUserScenes():[];}catch{return [];}}
 function rooms(){try{return typeof cloudRooms!=='undefined'&&Array.isArray(cloudRooms)?cloudRooms:[];}catch{return [];}}
 function scenesReady(){try{return typeof cloudScenes!=='undefined'&&Array.isArray(cloudScenes);}catch{return false;}}
 function sceneRunning(id){
  try{if(typeof localRunningScene!=='undefined'&&localRunningScene===id)return true;}catch{}
  try{return typeof cloudExecutions!=='undefined'&&cloudExecutions?.[id]?.status==='running';}catch{return false;}
 }
 function sceneIcon(scene){return scene?.actions?.length&&scene.actions.every(a=>a.kind==='gate'||a.pulse===true)?'gate':'sun';}

 function describe(item){
  if(item.type==='view')return {...PAGES[item.id],available:true};
  if(item.type==='scene'){const scene=scenes().find(s=>s.id===item.id);if(scene)item.label=scene.name;return {label:scene?.name||item.label||'Scenario',icon:sceneIcon(scene),available:Boolean(scene)||!scenesReady(),missing:!scene&&scenesReady()};}
  const room=rooms().find(r=>r.id===item.id);if(room)item.label=room.name;
  return {label:room?.name||item.label||'Stanza',icon:'building',available:Boolean(room)||!scenesReady(),missing:!room&&scenesReady()};
 }
 function isActive(item){
  const view=document.body.dataset.view,room=document.getElementById('roomsView')?.dataset.room||'';
  if(item.type==='view')return view===item.id&&!(item.id==='rooms'&&room&&config.items.some(i=>i.type==='room'&&i.id===room));
  if(item.type==='room')return view==='rooms'&&room===item.id;
  return false;
 }

 function activate(index){
  const item=config.items[index];if(!item)return;
  if(item.type==='view'){
   if(item.id==='scenes'&&typeof showScenarioBoard==='function')showScenarioBoard();
   else if(item.id==='rooms'&&typeof openRooms==='function')openRooms();
   else if(typeof setView==='function')setView(item.id);
  }else if(item.type==='room'){if(typeof openRoom==='function')openRoom(item.id);}
  else if(typeof runUserScene==='function')void runUserScene(item.id);
  refresh(true);
 }

 function renderBar(force){
  load();
  const visible=config.enabled&&config.items.length>0;
  const parts=config.items.map((item,i)=>{const d=describe(item);return [item.type,item.id,d.label,d.icon,d.available,isActive(item),item.type==='scene'&&sceneRunning(item.id),i].join('|');});
  const signature=visible+'#'+parts.join('#');
  document.body.classList.toggle('has-menu-bar',visible);
  if(!force&&signature===lastBarSignature)return;lastBarSignature=signature;
  bar.hidden=!visible;
  bar.style.setProperty('--menu-bar-count',String(Math.max(1,config.items.length)));
  bar.innerHTML=config.items.map((item,i)=>{
   const d=describe(item),active=isActive(item),running=item.type==='scene'&&sceneRunning(item.id);
   const kind=item.type==='scene'?'Esegui scenario: ':item.type==='room'?'Apri stanza: ':'';
   return `<button type="button" class="menu-bar-item${active?' active':''}${running?' running':''}${item.type==='scene'?' is-scene':''}" data-index="${i}" ${d.available?'':'disabled'} ${active?'aria-current="page"':''} aria-busy="${running}" aria-label="${esc(kind+d.label+(d.missing?' (non più disponibile)':''))}"><span class="menu-bar-icon">${svg(d.icon)}</span><span class="menu-bar-label">${esc(d.short||d.label)}</span></button>`;
  }).join('');
 }

 function optionsHtml(){
  const used=new Set(config.items.map(i=>i.type+':'+i.id)),group=(label,list)=>list.length?`<optgroup label="${esc(label)}">${list.join('')}</optgroup>`:'';
  const opt=(type,id,label)=>used.has(type+':'+id)?'':`<option value="${esc(type+':'+id)}">${esc(label)}</option>`;
  return '<option value="">Scegli cosa aggiungere…</option>'
   +group('Pagine',Object.entries(PAGES).map(([id,p])=>opt('view',id,p.label)).filter(Boolean))
   +group('Scenari (eseguono subito)',scenes().map(s=>opt('scene',s.id,s.name)).filter(Boolean))
   +group('Stanze',rooms().map(r=>opt('room',r.id,r.name)).filter(Boolean));
 }
 function renderSettings(force){
  if(!settings)return;load();
  const signature=JSON.stringify(config)+'|'+scenes().map(s=>s.id+s.name).join()+'|'+rooms().map(r=>r.id+r.name).join();
  if(!force&&signature===lastSettingsSignature)return;lastSettingsSignature=signature;
  const focusedId=document.activeElement?.id,focusedAction=document.activeElement?.dataset?.menuAction,focusedIndex=document.activeElement?.dataset?.index;
  settings.querySelector('#menuBarEnabled').checked=config.enabled;
  const typeLabel={view:'Pagina',scene:'Scenario',room:'Stanza'};
  const list=settings.querySelector('#menuBarItems'),last=config.items.length-1;
  list.innerHTML=config.items.length?config.items.map((item,i)=>{const d=describe(item);return `<li class="menu-bar-setting-item${d.missing?' missing':''}"><span class="menu-bar-setting-icon">${svg(d.icon)}</span><span class="menu-bar-setting-name">${esc(d.label)}<small>${typeLabel[item.type]}${d.missing?' · non più disponibile':''}</small></span><span class="menu-bar-setting-actions"><button type="button" data-menu-action="up" data-index="${i}" ${i===0?'disabled':''} aria-label="Sposta ${esc(d.label)} a sinistra">←</button><button type="button" data-menu-action="down" data-index="${i}" ${i===last?'disabled':''} aria-label="Sposta ${esc(d.label)} a destra">→</button><button type="button" data-menu-action="remove" data-index="${i}" class="menu-bar-remove" aria-label="Togli ${esc(d.label)} dalla barra">✕</button></span></li>`;}).join(''):'<li class="menu-bar-empty">Nessuna voce. Aggiungine una qui sotto.</li>';
  const select=settings.querySelector('#menuBarAddSelect'),full=config.items.length>=MAX_ITEMS;
  select.innerHTML=optionsHtml();select.disabled=full;settings.querySelector('#menuBarAddBtn').disabled=true;
  settings.querySelector('#menuBarLimit').textContent=full?`Hai raggiunto il massimo di ${MAX_ITEMS} voci: togline una per aggiungerne un’altra.`:`${config.items.length} di ${MAX_ITEMS} voci.`;
  if(focusedAction){const again=settings.querySelector(`[data-menu-action="${focusedAction}"][data-index="${focusedIndex}"]:not([disabled])`)||settings.querySelector('#menuBarAddSelect');again?.focus();}
  else if(focusedId&&settings.contains(document.getElementById(focusedId)))document.getElementById(focusedId).focus();
 }

 function buildSettings(){
  const content=document.querySelector('#textSizeSettings .text-size-content');if(!content)return;
  settings=document.createElement('section');settings.className='menu-bar-settings';settings.setAttribute('aria-labelledby','menuBarSettingsTitle');
  settings.innerHTML=`<h3 id="menuBarSettingsTitle">Gestione barra menu</h3>
   <label class="menu-bar-toggle"><input id="menuBarEnabled" type="checkbox"><span>Mostra la barra in basso</span></label>
   <p class="text-size-status">Le voci restano sempre in vista in fondo allo schermo. Uno scenario nella barra si esegue con un tocco.</p>
   <ol id="menuBarItems" class="menu-bar-setting-list" aria-label="Voci della barra, da sinistra a destra"></ol>
   <div class="menu-bar-add"><label for="menuBarAddSelect" class="visually-hidden">Voce da aggiungere</label><select id="menuBarAddSelect"></select><button id="menuBarAddBtn" type="button" class="secondary-button">Aggiungi</button></div>
   <p id="menuBarLimit" class="text-size-status"></p>
   <button id="menuBarReset" type="button">Ripristina barra predefinita</button>
   <p id="menuBarStatus" class="text-size-status" role="status">La barra si salva solo su questo dispositivo: ogni telefono o tablet collegato all’account può averne una diversa.</p>`;
  const sizeTitle=[...content.querySelectorAll('h3')].find(h=>/Dimensione/i.test(h.textContent));
  content.insertBefore(settings,sizeTitle||null);
  settings.querySelector('#menuBarEnabled').addEventListener('change',e=>{config.enabled=e.target.checked;save(config.enabled?'Barra attivata su questo dispositivo.':'Barra disattivata su questo dispositivo.');});
  const select=settings.querySelector('#menuBarAddSelect'),addBtn=settings.querySelector('#menuBarAddBtn');
  select.addEventListener('change',()=>{addBtn.disabled=!select.value;});
  addBtn.addEventListener('click',()=>{
   const [type,...rest]=select.value.split(':'),id=rest.join(':'),item={type,id};
   if(!validItem(item)||config.items.length>=MAX_ITEMS)return;
   const label=describe(item).label;config.items.push(item);save(`${label} aggiunto alla barra.`);select.focus();
  });
  settings.querySelector('#menuBarItems').addEventListener('click',e=>{
   const button=e.target.closest('[data-menu-action]');if(!button)return;
   const i=Number(button.dataset.index),items=config.items,label=describe(items[i]).label;
   if(button.dataset.menuAction==='remove'){items.splice(i,1);save(`${label} tolto dalla barra.`);}
   else{const j=button.dataset.menuAction==='up'?i-1:i+1;if(j<0||j>=items.length)return;[items[i],items[j]]=[items[j],items[i]];save(`${label} spostato.`);}
  });
  settings.querySelector('#menuBarReset').addEventListener('click',()=>{config=structuredClone(DEFAULT_CONFIG);save('Barra predefinita ripristinata.');});
 }

 function refresh(force){if(!bar)return;const key=storageKey();if(key!==configKey){config=null;force=true;}renderBar(force);renderSettings(force);}
 let queued=false;
 function schedule(){if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;refresh(false);});}}

 document.addEventListener('DOMContentLoaded',()=>{
  bar=document.createElement('nav');bar.id='menuBar';bar.className='menu-bar';bar.setAttribute('aria-label','Barra menu');bar.hidden=true;
  document.body.appendChild(bar);
  bar.addEventListener('click',e=>{const b=e.target.closest('.menu-bar-item');if(b&&!b.disabled)activate(Number(b.dataset.index));});
  buildSettings();
  new MutationObserver(schedule).observe(document.body,{attributes:true,attributeFilter:['data-view']});
  const roomsView=document.getElementById('roomsView');if(roomsView)new MutationObserver(schedule).observe(roomsView,{attributes:true,attributeFilter:['data-room']});
  document.getElementById('navigationDialog')?.addEventListener('toggle',schedule);
  document.getElementById('menuBtn')?.addEventListener('click',()=>refresh(false));
  window.addEventListener('storage',e=>{if(e.key===configKey||e.key===null){config=null;refresh(true);}});
  refresh(true);
 });
 window.MenuBar={refresh:()=>schedule()};
})();
