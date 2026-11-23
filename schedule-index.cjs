'use strict';
const quota=require('./firebase-quota.cjs');
// The stream is an execution index, never authorization. Commands still claim and
// validate the current schedule in a Firestore transaction before dispatch.
module.exports=function createIndex({query,onChange=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,quotaGuard=quota}){
 let unsubscribe=null,retry=null,docs=null,stopped=true,generation=0,detachQuota=null;
 function pause(){
  if(stopped)return;docs=null;++generation;unsubscribe?.();unsubscribe=null;if(retry)clearTimer(retry);
  retry=setTimer(()=>{retry=null;restart();},Math.max(60000,quotaGuard.wait()));retry?.unref?.();onChange();
 }
 function restart(){
  if(stopped||unsubscribe||retry)return;
  try{
   quotaGuard.check();const q=query();if(typeof q.onSnapshot!=='function')return;
   const gen=++generation;
   const cancel=q.onSnapshot(snapshot=>{if(stopped||gen!==generation)return;docs=snapshot.docs;onChange();},e=>{
    if(stopped||gen!==generation)return;quotaGuard.record(e);if(gen===generation)pause();
   });
   if(gen===generation&&!stopped)unsubscribe=cancel;else cancel();
  }catch(e){const gen=generation;quotaGuard.record(e);if(gen===generation)pause();}
 }
 return {
  start(){stopped=false;if(!detachQuota)detachQuota=quotaGuard.onPause(pause);restart();},
  all(){return docs===null?null:{docs};},
  due(field,time,limit=Infinity){return docs===null?null:{docs:docs.filter(d=>Number.isFinite(d.data()[field])&&d.data()[field]<=time).sort((a,b)=>a.data()[field]-b.data()[field]).slice(0,limit)};},
  stop(){stopped=true;detachQuota?.();detachQuota=null;++generation;unsubscribe?.();unsubscribe=null;if(retry)clearTimer(retry);retry=null;docs=null;}
 };
};
