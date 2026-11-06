/* Preferenza di lettura locale: nessun dato inviato al server. */
(()=>{
 'use strict';
 const key='ewelink_text_size_v1',sizes=[100,125,150,175,200];
 const startKey='ewelink_start_view_v1',views=['scenes','rooms','devices','home'];
 let startView='scenes';
 try{const saved=localStorage.getItem(startKey);if(views.includes(saved))startView=saved;}catch{}
 window.AppPreferences={initialView:()=>startView};
 const normalize=value=>sizes.includes(Number(value))?Number(value):100;
 let size=100;
 try{size=normalize(localStorage.getItem(key));}catch{}
 function apply(value){
  size=normalize(value);
  document.documentElement.style.setProperty('--text-scale',String(size/100));
  document.documentElement.dataset.textSize=String(size);
 }
 apply(size);
 document.addEventListener('DOMContentLoaded',()=>{
  const slider=document.getElementById('textSizeRange'),output=document.getElementById('textSizeValue'),status=document.getElementById('textSizeStatus'),decrease=document.getElementById('textSizeDecrease'),increase=document.getElementById('textSizeIncrease'),reset=document.getElementById('textSizeReset');
  const start=document.getElementById('appStartView'),startStatus=document.getElementById('appStartStatus');
  start.value=startView;
  start.addEventListener('change',()=>{
   startView=views.includes(start.value)?start.value:'scenes';start.value=startView;
   try{localStorage.setItem(startKey,startView);startStatus.textContent='Pagina iniziale salvata. Verrà aperta al prossimo avvio.';}
   catch{startStatus.textContent='Questo browser non permette di salvare la pagina iniziale.';}
  });
  window.addEventListener('storage',event=>{if(event.key===startKey||event.key===null){startView=views.includes(event.newValue)?event.newValue:'scenes';start.value=startView;}});
  function render(){slider.value=String(size);output.textContent=size+'%';slider.setAttribute('aria-valuetext',size+' per cento');decrease.disabled=size===100;increase.disabled=size===200;reset.disabled=size===100;}
  function change(value){
   apply(value);render();
   try{localStorage.setItem(key,String(size));status.textContent='Dimensione salvata su questo dispositivo.';}
   catch{status.textContent='Dimensione applicata. Questo browser non permette di salvarla: alla riapertura potrebbe tornare normale.';}
  }
  slider.addEventListener('input',()=>change(slider.value));
  decrease.addEventListener('click',()=>change(size-25));increase.addEventListener('click',()=>change(size+25));reset.addEventListener('click',()=>change(100));
  window.addEventListener('storage',event=>{if(event.key===key||event.key===null){apply(event.newValue);render();}});
  render();
 });
})();
