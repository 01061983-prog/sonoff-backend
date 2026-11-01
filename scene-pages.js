/* Pagine adattive per la sola plancia scenari; editor e altre viste conservano lo scorrimento. */
(()=>{
 'use strict';
 function gridSize(width,height,scale){
  const minWidth=(width<600?150:220)*scale,minHeight=200*scale;
  return {cols:Math.max(1,Math.min(6,Math.floor((width+16)/(minWidth+16)))),rows:Math.max(1,Math.min(width<600?3:5,Math.floor((height+16)/(minHeight+16))))};
 }
 document.addEventListener('DOMContentLoaded',()=>{
  const grid=document.getElementById('scenesList'),editor=document.getElementById('sceneEditor'),view=document.getElementById('settingsView');
  const nav=document.createElement('nav');nav.className='scene-pagination';nav.setAttribute('aria-label','Pagine degli scenari');
  const previous=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');
  previous.type=next.type='button';previous.textContent='‹';next.textContent='›';previous.setAttribute('aria-label','Pagina precedente degli scenari');next.setAttribute('aria-label','Pagina successiva degli scenari');
  label.setAttribute('role','status');label.setAttribute('aria-live','polite');nav.append(previous,label,next);view.insertBefore(nav,editor);
  let page=0,capacity=0,queued=false;
  function schedule(){if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;layout();});}}
  function layout(){
   const enabled=document.body.dataset.view==='scenes'&&editor.style.display!=='block'&&!grid.querySelector('.pad-management');
   document.body.classList.toggle('scenes-paged',enabled);
   const tiles=[...grid.children].filter(e=>e.classList.contains('scenario-unit'));
   nav.hidden=!enabled||!tiles.length;
   if(!enabled){for(const tile of tiles)tile.hidden=false;grid.style.removeProperty('--scene-cols');grid.style.removeProperty('--scene-rows');return;}
   if(!tiles.length)return;
   const scale=(Number(document.documentElement.dataset.textSize)||100)/100;
   const box=grid.getBoundingClientRect();if(box.width<1||box.height<1)return;
   let {cols,rows}=gridSize(box.width,box.height,scale);
   cols=Math.min(cols,tiles.length);rows=Math.min(rows,Math.ceil(tiles.length/cols));
   if(tiles.length<=cols*rows)cols=Math.min(cols,Math.ceil(tiles.length/rows));
   const anchor=page*(capacity||cols*rows);
   let count;
   for(let attempt=0;attempt<30;attempt++){
    count=cols*rows;page=Math.min(Math.floor(anchor/count),Math.max(0,Math.ceil(tiles.length/count)-1));
    const visibleCount=Math.min(count,tiles.length-page*count),visibleCols=Math.min(cols,visibleCount),visibleRows=Math.ceil(visibleCount/visibleCols);
    grid.style.setProperty('--scene-cols',String(visibleCols));grid.style.setProperty('--scene-rows',String(visibleRows));
    tiles.forEach((tile,i)=>{tile.hidden=i<page*count||i>=(page+1)*count;});
    const overflowing=tiles.filter(t=>!t.hidden).some(t=>{const pad=t.querySelector('.scenario-pad');return pad&&(pad.scrollHeight>pad.clientHeight+2||pad.scrollWidth>pad.clientWidth+2);});
    if(!overflowing)break;
    if(rows>1)rows--;else if(cols>1)cols--;else break;
   }
   capacity=count;
   const total=Math.max(1,Math.ceil(tiles.length/count));
   previous.disabled=page===0;next.disabled=page>=total-1;
   const text=(page+1)+' / '+total;if(label.textContent!==text)label.textContent=text;
   nav.style.visibility=total>1?'visible':'hidden';nav.setAttribute('aria-hidden',String(total===1));
   previous.tabIndex=next.tabIndex=total>1?0:-1;
  }
  previous.addEventListener('click',()=>{if(page>0){page--;layout();}});
  next.addEventListener('click',()=>{if((page+1)*capacity<grid.querySelectorAll('.scenario-unit').length){page++;layout();}});
  new MutationObserver(schedule).observe(grid,{childList:true});
  new MutationObserver(schedule).observe(editor,{attributes:true,attributeFilter:['style']});
  new MutationObserver(schedule).observe(document.body,{attributes:true,attributeFilter:['data-view']});
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['data-text-size']});
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(schedule);observer.observe(grid);}
  window.addEventListener('resize',schedule);if(window.visualViewport)window.visualViewport.addEventListener('resize',schedule);
  schedule();
 });
})();
