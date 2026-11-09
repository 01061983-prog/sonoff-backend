/* Pagina Clima: split Daikin tramite il backend (/api/daikin/*).
   Limite Daikin: 200 richieste al giorno, quindi niente aggiornamenti continui. */
(()=>{
 'use strict';
 const LABELS={
  operationMode:{auto:'Automatico',cooling:'Raffreddamento',heating:'Riscaldamento',fanOnly:'Solo ventilazione',dry:'Deumidificazione',heatingDay:'Riscaldamento giorno',heatingNight:'Riscaldamento notte',humidification:'Umidificazione',off:'Spento'},
  fanSpeed:{auto:'Auto',quiet:'Silenzioso',fixed:'Manuale'},
  direction:{stop:'Fisso',swing:'Oscillazione',windNice:'Comfort',floorHeatingAirflow:'Verso il pavimento'},
  toggles:{powerfulMode:'Powerful',econoMode:'Econo',streamerMode:'Streamer (purificazione)',outdoorSilentMode:'Unità esterna silenziosa',isPowerfulModeActive:'Powerful attivo'},
  demand:{off:'Disattivato',auto:'Automatico',fixed:'Limite fisso',scheduled:'Programmato'},
  period:{monday:'Lunedì',tuesday:'Martedì',wednesday:'Mercoledì',thursday:'Giovedì',friday:'Venerdì',saturday:'Sabato',sunday:'Domenica',weekdays:'Feriali',weekend:'Fine settimana'}
 };
 const MODE_ICON={auto:'A',cooling:'❄',heating:'☀',fanOnly:'≋',dry:'💧'};
 const HANDLED=new Set(['onOffMode','operationMode','name','temperatureControl','fanControl','sensoryData','schedule','holidayMode','consumptionData','demandControl','blockScheduleV2']);
 const state={flash:null,status:null,data:null,busy:false,loading:false,open:new Set(),pendingTemp:new Map(),editing:null,lastLoad:0};
 const timers=new Map();
 let content,statusEl,refreshBtn;

 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const label=(group,v)=>LABELS[group]?.[v]||String(v).replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase());
 const num=v=>Number.isFinite(v)?(Math.round(v*10)/10).toLocaleString('it-IT'):'—';
 const base=()=>typeof BACKEND_URL!=='undefined'?BACKEND_URL:location.origin;
 const req=(path,body)=>apiRequest(path,body);
 function say(text,error){for(const el of [statusEl]){if(!el)continue;el.textContent=text||'';el.classList.toggle('error',Boolean(error));}}

 function units(){
  const list=[];
  for(const gw of state.data?.devices||[]){
   for(const mp of gw.managementPoints||[]){
    if(mp.managementPointType!=='climateControl')continue;
    const gwInfo=(gw.managementPoints||[]).find(p=>p.managementPointType==='gateway');
    list.push({gw,mp,key:gw.id+':'+mp.embeddedId,online:gw.isCloudConnectionUp?.value!==false,name:mp.name?.value||gwInfo?.name?.value||'Split',model:gwInfo?.modelInfo?.value||gw.deviceModel||'',firmware:gwInfo?.firmwareVersion?.value||''});
   }
  }
  return list.sort((a,b)=>a.name.localeCompare(b.name,'it'));
 }

 async function loadStatus(){
  state.status=await req('/api/daikin/status');
  return state.status;
 }
 async function load(force){
  if(state.loading)return;
  state.loading=true;render();
  try{
   if(!state.status||!state.status.linked)await loadStatus();
   if(state.status.configured&&state.status.linked){
    state.data=await req('/api/daikin/devices'+(force?'?refresh=1':''));
    state.lastLoad=Date.now();
    say((state.flash?state.flash+' ':'')+updatedText());state.flash=null;
   }else{say(state.flash||'');state.flash=null;}
  }catch(e){
   if(e.code==='daikin_not_linked'){state.status={...(state.status||{}),configured:true,linked:false};state.data=null;}
   if(!e.auth)say(e.message,true);
  }finally{state.loading=false;render();}
 }
 function updatedText(){
  const d=state.data;if(!d)return '';
  const at=new Date(d.fetchedAt).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
  const r=d.rate&&Number.isFinite(d.rate.day)?` · Richieste Daikin rimaste oggi: ${d.rate.day} su ${d.rate.dayLimit||200}`:'';
  return `Stato letto alle ${at}${r}.`;
 }

 async function command(u,characteristic,value,path,confirmed){
  if(state.busy)return;
  state.busy=true;render();say('Invio del comando a '+u.name+'…');
  try{
   state.data=await req('/api/daikin/command',{gatewayId:u.gw.id,embeddedId:u.mp.embeddedId,characteristic,value,...(path?{path}:{}),...(confirmed?{confirm:true}:{})});
   say('Comando inviato a '+u.name+'. '+updatedText());
  }catch(e){
   if(e.code==='daikin_cooldown'&&!confirmed){
    state.busy=false;
    if(window.confirm(e.message+'\n\nInviare comunque?'))return command(u,characteristic,value,path,true);
    say('Comando annullato.');
   }else if(!e.auth){say(e.message,true);if(e.code==='daikin_stale')void load(true);}
  }finally{state.busy=false;render();}
 }
 async function post(path,body,done){
  if(state.busy)return;
  state.busy=true;render();say('Invio in corso…');
  try{state.data=await req(path,body);say(done+' '+updatedText());state.editing=null;}
  catch(e){if(!e.auth)say(e.message,true);}
  finally{state.busy=false;render();}
 }

 // ---- lettura caratteristiche
 const mode=u=>u.mp.operationMode?.value;
 const setpoint=(u,m=mode(u))=>u.mp.temperatureControl?.value?.operationModes?.[m]?.setpoints?.roomTemperature;
 const fanMode=(u,m=mode(u))=>u.mp.fanControl?.value?.operationModes?.[m];
 const sensor=(u,n)=>u.mp.sensoryData?.value?.[n];
 const settable=(node,parent)=>node&&node.settable!==false&&(parent===undefined||parent!==false);

 function chips(u,{group,values,current,characteristic,path,disabled,cls=''}){
  return `<div class="climate-chips ${cls}" role="group">${values.map(v=>`<button type="button" class="climate-chip${v===current?' active':''}" aria-pressed="${v===current}" ${disabled||state.busy?'disabled':''} data-act="set" data-unit="${esc(u.key)}" data-ch="${esc(characteristic)}" data-path="${esc(path||'')}" data-value="${esc(JSON.stringify(v))}">${group==='operationMode'&&MODE_ICON[v]?`<span aria-hidden="true">${MODE_ICON[v]}</span>`:''}${esc(label(group,v))}</button>`).join('')}</div>`;
 }

 function unitCard(u){
  const on=u.mp.onOffMode?.value==='on',m=mode(u),sp=setpoint(u),fan=fanMode(u);
  const pending=state.pendingTemp.get(u.key),spValue=pending??sp?.value;
  const errors=[];
  if(u.mp.isInErrorState?.value)errors.push('Errore'+(u.mp.errorCode?.value?' '+u.mp.errorCode.value:''));
  if(u.mp.isInWarningState?.value)errors.push('Avviso');
  if(u.mp.isInCautionState?.value)errors.push('Attenzione');
  if(u.mp.isInModeConflict?.value)errors.push('Conflitto di modalità con un altro split');
  if(u.mp.isHolidayModeActive?.value)errors.push('Modalità vacanza attiva');
  const room=sensor(u,'roomTemperature'),out=sensor(u,'outdoorTemperature'),hum=sensor(u,'roomHumidity');
  const disabled=!u.online||state.busy;
  let html=`<article class="climate-card${on?' is-on':''}${u.online?'':' is-offline'}" data-unit="${esc(u.key)}">
   <header class="climate-head"><div><h2>${esc(u.name)}</h2><p class="climate-sub">${u.online?(on?esc(label('operationMode',m))+(sp&&spValue!==undefined&&!['fanOnly','dry'].includes(m)?' · '+num(spValue)+' °C':''):'Spento'):'Non in linea'}</p></div>
   <button type="button" class="climate-power${on?' on':''}" ${disabled||!settable(u.mp.onOffMode)?'disabled':''} data-act="power" data-unit="${esc(u.key)}" aria-pressed="${on}" aria-label="${on?'Spegni':'Accendi'} ${esc(u.name)}">${icon('power')}<span>${on?'Acceso':'Spento'}</span></button></header>
   ${errors.length?`<p class="climate-alert">${errors.map(esc).join(' · ')}</p>`:''}
   <div class="climate-sensors">
    <div><span>Interno</span><strong>${room?num(room.value)+' °C':'—'}</strong></div>
    ${out?`<div><span>Esterno</span><strong>${num(out.value)} °C</strong></div>`:''}
    ${hum?`<div><span>Umidità</span><strong>${num(hum.value)} %</strong></div>`:''}
   </div>`;
  if(u.mp.operationMode){
   html+=`<section class="climate-block"><h3>Modalità</h3>${chips(u,{group:'operationMode',values:u.mp.operationMode.values||[m],current:m,characteristic:'operationMode',disabled:disabled||!settable(u.mp.operationMode)})}</section>`;
  }
  if(sp){
   const step=sp.stepValue||0.5,can=!disabled&&settable(sp);
   html+=`<section class="climate-block"><h3>Temperatura desiderata${pending!==undefined?' <small>invio tra poco…</small>':''}</h3><div class="climate-temp">
    <button type="button" class="climate-step" data-act="temp" data-delta="${-step}" data-unit="${esc(u.key)}" ${can&&spValue>sp.minValue?'':'disabled'} aria-label="Abbassa temperatura">−</button>
    <output aria-live="polite">${num(spValue)}<small>°C</small></output>
    <button type="button" class="climate-step" data-act="temp" data-delta="${step}" data-unit="${esc(u.key)}" ${can&&spValue<sp.maxValue?'':'disabled'} aria-label="Alza temperatura">+</button></div>
    <p class="climate-hint">Intervallo ${num(sp.minValue)}–${num(sp.maxValue)} °C in ${esc(label('operationMode',m).toLowerCase())}.</p></section>`;
  }else if(['fanOnly','dry'].includes(m)) html+=`<p class="climate-hint">In ${esc(label('operationMode',m).toLowerCase())} la temperatura non si imposta.</p>`;
  if(fan?.fanSpeed?.currentMode){
   const fs=fan.fanSpeed,cur=fs.currentMode.value,fixed=fs.modes?.fixed;
   html+=`<section class="climate-block"><h3>Ventilazione</h3>${chips(u,{group:'fanSpeed',values:fs.currentMode.values||[cur],current:cur,characteristic:'fanControl',path:`/operationModes/${m}/fanSpeed/currentMode`,disabled:disabled||!settable(fs.currentMode)})}`;
   if(cur==='fixed'&&fixed){
    const levels=[];for(let v=fixed.minValue||1;v<=(fixed.maxValue||5);v+=fixed.stepValue||1)levels.push(v);
    html+=`<div class="climate-levels" role="group" aria-label="Velocità manuale">${levels.map(v=>`<button type="button" class="climate-level${v===fixed.value?' active':''}" aria-pressed="${v===fixed.value}" ${disabled||!settable(fixed)?'disabled':''} data-act="set" data-unit="${esc(u.key)}" data-ch="fanControl" data-path="/operationModes/${esc(m)}/fanSpeed/modes/fixed" data-value="${v}" aria-label="Velocità ${v}"><span style="--h:${20+v*14}%"></span>${v}</button>`).join('')}</div>`;
   }
   html+='</section>';
  }
  const dir=fan?.fanDirection;
  if(dir?.vertical?.currentMode||dir?.horizontal?.currentMode){
   html+=`<section class="climate-block"><h3>Direzione del flusso</h3>`;
   for(const [axis,name] of [['vertical','Alette verticali (su/giù)'],['horizontal','Alette orizzontali (destra/sinistra)']]){
    const c=dir[axis]?.currentMode;if(!c)continue;
    html+=`<p class="climate-label">${name}</p>${chips(u,{group:'direction',values:c.values||[c.value],current:c.value,characteristic:'fanControl',path:`/operationModes/${m}/fanDirection/${axis}/currentMode`,disabled:disabled||!settable(c)})}`;
   }
   html+='</section>';
  }
  // Funzioni on/off (Powerful, Econo, Streamer…) e altre impostazioni a scelta.
  const extras=Object.entries(u.mp).filter(([k,v])=>!HANDLED.has(k)&&v&&typeof v==='object'&&v.settable===true&&typeof v.value==='string'&&Array.isArray(v.values)&&v.values.length>1);
  if(extras.length){
   html+=`<section class="climate-block"><h3>Funzioni</h3><div class="climate-toggles">${extras.map(([k,v])=>{
    if(v.values.length===2&&v.values.includes('on')&&v.values.includes('off')){
     const active=v.value==='on';
     return `<button type="button" class="climate-toggle${active?' active':''}" aria-pressed="${active}" ${disabled?'disabled':''} data-act="set" data-unit="${esc(u.key)}" data-ch="${esc(k)}" data-value="${esc(JSON.stringify(active?'off':'on'))}"><span class="climate-switch" aria-hidden="true"></span>${esc(label('toggles',k))}</button>`;
    }
    return `<div class="climate-extra"><p class="climate-label">${esc(label('toggles',k))}</p>${chips(u,{group:'toggles',values:v.values,current:v.value,characteristic:k,disabled})}</div>`;
   }).join('')}</div>${u.mp.powerfulMode?'<p class="climate-hint">Powerful si disattiva da solo dopo circa 20 minuti.</p>':''}</section>`;
  }
  const dc=u.mp.demandControl?.value;
  if(dc?.currentMode){
   html+=`<section class="climate-block"><h3>Limite di potenza</h3>${chips(u,{group:'demand',values:dc.currentMode.values||[dc.currentMode.value],current:dc.currentMode.value,characteristic:'demandControl',path:'/currentMode',disabled:disabled||!settable(dc.currentMode)})}`;
   const f=dc.modes?.fixed;
   if(dc.currentMode.value==='fixed'&&f){
    const opts=[];for(let v=f.minValue;v<=f.maxValue;v+=f.stepValue||10)opts.push(v);
    html+=`<label class="climate-label">Potenza massima <select data-act="select" data-unit="${esc(u.key)}" data-ch="demandControl" data-path="/modes/fixed" ${disabled||!settable(f)?'disabled':''}>${opts.map(v=>`<option value="${v}" ${v===f.value?'selected':''}>${v} %</option>`).join('')}</select></label>`;
   }
   html+='</section>';
  }
  html+=details(u,'holiday','Modalità vacanza',()=>holidaySection(u));
  if(u.mp.consumptionData?.value?.electrical)html+=details(u,'energy','Consumi',()=>energySection(u));
  html+=details(u,'info','Nome e informazioni',()=>infoSection(u));
  return html+'</article>';
 }
 function details(u,id,title,body){
  const key=u.key+':'+id,open=state.open.has(key);
  return `<details class="climate-details" data-open-key="${esc(key)}" ${open?'open':''}><summary>${esc(title)}</summary><div class="climate-details-body">${open?body():''}</div></details>`;
 }

 function holidaySection(u){
  const h=u.mp.holidayMode?.value;
  if(!u.mp.holidayMode)return '<p class="climate-hint">Modalità vacanza non disponibile su questo split.</p>';
  const today=new Date().toISOString().slice(0,10),dis=state.busy?'disabled':'';
  return `<p class="climate-hint">${h?.enabled?`Vacanza impostata dal ${esc(h.startDate)} al ${esc(h.endDate)}: in quei giorni lo split resta bloccato.`:'Durante la vacanza lo split resta spento e ignora i programmi.'}</p>
   <form class="climate-row" data-act="holiday" data-unit="${esc(u.key)}"><label class="climate-label">Dal<input name="start" type="date" min="${today}" value="${esc(h?.startDate>today?h.startDate:today)}" required></label><label class="climate-label">Al<input name="end" type="date" min="${today}" value="${esc(h?.endDate>today?h.endDate:today)}" required></label><button type="submit" class="primary-button" ${dis}>Imposta vacanza</button>${h?.enabled?`<button type="button" class="secondary-button" data-act="holiday-off" data-unit="${esc(u.key)}" ${dis}>Annulla vacanza</button>`:''}</form>`;
 }
 function energySection(u){
  const el=u.mp.consumptionData.value.electrical,unit=el.unit||'kWh';
  const sum=(arr,from,to)=>{let t=0,any=false;for(let i=from;i<to;i++){const v=arr?.[i];if(Number.isFinite(v)){t+=v;any=true;}}return any?t:null;};
  const both=(k,from,to)=>{const a=sum(el.heating?.[k],from,to),b=sum(el.cooling?.[k],from,to);return a===null&&b===null?null:(a||0)+(b||0);};
  const month=new Date().getMonth();
  const rows=[['Oggi',both('d',12,24)],['Ieri',both('d',0,12)],['Questa settimana',both('w',7,14)],['Settimana scorsa',both('w',0,7)],['Questo mese',both('m',12+month,13+month)],['Quest’anno',both('m',12,24)],['Anno scorso',both('m',0,12)]];
  const slots=[];for(let i=12;i<24;i++){const h=el.heating?.d?.[i],c=el.cooling?.d?.[i];slots.push({h:Number.isFinite(h)?h:0,c:Number.isFinite(c)?c:0,none:!Number.isFinite(h)&&!Number.isFinite(c)});}
  const max=Math.max(0.1,...slots.map(s=>s.h+s.c));
  return `<dl class="climate-energy">${rows.map(([k,v])=>`<div><dt>${k}</dt><dd>${v===null?'—':num(v)+' '+esc(unit)}</dd></div>`).join('')}</dl>
   <p class="climate-label">Oggi, ogni 2 ore <span class="climate-legend"><i class="h"></i>riscaldamento <i class="c"></i>raffreddamento</span></p>
   <div class="climate-bars" role="img" aria-label="Consumi di oggi per fasce di due ore">${slots.map((s,i)=>`<div class="climate-bar${s.none?' none':''}" title="${String(i*2).padStart(2,'0')}:00–${String(i*2+2).padStart(2,'0')}:00: ${num(s.h+s.c)} ${esc(unit)}"><span class="c" style="height:${s.c/max*100}%"></span><span class="h" style="height:${s.h/max*100}%"></span><small>${i*2}</small></div>`).join('')}</div>
   <p class="climate-hint">Daikin aggiorna i consumi circa ogni 2 ore.</p>`;
 }
 function infoSection(u){
  const n=u.mp.name,dis=state.busy||!u.online?'disabled':'';
  return `${n?.settable?`<form class="climate-row" data-act="rename" data-unit="${esc(u.key)}"><label class="climate-label">Nome<input name="name" maxlength="${n.maxLength||32}" value="${esc(n.value||'')}" required></label><button type="submit" class="secondary-button" ${dis}>Rinomina</button></form>`:''}
   <dl class="climate-info"><div><dt>Modello</dt><dd>${esc(u.model||'—')}</dd></div><div><dt>Firmware</dt><dd>${esc(u.firmware||'—')}</dd></div><div><dt>Collegamento cloud</dt><dd>${u.online?'In linea':'Non in linea'}</dd></div>${u.mp.errorCode?.value?`<div><dt>Codice errore</dt><dd>${esc(u.mp.errorCode.value)}</dd></div>`:''}</dl>`;
 }

 function render(){
  if(!content)return;
  if(refreshBtn){refreshBtn.hidden=!state.status?.linked;refreshBtn.disabled=state.loading||state.busy;}
  const st=state.status;
  if(!st){content.innerHTML=state.loading?'<p class="climate-hint">Caricamento…</p>':'';return;}
  if(!st.configured){content.innerHTML='<article class="climate-empty"><h2>Integrazione Daikin non attiva</h2><p>Mancano le credenziali Daikin sul server.</p></article>';return;}
  if(!st.linked){
   content.innerHTML=`<article class="climate-empty"><span class="climate-empty-icon">${icon('thermo')}</span><h2>Collega Daikin Onecta</h2><p>Accedi con l’account Daikin che usi nell’app Onecta e autorizza la plancia. Serve una volta sola: il collegamento resta valido per un anno.</p><button type="button" class="primary-button" data-act="connect">Collega account Daikin</button></article>`;
   return;
  }
  const list=units();
  if(!state.data){content.innerHTML=state.loading?'<p class="climate-hint">Lettura degli split…</p>':'';return;}
  content.innerHTML=(list.length?`<div class="climate-grid">${list.map(unitCard).join('')}</div>`:'<p class="climate-hint">Nessuno split trovato nell’account Daikin.</p>')
   +`<footer class="climate-foot"><p class="climate-hint">Daikin consente 200 richieste al giorno: lo stato si aggiorna all’apertura della pagina, con “Aggiorna stati” e ogni 10 minuti mentre la pagina è aperta. I comandi dati dal telecomando compaiono al prossimo aggiornamento.</p><button type="button" class="secondary-button" data-act="disconnect" ${state.busy?'disabled':''}>Scollega Daikin</button></footer>`;
 }

 const unitByKey=k=>units().find(u=>u.key===k);
 function onClick(e){
  const b=e.target.closest('[data-act]');if(!b||b.tagName==='FORM'||b.tagName==='SELECT')return;
  const u=b.dataset.unit?unitByKey(b.dataset.unit):null,act=b.dataset.act;
  if(act==='connect'){location.href=base()+'/daikin/connect';return;}
  if(act==='disconnect'){if(confirm('Scollegare l’account Daikin dalla plancia? Gli split continueranno a funzionare con l’app Onecta e il telecomando.')){void (async()=>{try{await req('/api/daikin/disconnect',{});state.status=null;state.data=null;say('Account Daikin scollegato.');await load(false);}catch(err){if(!err.auth)say(err.message,true);}})();}return;}
  if(!u)return;
  if(act==='power')return void command(u,'onOffMode',u.mp.onOffMode.value==='on'?'off':'on');
  if(act==='set'){let v;try{v=JSON.parse(b.dataset.value);}catch{return;}return void command(u,b.dataset.ch,v,b.dataset.path||undefined);}
  if(act==='temp'){
   const sp=setpoint(u);if(!sp)return;
   const cur=state.pendingTemp.get(u.key)??sp.value,next=Math.min(sp.maxValue,Math.max(sp.minValue,Math.round((cur+Number(b.dataset.delta))*10)/10));
   state.pendingTemp.set(u.key,next);render();
   clearTimeout(timers.get(u.key));
   // Un solo invio dopo l’ultima pressione: risparmia richieste Daikin.
   timers.set(u.key,setTimeout(()=>{const v=state.pendingTemp.get(u.key);state.pendingTemp.delete(u.key);const fresh=unitByKey(u.key);if(fresh&&v!==setpoint(fresh)?.value)void command(fresh,'temperatureControl',v,`/operationModes/${mode(fresh)}/setpoints/roomTemperature`);else render();},1500));
   return;
  }
  if(act==='holiday-off')return void post('/api/daikin/holiday',{gatewayId:u.gw.id,embeddedId:u.mp.embeddedId,enabled:false},'Modalità vacanza annullata.');
 }
 function onSubmit(e){
  const f=e.target.closest('form[data-act]');if(!f)return;e.preventDefault();
  const u=unitByKey(f.dataset.unit);if(!u)return;const d=new FormData(f);
  if(f.dataset.act==='holiday')return void post('/api/daikin/holiday',{gatewayId:u.gw.id,embeddedId:u.mp.embeddedId,enabled:true,startDate:d.get('start'),endDate:d.get('end')},'Modalità vacanza impostata.');
  if(f.dataset.act==='rename'){const name=String(d.get('name')||'').trim();if(name)void command(u,'name',name);return;}
 }
 function onChange(e){
  const s=e.target;
  if(s.matches('select[data-act="select"]')){const u=unitByKey(s.dataset.unit);if(u)void command(u,s.dataset.ch,Number(s.value),s.dataset.path||undefined);}
 }
 function onToggle(e){
  const d=e.target;if(!d.matches?.('details[data-open-key]'))return;
  const k=d.dataset.openKey;
  if(d.open){if(!state.open.has(k)){state.open.add(k);render();}}else if(state.open.has(k)){state.open.delete(k);}
 }

 function open(){
  if(state.cleanUrl){state.cleanUrl();state.cleanUrl=null;}
  if(Date.now()-state.lastLoad>CACHE_VIEW_MS||!state.data)void load(false);else render();
 }
 const CACHE_VIEW_MS=5*60*1000;
 document.addEventListener('DOMContentLoaded',()=>{
  content=document.getElementById('climateContent');statusEl=document.getElementById('climateStatus');refreshBtn=document.getElementById('climateRefresh');
  for(const el of [content].filter(Boolean)){el.addEventListener('click',onClick);el.addEventListener('submit',onSubmit);el.addEventListener('change',onChange);el.addEventListener('toggle',onToggle,true);}
  if(!content)return;
  refreshBtn?.addEventListener('click',()=>void load(true));
  const params=new URLSearchParams(location.search),result=params.get('daikin');
  if(result||location.hash==='#clima'){
   const msg={ok:'Account Daikin collegato.',denied:'Autorizzazione Daikin annullata.',expired:'Collegamento Daikin scaduto: riprova.'}[result];
   if(msg)state.flash=msg;
   state.cleanUrl=()=>{params.delete('daikin');history.replaceState(null,'',location.pathname+(params.size?'?'+params:''));};
   if(document.body.dataset.view==='climate')open();
  }
  setInterval(()=>{if(document.body.dataset.view==='climate'&&document.visibilityState==='visible'&&state.status?.linked&&!state.busy&&Date.now()-state.lastLoad>=10*60*1000)void load(false);},60000);
 });
 // ---- Integrazione con Programmazione: gli split come dispositivi programmabili.
 const progId=u=>'daikin:'+u.gw.id+':'+u.mp.embeddedId;
 const progUnit=id=>units().find(u=>progId(u)===id);
 function progOptions(sel,list,cur,group,keep='Lascia com’è'){return `<option value="">${keep}</option>`+list.map(v=>`<option value="${esc(v)}" ${v===cur?'selected':''}>${esc(label(group,v))}</option>`).join('');}
 function renderProgramming(box,id,saved){
  const u=progUnit(id);
  if(!u){box.innerHTML='<p class="page-note">Split non trovato: apri la pagina Clima per aggiornare gli stati Daikin.</p>';return;}
  const read=k=>{const el=box.querySelector(`[data-dk="${k}"]`);return el?(el.type==='checkbox'?(el.checked?'on':'off'):el.value):undefined;};
  const v=saved||{operationMode:mode(u),roomTemperature:setpoint(u)?.value};
  const m=v.operationMode||mode(u),sp=setpoint(u,m),fan=fanMode(u,m);
  const fixed=fan?.fanSpeed?.modes?.fixed,levels=[];if(fixed)for(let i=fixed.minValue||1;i<=(fixed.maxValue||5);i+=fixed.stepValue||1)levels.push(i);
  let html=`<fieldset class="programming-daikin"><legend>Impostazioni dello split all’accensione</legend>
   <label for="dkMode">Modalità</label><select id="dkMode" data-dk="operationMode">${progOptions(null,u.mp.operationMode?.values||[],v.operationMode,'operationMode','Come l’ultima usata')}</select>`;
  if(sp)html+=`<label for="dkTemp">Temperatura (${num(sp.minValue)}–${num(sp.maxValue)} °C)</label><input id="dkTemp" data-dk="roomTemperature" type="number" min="${sp.minValue}" max="${sp.maxValue}" step="${sp.stepValue||0.5}" value="${esc(v.roomTemperature??'')}" placeholder="Lascia com’è">`;
  else if(v.operationMode)html+=`<p class="page-note">In ${esc(label('operationMode',m).toLowerCase())} la temperatura non si imposta.</p>`;
  if(fan?.fanSpeed?.currentMode){
   html+=`<label for="dkFan">Ventola</label><select id="dkFan" data-dk="fanSpeed">${progOptions(null,fan.fanSpeed.currentMode.values||[],v.fanSpeed,'fanSpeed')}</select>`;
   if(v.fanSpeed==='fixed'&&levels.length)html+=`<label for="dkLevel">Velocità</label><select id="dkLevel" data-dk="fanLevel">${levels.map(l=>`<option value="${l}" ${Number(v.fanLevel)===l?'selected':''}>${l}</option>`).join('')}</select>`;
  }
  for(const [axis,name] of [['vertical','Alette su/giù'],['horizontal','Alette destra/sinistra']]){const c=fan?.fanDirection?.[axis]?.currentMode;if(c)html+=`<label for="dk-${axis}">${name}</label><select id="dk-${axis}" data-dk="${axis}">${progOptions(null,c.values||[],v[axis],'direction')}</select>`;}
  for(const key of ['powerfulMode','econoMode','streamerMode'])if(u.mp[key]?.values?.includes('on'))html+=`<label for="dk-${key}">${esc(label('toggles',key))}</label><select id="dk-${key}" data-dk="${key}"><option value="">Lascia com’è</option><option value="on" ${v[key]==='on'?'selected':''}>Attivo</option><option value="off" ${v[key]==='off'?'selected':''}>Disattivo</option></select>`;
  html+='<p class="page-note">All’orario di accensione lo split si accende con queste impostazioni; allo spegnimento (se impostato) si spegne. I comandi passano da Daikin Onecta.</p></fieldset>';
  box.innerHTML=html;
  box.onchange=e=>{const k=e.target.dataset.dk;if(k==='operationMode'||k==='fanSpeed'){const cur=programmingSettings(box);if(k==='operationMode'){const nsp=setpoint(u,cur.operationMode||mode(u));cur.roomTemperature=nsp?.value;delete cur.fanSpeed;delete cur.fanLevel;delete cur.vertical;delete cur.horizontal;}renderProgramming(box,id,cur);}};
 }
 function programmingSettings(box){
  const out={};
  box.querySelectorAll('[data-dk]').forEach(el=>{if(el.value==='')return;out[el.dataset.dk]=['roomTemperature','fanLevel'].includes(el.dataset.dk)?Number(el.value):el.value;});
  return out;
 }
 function describeSettings(set){
  if(!set)return '';
  return [set.operationMode&&label('operationMode',set.operationMode),set.roomTemperature!==undefined&&num(set.roomTemperature)+' °C',set.fanSpeed&&'ventola '+label('fanSpeed',set.fanSpeed).toLowerCase()+(set.fanLevel?' '+set.fanLevel:''),set.vertical&&'su/giù '+label('direction',set.vertical).toLowerCase(),set.horizontal&&'dx/sx '+label('direction',set.horizontal).toLowerCase(),set.powerfulMode==='on'&&'Powerful'].filter(Boolean).join(' · ');
 }
 window.Climate={open,reload:()=>load(true),
  programmingUnits:()=>units().map(u=>({id:progId(u),name:u.name,online:u.online})),
  programmingUnit:id=>progUnit(id)?{id,name:progUnit(id).name}:null,
  renderProgramming,programmingSettings,describeSettings};
})();
