/* Plance a tutto schermo per scenari e stanze; la gestione conserva lo scorrimento. */
(()=>{
 'use strict';
 function gridSize(width,height,scale){
  const minWidth=(width<600?150:220)*scale,minHeight=200*scale;
  return {cols:Math.max(1,Math.min(6,Math.floor((width+16)/(minWidth+16)))),rows:Math.max(1,Math.min(width<600?3:5,Math.floor((height+16)/(minHeight+16))))};
 }
 document.addEventListener('DOMContentLoaded',()=>{
  const sceneGrid=document.getElementById('scenesList'),editor=document.getElementById('sceneEditor'),sceneView=document.getElementById('settingsView');
  const roomsView=document.getElementById('roomsView'),roomList=document.getElementById('roomsList'),detail=document.getElementById('roomDetail'),members=document.getElementById('roomMembers');
  let queued=false;
  function schedule(){if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;layout();});}}
  function createBoard(view,name,gridFor,contextFor){
   const nav=document.createElement('nav');nav.className='scene-pagination';nav.setAttribute('aria-label','Pagine '+name);
   const previous=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');
   previous.type=next.type='button';previous.textContent='‹';next.textContent='›';previous.setAttribute('aria-label','Pagina precedente '+name);next.setAttribute('aria-label','Pagina successiva '+name);
   label.setAttribute('role','status');label.setAttribute('aria-live','polite');nav.append(previous,label,next);
   if(view===sceneView)view.insertBefore(nav,editor);else view.appendChild(nav);
   const board={nav,previous,next,label,gridFor,contextFor,page:0,capacity:0,context:null,anchorKey:null};
   previous.addEventListener('click',()=>{if(board.page>0){board.page--;board.anchorKey=null;layout();}});
   next.addEventListener('click',()=>{const grid=gridFor();if((board.page+1)*board.capacity<grid.querySelectorAll('.scenario-unit').length){board.page++;board.anchorKey=null;layout();}});
   return board;
  }
  const scenes=createBoard(sceneView,'degli scenari',()=>sceneGrid,()=> 'scenes');
  const rooms=createBoard(roomsView,'della stanza',()=>detail.hidden?roomList:members,()=>roomsView.dataset.room||'room-list');
  function place(board,enabled){
   const {nav,previous,next,label}=board,grid=board.gridFor(),tiles=[...grid.children].filter(el=>el.classList.contains('scenario-unit'));
   nav.hidden=!enabled||!tiles.length;
   if(!enabled){for(const tile of tiles)tile.hidden=false;grid.style.removeProperty('--scene-cols');grid.style.removeProperty('--scene-rows');return;}
   const context=board.contextFor();if(board.context!==context){board.context=context;board.page=0;board.capacity=0;board.anchorKey=null;}
   if(!tiles.length)return;
   const box=grid.getBoundingClientRect();if(box.width<1||box.height<1)return;
   const scale=(Number(document.documentElement.dataset.textSize)||100)/100;
   let {cols,rows}=gridSize(box.width,box.height,scale);
   cols=Math.min(cols,tiles.length);rows=Math.min(rows,Math.ceil(tiles.length/cols));
   if(tiles.length<=cols*rows)cols=Math.min(cols,Math.ceil(tiles.length/rows));
   const anchored=board.anchorKey?tiles.findIndex(tile=>tile.dataset.boardKey===board.anchorKey):-1;
   const anchor=anchored>=0?anchored:board.page*(board.capacity||cols*rows);
   let count;
   for(let attempt=0;attempt<30;attempt++){
    count=cols*rows;board.page=Math.min(Math.floor(anchor/count),Math.max(0,Math.ceil(tiles.length/count)-1));
    const visibleCount=Math.min(count,tiles.length-board.page*count),visibleCols=Math.min(cols,visibleCount),visibleRows=Math.ceil(visibleCount/visibleCols);
    grid.style.setProperty('--scene-cols',String(visibleCols));grid.style.setProperty('--scene-rows',String(visibleRows));
    tiles.forEach((tile,i)=>{tile.hidden=i<board.page*count||i>=(board.page+1)*count;});
    const overflowing=tiles.filter(tile=>!tile.hidden).some(tile=>{const pad=tile.querySelector('.scenario-pad');return pad&&(pad.scrollHeight>pad.clientHeight+2||pad.scrollWidth>pad.clientWidth+2);});
    if(!overflowing)break;
    if(rows>1)rows--;else if(cols>1)cols--;else break;
   }
   if(grid===roomList){const size=Math.min((box.width-14*(cols-1)-4)/cols,(box.height-14*(rows-1)-12)/rows);grid.style.setProperty('--room-tile-size',Math.max(1,Math.floor(size))+'px');}
   board.capacity=count;board.anchorKey=tiles[board.page*count]?.dataset.boardKey||null;
   const total=Math.max(1,Math.ceil(tiles.length/count));previous.disabled=board.page===0;next.disabled=board.page>=total-1;
   const text=(board.page+1)+' / '+total;if(label.textContent!==text)label.textContent=text;
   nav.style.visibility=total>1?'visible':'hidden';nav.setAttribute('aria-hidden',String(total===1));previous.tabIndex=next.tabIndex=total>1?0:-1;
  }
  function layout(){
   const sceneEnabled=document.body.dataset.view==='scenes'&&editor.style.display!=='block'&&!sceneGrid.querySelector('.pad-management');
   document.body.classList.toggle('room-map-active',document.body.dataset.view==='rooms'&&roomsView.dataset.mode==='map');
   const roomEnabled=document.body.dataset.view==='rooms'&&roomsView.dataset.management!=='true'&&roomsView.dataset.mode!=='map';
   document.body.classList.toggle('scenes-paged',sceneEnabled);document.body.classList.toggle('rooms-paged',roomEnabled);
   place(scenes,sceneEnabled);place(rooms,roomEnabled);
  }
  for(const grid of [sceneGrid,roomList,members])new MutationObserver(schedule).observe(grid,{childList:true});
  new MutationObserver(schedule).observe(editor,{attributes:true,attributeFilter:['style']});
  new MutationObserver(schedule).observe(detail,{attributes:true,attributeFilter:['hidden']});
  new MutationObserver(schedule).observe(roomsView,{attributes:true,attributeFilter:['data-room','data-management','data-mode']});
  new MutationObserver(schedule).observe(document.body,{attributes:true,attributeFilter:['data-view']});
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['data-text-size']});
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(schedule);for(const grid of [sceneGrid,roomList,members])observer.observe(grid);}
  window.addEventListener('resize',schedule);if(window.visualViewport)window.visualViewport.addEventListener('resize',schedule);
  schedule();
 });
})();
