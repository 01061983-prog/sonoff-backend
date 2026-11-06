/* Immagini delle stanze e posizioni normalizzate, condivise con il server. */
(() => {
 'use strict';
 let api, draft=null, imageEpoch=0, imageBusy=false, drag=null, selectedPin=null,selectedReference=null;
 const images=new Map();
 let sizeObserver;
 const $=id=>document.getElementById(id);
 const clamp=value=>Math.max(.08,Math.min(.92,value));
 function canEdit(){
  const phone=/iPhone|iPod|Windows Phone|Android.*Mobile/i.test(navigator.userAgent||'');
  return !phone && !(matchMedia('(pointer:coarse)').matches && Math.min(screen.width,screen.height)<600);
 }
 function updatePermissions(){
  document.querySelectorAll('[data-room-edit]').forEach(button=>{button.hidden=!canEdit();});
 }
 function init(callbacks){
  api=callbacks;
  const fields=document.createElement('div');fields.id='roomMapFields';
  fields.innerHTML=`<label for="roomType">Tipo di stanza</label><select id="roomType"><option value="list">Elenco di scenari e dispositivi</option><option value="map">Immagine con dispositivi</option></select><div id="roomMapEditor" hidden><label for="roomImageFile">Immagine della stanza</label><input id="roomImageFile" type="file" accept="image/jpeg,image/png,image/webp"><p>La tavola è verticale. Le immagini orizzontali vengono ruotate. Scegli i dispositivi e trascina le icone nella posizione desiderata.</p><label for="roomPinStyle">Icona dei dispositivi selezionati</label><select id="roomPinStyle"><option value="bulb">Lampadina</option><option value="power">Interruttore</option></select><p id="roomImageStatus" role="status"></p><div id="roomMapDraft" class="room-map-stage map-edit-stage" aria-label="Posiziona i dispositivi"></div></div>`;
  $('roomChoices').before(fields);
  const references=document.createElement('div');references.className='room-reference-tools';
  references.innerHTML='<h3>Riferimenti sull’immagine</h3><label for="roomReferenceText">Testo del riferimento</label><input id="roomReferenceText" maxlength="60" placeholder="Per esempio: lato portico"><div class="room-reference-actions"><button type="button" id="roomReferenceAdd">Aggiungi riferimento</button><button type="button" id="roomReferenceUpdate" disabled>Modifica testo</button><button type="button" id="roomReferenceRemove" disabled>Elimina riferimento</button></div><p>Scrivi un riferimento e aggiungilo, poi trascinalo sulla mappa. Tocca un riferimento per modificarlo o eliminarlo.</p>';
  $('roomMapEditor').append(references);
  $('roomReferenceAdd').onclick=()=>{
   const text=$('roomReferenceText').value.trim();
   if(!draft||!text){$('roomImageStatus').textContent='Scrivi il testo del riferimento.';return;}
   if(draft.annotations.length>=30){$('roomImageStatus').textContent='Puoi inserire al massimo 30 riferimenti.';return;}
   const label={id:crypto.randomUUID(),text,x:.5,y:.5};draft.annotations.push(label);selectedReference=label.id;selectedPin=null;renderDraft();
  };
  $('roomReferenceUpdate').onclick=()=>{const label=draft?.annotations.find(label=>label.id===selectedReference),text=$('roomReferenceText').value.trim();if(label&&text){label.text=text;renderDraft();}else $('roomImageStatus').textContent='Scrivi il testo del riferimento.';};
  $('roomReferenceRemove').onclick=()=>{if(!draft)return;draft.annotations=draft.annotations.filter(label=>label.id!==selectedReference);selectedReference=null;$('roomReferenceText').value='';renderDraft();};
  $('roomChoices').after($('roomMapDraft'));
  $('roomType').onchange=()=>{draft.mode=$('roomType').value;syncChoices();};
  $('roomChoices').addEventListener('change',syncChoices);
  $('roomPinStyle').onchange=()=>{const pin=draft.members.find(p=>p.id===selectedPin);if(pin)pin.icon=$('roomPinStyle').value;renderDraft();};
  $('roomImageFile').onchange=loadImage;
  $('roomEditorDialog').addEventListener('close',()=>{imageEpoch++;imageBusy=false;draft=null;});
  const stage=$('roomMapDraft');
  stage.addEventListener('pointerdown',event=>{
   const button=event.target.closest('[data-map-pin],[data-map-reference]');
   if(!button||event.isPrimary===false||event.button!==0||!draft)return;
   event.preventDefault();button.setPointerCapture(event.pointerId);
   selectPlacement(button);
   drag={id:selectedReference||selectedPin,reference:Boolean(selectedReference),pointer:event.pointerId,button};
  });
  stage.addEventListener('focusin',event=>{const button=event.target.closest('[data-map-pin],[data-map-reference]');if(button&&draft)selectPlacement(button);});
  stage.addEventListener('pointermove',event=>{
   if(!drag||event.pointerId!==drag.pointer||!draft)return;
   const rect=stage.getBoundingClientRect(),pin=(drag.reference?draft.annotations:draft.members).find(p=>p.id===drag.id);
   pin.x=clamp((event.clientX-rect.left)/rect.width);pin.y=clamp((event.clientY-rect.top)/rect.height);
   place(drag.button,pin);
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(event,()=>{drag=null;});
  stage.addEventListener('keydown',event=>{
   const button=event.target.closest('[data-map-pin],[data-map-reference]');if(!button||!draft)return;
   const delta={ArrowLeft:[-.02,0],ArrowRight:[.02,0],ArrowUp:[0,-.02],ArrowDown:[0,.02]}[event.key];
   if(!delta)return;
   event.preventDefault();const pin=button.dataset.mapReference?draft.annotations.find(p=>p.id===button.dataset.mapReference):draft.members.find(p=>p.id===button.dataset.mapPin);
   pin.x=clamp(pin.x+delta[0]);pin.y=clamp(pin.y+delta[1]);place(button,pin);
  });
  updatePermissions();window.addEventListener('resize',updatePermissions);
 }
 function selectPlacement(button){
  selectedReference=button.dataset.mapReference||null;selectedPin=button.dataset.mapPin||null;
  if(selectedReference)$('roomReferenceText').value=draft.annotations.find(label=>label.id===selectedReference).text;
  else $('roomPinStyle').value=draft.members.find(pin=>pin.id===selectedPin).icon;
  $('roomReferenceUpdate').disabled=$('roomReferenceRemove').disabled=!selectedReference;
 }
 function referenceLabel(label,editing){
  const element=document.createElement(editing?'button':'span');element.className='room-map-reference';element.textContent=label.text;
  if(editing){element.type='button';element.dataset.mapReference=label.id;element.setAttribute('aria-label',label.text+'. Trascina oppure usa le frecce.');}
  place(element,label);return element;
 }
 function previews(rooms,container){
  for(const button of container.querySelectorAll('[data-room-cover]')){
   const room=rooms.find(room=>room.id===button.dataset.roomCover);if(room?.mode!=='map')continue;
   readImage(room).then(image=>{if(!button.isConnected)return;const img=document.createElement('img');img.src=image;img.alt='';img.className='room-cover-image';button.prepend(img);button.classList.add('has-room-image');}).catch(()=>{});
  }
 }
 function place(button,pin){button.style.left=(pin.x*100)+'%';button.style.top=(pin.y*100)+'%';}
 async function readImage(room){
  const key=api.scope()+':'+room.id+':'+room.imageVersion;
  if(!images.has(key)){
   const task=api.request('/api/room-image?workspaceId='+encodeURIComponent(api.workspace())+'&roomId='+encodeURIComponent(room.id)).then(data=>data.image).catch(error=>{images.delete(key);throw error;});
   // Una sola immagine per revisione. Nessun salvataggio persistente nel browser.
   if(images.size>30)images.delete(images.keys().next().value);
   images.set(key,task);
  }
  return images.get(key);
 }
 function background(stage,image){
  let img=stage.querySelector('.room-map-image');
  if(!img){img=document.createElement('img');img.className='room-map-image';img.alt='';stage.prepend(img);}
  img.src=image;
 }
 function pinButton(pin,editing){
  const device=api.devices().find(d=>d.deviceid===pin.id);
  let button;
  if(!editing&&device){
   const box=document.createElement('div');box.innerHTML=api.deviceCard(device);button=box.querySelector('.device-primary');
   const state=button.querySelector('.pad-state')?.textContent||'';
   const progress=button.querySelector('.command-progress');
   button.classList.remove('scenario-pad','device-primary');
   button.innerHTML='';
   const glyph=document.createElement('span');glyph.innerHTML=api.icon(pin.icon==='power'?'power':'bulb');button.append(glyph);
   const status=document.createElement('small');status.textContent=state;button.append(status);
   if(progress)button.append(progress);
  }else{
   button=document.createElement('button');button.type='button';
   button.innerHTML=api.icon(pin.icon==='power'?'power':'bulb');
   if(editing){button.dataset.mapPin=pin.id;button.setAttribute('aria-label',(device?.name||pin.id)+'. Trascina oppure usa le frecce.');}
   else{button.disabled=true;button.classList.add('state-offline');button.title='Dispositivo non disponibile';const status=document.createElement('small');status.textContent='Non disponibile';button.append(status);}
  }
  button.classList.add('room-map-pin');
  if(editing){const label=document.createElement('span');label.className='room-map-label';label.textContent=device?.name||pin.id;button.append(label);}
  place(button,pin);return button;
 }
 function fit(stage){
  if(!stage.isConnected)return;
  const rect=stage.parentElement.getBoundingClientRect();
  const width=Math.max(0,Math.min(rect.width,rect.height*2/3));
  stage.style.width=width+'px';
 }
 function render(room,container){
  container.classList.add('room-map-members');
  const stage=document.createElement('div');stage.className='room-map-stage';stage.setAttribute('aria-label',room.name);container.append(stage);
  for(const pin of room.members)stage.append(pinButton(pin,false));
  for(const label of room.annotations||[])stage.append(referenceLabel(label,false));
  sizeObserver?.disconnect();
  sizeObserver=new ResizeObserver(()=>fit(stage));
  sizeObserver.observe(container);requestAnimationFrame(()=>fit(stage));
  const status=document.createElement('p');status.className='room-map-status';status.textContent='Caricamento immagine…';stage.append(status);
  readImage(room).then(image=>{if(stage.isConnected){background(stage,image);status.remove();}}).catch(error=>{if(stage.isConnected){status.textContent=error.message;const retry=document.createElement('button');retry.textContent='Riprova';retry.onclick=()=>api.redraw();status.append(retry);}});
 }
 function begin(room){
  imageEpoch++;imageBusy=false;drag=null;selectedPin=null;selectedReference=null;
  draft={mode:room?.mode||'list',members:(room?.members||[]).filter(p=>p.kind==='device').map(p=>({...p,x:p.x??.5,y:p.y??.5,icon:p.icon||'bulb'})),annotations:(room?.annotations||[]).map(label=>({...label})),image:'',changed:false};
  $('roomType').value=draft.mode;$('roomImageFile').value='';$('roomImageStatus').textContent='';
  $('roomPinStyle').value='bulb';
  $('roomReferenceText').value='';$('roomReferenceUpdate').disabled=$('roomReferenceRemove').disabled=true;
  if(room?.mode==='map'){
   const epoch=imageEpoch;imageBusy=true;
   $('roomImageStatus').textContent='Caricamento immagine salvata…';
   readImage(room).then(image=>{if(epoch!==imageEpoch||!draft)return;draft.image=image;$('roomImageStatus').textContent='';renderDraft();}).catch(error=>{if(epoch===imageEpoch)$('roomImageStatus').textContent=error.message;}).finally(()=>{if(epoch===imageEpoch)imageBusy=false;});
  }
  syncChoices();
 }
 function syncChoices(){
  if(!draft)return;
  draft.mode=$('roomType').value;
  const isMap=draft.mode==='map';$('roomMapEditor').hidden=!isMap;$('roomMapDraft').hidden=!isMap;
  const selected=[];
  for(const input of document.querySelectorAll('[data-room-member]')){
   const scene=input.dataset.roomMember.startsWith('scene:');
   input.closest('label').hidden=isMap&&scene;
   if(input.checked&&!scene)selected.push(input.dataset.roomMember.slice(7));
  }
  draft.members=selected.map((id,i)=>draft.members.find(p=>p.id===id)||{kind:'device',id,icon:$('roomPinStyle').value,x:.22+(i%3)*.28,y:Math.min(.85,.18+Math.floor(i/3)*.17)});
  renderDraft();
 }
 function renderDraft(){
  const stage=$('roomMapDraft');stage.innerHTML='';
  if(draft.image)background(stage,draft.image);
  for(const pin of draft.members)stage.append(pinButton(pin,true));
  for(const label of draft.annotations)stage.append(referenceLabel(label,true));
  $('roomReferenceUpdate').disabled=$('roomReferenceRemove').disabled=!selectedReference;
 }
 async function loadImage(){
  const file=$('roomImageFile').files[0];if(!file||!draft)return;
  const epoch=++imageEpoch;imageBusy=true;$('roomImageStatus').textContent='Preparazione immagine…';
  try{
   if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12000000)throw Error('Scegli una foto JPEG, PNG o WebP di massimo 12 MB.');
   const image=await createImageBitmap(file);
   let result;
   try{
    const canvas=document.createElement('canvas');canvas.width=800;canvas.height=1200;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#e7eee9';ctx.fillRect(0,0,800,1200);
    const landscape=image.width>image.height,w=landscape?image.height:image.width,h=landscape?image.width:image.height,scale=Math.min(800/w,1200/h);
    ctx.translate(400,600);if(landscape)ctx.rotate(Math.PI/2);
    ctx.drawImage(image,-image.width*scale/2,-image.height*scale/2,image.width*scale,image.height*scale);
    for(const quality of [.85,.7,.5,.35]){result=canvas.toDataURL('image/jpeg',quality);if(result.length<=360000)break;}
    if(result.length>360000)throw Error('Immagine troppo complessa. Prova una foto più piccola.');
   }finally{image.close();}
   if(epoch!==imageEpoch||!draft)return;
   draft.image=result;draft.changed=true;$('roomImageStatus').textContent='Immagine pronta. Posiziona i dispositivi e salva.';renderDraft();
  }catch(error){if(epoch===imageEpoch)$('roomImageStatus').textContent=error.message;}
  finally{if(epoch===imageEpoch)imageBusy=false;}
 }
 function collect(){
  if(!draft||draft.mode!=='map')return {mode:'list'};
  if(imageBusy)throw Error('Attendi il caricamento dell’immagine.');
  if(!draft.image)throw Error('Carica un’immagine per la stanza.');
  return {mode:'map',members:draft.members.map(p=>({...p})),annotations:draft.annotations.map(label=>({...label})),...(draft.changed?{image:draft.image}:{})};
 }
 window.RoomMap={init,canEdit,updatePermissions,begin,collect,render,previews};
})();
