/* Preferenza di lettura locale: nessun dato inviato al server. */
(()=>{
 'use strict';
 const key='ewelink_text_size_v1',sizes=[100,125,150,175,200];
 const legacyStartKey='ewelink_start_view_v1',views=['scenes','rooms','devices','home','climate'];
 const climateReturn=/[?&]daikin=/.test(location.search)||location.hash==='#clima';
 const accountState=()=>window.AppAccounts?.state;
 function startKey(){const state=accountState();return state?.enabled?(state.account?.id&&state.selectedProvider?'ewelink_start_view_v2:'+state.account.id+':'+state.selectedProvider:null):legacyStartKey;}
 function readStart(){
  const current=startKey();if(!current)return 'scenes';
  try{
   const saved=localStorage.getItem(current);if(views.includes(saved))return saved;
   const state=accountState();
   if(saved===null&&state?.enabled&&state.selectedProvider===state.primaryProvider){
    const legacy=localStorage.getItem(legacyStartKey);if(views.includes(legacy)){try{localStorage.setItem(current,legacy);}catch{}return legacy;}
   }
  }catch{}
  return 'scenes';
 }
 function syncStart(){const start=document.getElementById('appStartView'),status=document.getElementById('appStartStatus');if(start)start.value=readStart();if(status){const name=accountState()?.selectedProviderLabel;status.textContent=name?'Pagina iniziale di '+name+' salvata solo su questo dispositivo.':'La pagina iniziale si salva automaticamente su questo dispositivo.';}}
 window.AppPreferences={initialView:()=>climateReturn?'climate':readStart(),accountReady:syncStart};
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
  start.value=readStart();
  start.addEventListener('change',()=>{
   const value=views.includes(start.value)?start.value:'scenes',current=startKey();start.value=value;
   if(!current){startStatus.textContent='Attendi il collegamento dell’account eWeLink prima di salvare.';return;}
   try{localStorage.setItem(current,value);const name=accountState()?.selectedProviderLabel;startStatus.textContent='Pagina iniziale salvata'+(name?' per '+name:'')+' su questo dispositivo.';}
   catch{startStatus.textContent='Questo browser non permette di salvare la pagina iniziale.';}
  });
  window.addEventListener('storage',event=>{if(event.key===startKey()||event.key===null)start.value=readStart();});
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
