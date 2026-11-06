/* Immagini delle stanze e posizioni normalizzate, condivise con il server. */
(() => {
 'use strict';
 let api, draft=null, imageEpoch=0, imageBusy=false, drag=null, selectedPin=null,selectedReference=null;
 const images=new Map();
 let sizeObserver;
 const $=id=>document.getElementById(id);
 // Reference geometry uses fractions of the image, independent of screen size.
 const bound=(value,min,max)=>Math.max(min,Math.min(max,value));
 function referenceBox(label){const width=bound(label.width??.32,.1,.9),height=bound(label.height??.08,.025,.5);return {width,height,x:bound(label.x,width/2,1-width/2),y:bound(label.y,height/2,1-height/2)};}
 function resizeReference(initial,corner,edgeX,edgeY){
  const sx=corner.includes('w')?-1:1,sy=corner.includes('n')?-1:1;
  const ax=initial.x-sx*initial.width/2,ay=initial.y-sy*initial.height/2;
  const width=bound(sx*(edgeX-ax),.1,Math.min(.9,sx>0?1-ax:ax));
  const height=bound(sy*(edgeY-ay),.025,Math.min(.5,sy>0?1-ay:ay));
  return {width,height,x:ax+sx*width/2,y:ay+sy*height/2};
 }

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
  references.innerHTML='<h3>Riferimenti sull’immagine</h3><label for="roomReferenceText">Testo del riferimento</label><input id="roomReferenceText" maxlength="60" placeholder="Per esempio: lato portico"><div class="room-reference-actions"><button type="button" id="roomReferenceAdd">Aggiungi riferimento</button><button type="button" id="roomReferenceUpdate" disabled>Modifica testo</button><button type="button" id="roomReferenceRemove" disabled>Elimina riferimento</button></div><p>Scrivi un riferimento e aggiungilo, poi trascinalo sulla mappa. Selezionalo per vedere gli angoli di ridimensionamento e il cestino. Le frecce spostano con precisione; Maiusc + freccia per passi più grandi.</p>';
  $('roomMapEditor').append(references);
  $('roomReferenceAdd').onclick=()=>{
   const text=$('roomReferenceText').value.trim();
   if(!draft||!text){$('roomImageStatus').textContent='Scrivi il testo del riferimento.';return;}
   if(draft.annotations.length>=30){$('roomImageStatus').textContent='Puoi inserire al massimo 30 riferimenti.';return;}
   const label={id:crypto.randomUUID(),text,x:.5,y:.5,width:.32,height:.08};draft.annotations.push(label);selectedReference=label.id;selectedPin=null;renderDraft();
  };
  $('roomReferenceUpdate').onclick=()=>{const label=draft?.annotations.find(label=>label.id===selectedReference),text=$('roomReferenceText').value.trim();if(label&&text){label.text=text;renderDraft();}else $('roomImageStatus').textContent='Scrivi il testo del riferimento.';};
  $('roomReferenceRemove').onclick=()=>removeReference(selectedReference);
  $('roomChoices').after($('roomMapDraft'));
  $('roomType').onchange=()=>{draft.mode=$('roomType').value;syncChoices();};
  $('roomChoices').addEventListener('change',syncChoices);
  $('roomPinStyle').onchange=()=>{const pin=draft.members.find(p=>p.id===selectedPin);if(pin)pin.icon=$('roomPinStyle').value;renderDraft();};
  $('roomImageFile').onchange=loadImage;
  $('roomEditorDialog').addEventListener('close',()=>{imageEpoch++;imageBusy=false;drag=null;draft=null;});
  const stage=$('roomMapDraft');
  stage.addEventListener('pointerdown',event=>{
   if(event.target.closest('[data-reference-delete]'))return;
   const button=event.target.closest('[data-map-pin],[data-map-reference]');
   if(!button||event.isPrimary===false||event.button!==0||!draft||drag)return;
   event.preventDefault();selectPlacement(button);button.focus({preventScroll:true});button.setPointerCapture(event.pointerId);
   const rect=stage.getBoundingClientRect(),reference=Boolean(selectedReference),item=(reference?draft.annotations:draft.members).find(p=>p.id===(selectedReference||selectedPin));
   const corner=event.target.closest('[data-reference-resize]')?.dataset.referenceResize;
   if(reference)Object.assign(item,referenceBox(item));
   const box=reference?referenceBox(item):null;
   const cx=corner?box.x+(corner.includes('w')?-1:1)*box.width/2:item.x;
   const cy=corner?box.y+(corner.includes('n')?-1:1)*box.height/2:item.y;
   drag={id:item.id,reference,pointer:event.pointerId,button,corner,initial:box,grabX:event.clientX-rect.left-cx*rect.width,grabY:event.clientY-rect.top-cy*rect.height};
   button.classList.add('is-dragging');
  });
  stage.addEventListener('focusin',event=>{const button=event.target.closest('[data-map-pin],[data-map-reference]');if(button&&draft)selectPlacement(button);});
  stage.addEventListener('pointermove',event=>{if(drag&&event.pointerId===drag.pointer){event.preventDefault();movePlacement(event,stage);}});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(name,event=>{
   if(!drag||event.pointerId!==drag.pointer)return;
   if(name==='pointerup')movePlacement(event,stage);
   drag.button.classList.remove('is-dragging');drag=null;
  });
  stage.addEventListener('click',event=>{if(event.target===stage||event.target.classList.contains('room-map-image')){selectedReference=selectedPin=null;updateSelection();}});
  stage.addEventListener('keydown',event=>{
   const button=event.target.closest('[data-map-pin],[data-map-reference]');if(!button||!draft)return;
   const reference=Boolean(button.dataset.mapReference),item=(reference?draft.annotations:draft.members).find(p=>p.id===(button.dataset.mapReference||button.dataset.mapPin));
   if(reference&&!event.target.closest('[data-reference-delete]')&&['Delete','Backspace'].includes(event.key)){event.preventDefault();removeReference(item.id);return;}
   const step=event.shiftKey ? .01 : .002;
   const delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[event.key];if(!delta)return;
   event.preventDefault();const corner=event.target.closest('[data-reference-resize]')?.dataset.referenceResize;
   if(reference&&corner){const box=referenceBox(item);Object.assign(item,resizeReference(box,corner,box.x+(corner.includes('w')?-1:1)*box.width/2+delta[0],box.y+(corner.includes('n')?-1:1)*box.height/2+delta[1]));}
   else{const box=reference?referenceBox(item):{width:button.offsetWidth/stage.clientWidth,height:button.offsetHeight/stage.clientHeight};item.x=bound(item.x+delta[0],box.width/2,1-box.width/2);item.y=bound(item.y+delta[1],box.height/2,1-box.height/2);}
   place(button,item);if(reference)fitReference(button);
  });
  new ResizeObserver(()=>fitReferences(stage)).observe(stage);
  updatePermissions();window.addEventListener('resize',updatePermissions);
 }
 function movePlacement(event,stage){
  if(!draft)return;
  const item=(drag.reference?draft.annotations:draft.members).find(p=>p.id===drag.id);if(!item)return;
  const rect=stage.getBoundingClientRect(),x=(event.clientX-rect.left-drag.grabX)/rect.width,y=(event.clientY-rect.top-drag.grabY)/rect.height;
  if(drag.corner)Object.assign(item,resizeReference(drag.initial,drag.corner,x,y));
  else{const width=drag.reference?referenceBox(item).width:drag.button.offsetWidth/rect.width,height=drag.reference?referenceBox(item).height:drag.button.offsetHeight/rect.height;item.x=bound(x,width/2,1-width/2);item.y=bound(y,height/2,1-height/2);}
  place(drag.button,item);if(drag.reference&&drag.corner)fitReference(drag.button);
 }
 function removeReference(id){
  if(!draft||!id)return;drag=null;draft.annotations=draft.annotations.filter(label=>label.id!==id);selectedReference=null;$('roomReferenceText').value='';renderDraft();
 }
 function updateSelection(){
  for(const label of $('roomMapDraft').querySelectorAll('[data-map-reference]'))label.classList.toggle('is-selected',label.dataset.mapReference===selectedReference);
  $('roomReferenceUpdate').disabled=$('roomReferenceRemove').disabled=!selectedReference;
 }
 function selectPlacement(button){
  selectedReference=button.dataset.mapReference||null;selectedPin=button.dataset.mapPin||null;
  if(selectedReference)$('roomReferenceText').value=draft.annotations.find(label=>label.id===selectedReference).text;
  else $('roomPinStyle').value=draft.members.find(pin=>pin.id===selectedPin).icon;
  updateSelection();
 }
 function fitReference(element){
  const area=element.querySelector('.room-reference-text'),copy=element.querySelector('.room-reference-copy');if(!area||!area.clientWidth||!area.clientHeight)return;
  let low=4,high=Math.min(96,area.clientHeight);
  for(let i=0;i<9;i++){const mid=(low+high)/2;copy.style.fontSize=mid+'px';if(copy.scrollHeight>area.clientHeight+.5||copy.scrollWidth>area.clientWidth+.5)high=mid;else low=mid;}
  copy.style.fontSize=Math.floor(low*10)/10+'px';
 }
 function fitReferences(stage){for(const label of stage.querySelectorAll('.room-map-reference'))fitReference(label);}
 function referenceLabel(label,editing){
  const element=document.createElement('div');element.className='room-map-reference reference-sized';
  const area=document.createElement('span');area.className='room-reference-text';const copy=document.createElement('span');copy.className='room-reference-copy';copy.textContent=label.text;area.append(copy);element.append(area);
  if(editing){
   element.tabIndex=0;element.dataset.mapReference=label.id;element.setAttribute('role','group');element.setAttribute('aria-label',label.text+'. Trascina per spostare, usa gli angoli per ridimensionare.');
   for(const[corner,name]of [['nw','alto a sinistra'],['ne','alto a destra'],['sw','basso a sinistra'],['se','basso a destra']]){const handle=document.createElement('button');handle.type='button';handle.className='reference-handle handle-'+corner;handle.dataset.referenceResize=corner;handle.setAttribute('aria-label','Ridimensiona '+label.text+': '+name);element.append(handle);}
   const remove=document.createElement('button');remove.type='button';remove.className='reference-trash';remove.dataset.referenceDelete=label.id;remove.setAttribute('aria-label','Elimina riferimento '+label.text);remove.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';remove.onclick=event=>{event.stopPropagation();removeReference(label.id);};element.append(remove);
   element.classList.toggle('is-selected',label.id===selectedReference);
  }
  place(element,referenceBox(label));return element;
 }
 function previews(rooms,container){
  for(const button of container.querySelectorAll('[data-room-cover]')){
   const room=rooms.find(room=>room.id===button.dataset.roomCover);if(room?.mode!=='map')continue;
   readImage(room).then(image=>{if(!button.isConnected)return;const img=document.createElement('img');img.src=image;img.alt='';img.className='room-cover-image';button.prepend(img);button.classList.add('has-room-image');}).catch(()=>{});
  }
 }
 function place(button,pin){button.style.left=(pin.x*100)+'%';button.style.top=(pin.y*100)+'%';if(button.classList.contains('reference-sized')){const box=referenceBox(pin);button.style.width=(box.width*100)+'%';button.style.height=(box.height*100)+'%';}}
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
  const fill=matchMedia('(pointer: coarse), (max-width: 1024px)').matches;
  stage.classList.toggle('map-fill',fill);
  const width=Math.max(0,fill?rect.width:Math.min(rect.width,rect.height*2/3));
  stage.style.width=width+'px';
  if(fill)stage.style.height=Math.max(0,rect.height)+'px';else stage.style.removeProperty('height');
  fitReferences(stage);
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
  draft={mode:room?.mode||'list',members:(room?.members||[]).filter(p=>p.kind==='device').map(p=>({...p,x:p.x??.5,y:p.y??.5,icon:p.icon||'bulb'})),annotations:(room?.annotations||[]).map(label=>({...label,...referenceBox(label)})),image:'',changed:false};
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
  updateSelection();requestAnimationFrame(()=>{if(draft)fitReferences(stage);});
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
