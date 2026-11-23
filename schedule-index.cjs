'use strict';
const quota=require('./firebase-quota.cjs');
// The stream is an execution index, never authorization. Commands still claim and
// validate the current schedule in a Firestore transaction before dispatch.
module.exports=function createIndex({query,onChange=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 let unsubscribe=null,retry=null,docs=null,stopped=true,generation=0;
 function restart(){
  if(stopped||unsubscribe||retry)return;
  try{
   quota.check();const q=query();if(typeof q.onSnapshot!=='function')return;
   const gen=++generation;
   const cancel=q.onSnapshot(snapshot=>{if(stopped||gen!==generation)return;docs=snapshot.docs;onChange();},e=>{
    if(stopped||gen!==generation)return;docs=null;unsubscribe=null;quota.record(e);++generation;
    retry=setTimer(()=>{retry=null;restart();},Math.max(60000,quota.wait()));retry?.unref?.();onChange();
   });
   if(gen===generation&&!stopped)unsubscribe=cancel;else cancel();
  }catch(e){quota.record(e);docs=null;retry=setTimer(()=>{retry=null;restart();},Math.max(60000,quota.wait()));retry?.unref?.();}
 }
 return {
  start(){stopped=false;restart();},
  all(){return docs===null?null:{docs};},
  due(field,time,limit=Infinity){return docs===null?null:{docs:docs.filter(d=>Number.isFinite(d.data()[field])&&d.data()[field]<=time).sort((a,b)=>a.data()[field]-b.data()[field]).slice(0,limit)};},
  stop(){stopped=true;++generation;unsubscribe?.();unsubscribe=null;if(retry)clearTimer(retry);retry=null;docs=null;}
 };
};
