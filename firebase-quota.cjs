'use strict';
function create({now=Date.now,cooldown=3600000}={}){
 let until=0;const listeners=new Set();
 const error=()=>Object.assign(new Error('Servizio PACE temporaneamente sospeso: quota Firebase esaurita. Le richieste al database sono in pausa.'),{status:503,code:'firebase_quota',retryAfterMs:Math.max(1000,until-now())});
 return {
  record(e){if(e?.code==='firebase_quota')return e;if(Number(e?.code)===8&&/quota exceeded|resource_exhausted/i.test(String(e.message||''))){const previous=until;until=Math.max(until,now()+cooldown);if(until>previous)for(const notify of listeners)notify();return error();}return e;},
  check(){if(until>now())throw error();},
  onPause(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
  wait(){return Math.max(0,until-now());}
 };
}
module.exports=create();module.exports.create=create;
