'use strict';
const crypto=require('crypto'),core=require('./programming-core');
const targets=s=>s.kind==='scene'?(s.targets||[]):[s];
const key=(deviceId,outlet)=>deviceId+':'+(outlet===null?'single':outlet);
const channels=t=>t.kind==='multi'?t.outlets:[null];
function latest(s,time){
 const from=s.repeat==='date'?0:time-8*core.DAY;
 return core.events(s,from,time).filter(e=>e.at>=(s.updatedAt||s.createdAt||0)).at(-1)||null;
}
module.exports=function createRecovery({db,now,isImpulseDevice,owned,ensureSolar,access,listDevices,api,runScene,getScene,completedOnce}){
 const ledger=owner=>db().collection('ewelinkProgrammingIntents').doc(owner);
 function eligible(s){return ['on','off'].includes(s.action)&&targets(s).length>0&&targets(s).every(t=>['on','off'].includes(t.action)&&!isImpulseDevice(t.deviceId)&&['single','multi'].includes(t.kind));}
 function fold(entries,s,event,extra={}){
  if(!event)return;
  for(const target of targets(s))for(const outlet of channels(target)){
   const k=key(target.deviceId,outlet),old=entries[k];
   if(!old||event.at>old.at||event.at===old.at&&s.id===old.scheduleId||event.at===old.at&&event.state==='on'&&old.state==='off')
    entries[k]={at:event.at,state:event.state,scheduleId:s.id,version:s.version,...extra};
  }
 }
 async function prepare(owner){
  const ref=ledger(owner),snapshot=await ref.get();if(snapshot.data()?.version===1)return;
  // One-time migration: terminal intents must survive the archival of one-off timers.
  const history=await db().collection('ewelinkProgrammingHistory').where('owner','==',owner).get(),entries={};
  for(const doc of history.docs){const s=doc.data();if(eligible(s))fold(entries,s,latest(s,now()),{committed:true});}
  await db().runTransaction(async t=>{const current=await t.get(ref);if(current.data()?.version===1)return;t.set(ref,{version:1,entries:{...entries,...(current.data()?.entries||{})}});});
 }
 async function claimIntent(t,s,event,claim){
  if(!eligible(s))return;
  const ref=ledger(s.owner),snapshot=await t.get(ref),data=snapshot.data()||{version:1,entries:{}};
  const entries={...data.entries};fold(entries,s,event,{claim,committed:false});t.set(ref,{...data,entries});
 }
 async function finishIntent(t,s,claim,success,fromRecovery=false){
  if(!eligible(s)||!success)return;
  const ref=ledger(s.owner),snapshot=await t.get(ref),data=snapshot.data();if(!data)return;
  const entries={...data.entries};
  for(const[k,v]of Object.entries(entries))if(v.scheduleId===s.id&&v.version===s.version&&(fromRecovery||v.claim===claim))entries[k]={...v,committed:true};
  t.set(ref,{...data,entries});
 }
 function desired(s,records,stored,time){
  const byId=new Map(records.map(r=>[r.id,r])),entries={};
  for(const[k,v]of Object.entries(stored||{})){
   const source=byId.get(v.scheduleId);
   if(source?source.enabled&&source.version===v.version:v.committed)entries[k]=v;
  }
  const enabled=records.filter(r=>r.enabled&&eligible(r));
  for(const record of enabled)fold(entries,record,latest(record,time));
  const result=[];
  for(const target of targets(s))for(const outlet of channels(target)){
   const held=enabled.some(r=>targets(r).some(t=>t.deviceId===target.deviceId&&(t.kind==='single'||t.outlets.includes(outlet)))&&core.activeWindow(r,time));
   const intention=entries[key(target.deviceId,outlet)];
   if(!held&&!intention)throw new Error('Stato previsto non verificabile: controlla la programmazione.');
   result.push({deviceId:target.deviceId,kind:target.kind,outlet,state:held?'on':intention.state});
  }
  return result;
 }
 async function renew(ref,claim,s){
  const budget=180000+65000*targets(s).reduce((n,t)=>n+(t.kind==='multi'?Math.min(2,t.outlets.length):1),0);
  const kept=await db().runTransaction(async t=>{const snapshot=await t.get(ref),data=snapshot.data();if(!data?.enabled||data.version!==s.version||data.last?.id!==claim)return false;const next={...data,last:{...data.last,until:now()+budget}};if(data.recoveryAt)next.recoveryAt=now()+budget;t.set(ref,next);return true;});
  if(!kept)throw new Error('Comando sostituito o programmazione sospesa: nessun invio effettuato.');
 }
 async function run(ref){
  const before=await ref.get(),initial=before.data();
  if(!initial?.enabled||!eligible(initial)||!initial.recoveryAt||initial.recoveryAt>now())return;
  if(initial.last?.status==='claimed'&&initial.last.until>now())return;
  try{await ensureSolar(initial.owner,{...initial,id:ref.id},8);await prepare(initial.owner);}
  catch(e){await db().runTransaction(async t=>{const snap=await t.get(ref),s=snap.data();if(s?.version===initial.version&&s.recoveryAt&&!(s.last?.status==='claimed'&&s.last.until>now()))t.set(ref,{...s,recoveryAt:now()+60000,recovery:{...s.recovery,message:'Ripristino in attesa di dati o connessione validi.'}});});return;}
  const acquired=await db().runTransaction(async t=>{
   const snapshot=await t.get(ref),s=snapshot.data();
   if(!s?.enabled||!eligible(s)||s.version!==initial.version||!s.recoveryAt||s.recoveryAt>now()||s.last?.status==='claimed'&&s.last.until>now())return null;
   const claim=crypto.randomUUID(),last={id:claim,status:'claimed',at:now(),scheduledAt:s.recovery?.since||s.last?.scheduledAt||now(),until:now()+180000,scheduleVersion:s.version,message:'Verifica e ripristino dello stato programmato.'};
   t.set(ref,{...s,recoveryAt:now()+180000,last});return {s:{...s,id:ref.id},claim};
  });if(!acquired)return;
  const {s,claim}=acquired;let status='unknown',message='Ripristino non confermato.',needsReview=false;
  try{
   const credentials=await access(s.owner,{scheduled:true}),records=await owned(s.owner),stored=(await ledger(s.owner).get()).data()?.entries;
   if(s.kind==='scene'){const scene=getScene&&await getScene({cookies:{ewelink_access:credentials.accessToken}},s.sceneId,s.workspaceId);if(!scene||scene.mode!=='toggle'||scene.signature!==s.sceneSignature)throw Object.assign(new Error('Scenario modificato o eliminato: apri e salva di nuovo la programmazione.'),{status:409,code:'scene_changed'});}
   const intended=desired(s,records,stored,now()),devices=await listDevices(credentials.accessToken),groups=new Map();
   // Validate every target before sending anything, including scene targets.
   for(const item of intended){
    const device=devices.find(d=>d.deviceid===item.deviceId);
    if(!device?.online)throw new Error('Ripristino in attesa: dispositivo offline o non più accessibile.');
    const current=item.kind==='multi'?device.params?.switches?.find(c=>c.outlet===item.outlet)?.switch:device.params?.switch;
    if(!['on','off'].includes(current))throw Object.assign(new Error('Stato o canale non verificabile: controlla il dispositivo e salva di nuovo la programmazione.'),{status:409,code:'device_changed'});
    if(current===item.state)continue;
    const k=item.deviceId+':'+item.state;
    if(!groups.has(k))groups.set(k,{deviceId:item.deviceId,kind:item.kind,state:item.state,...(item.kind==='multi'?{outlets:[]}:{} )});
    if(item.kind==='multi')groups.get(k).outlets.push(item.outlet);
   }
   const actions=[...groups.values()];
   if(actions.length&&s.kind==='scene'){
    if(!runScene)throw new Error('Esecuzione scenari non disponibile.');
    await renew(ref,claim,s);const result=await runScene(s,credentials,actions);
    if(result?.status!=='succeeded')throw new Error('Ripristino scenario non completato. Nuova verifica dello stato prima del prossimo tentativo.');
   }else for(const action of actions){
    const params=action.kind==='multi'?{switches:action.outlets.map(outlet=>({outlet,switch:action.state}))}:{switch:action.state};
    await renew(ref,claim,s);await api('/v2/device/thing/status',credentials.accessToken,{type:1,id:action.deviceId,params});
   }
   status='succeeded';message=actions.length?'Stato programmato ripristinato: comandi accettati da eWeLink.':'Stato verificato: il dispositivo è già coerente con le programmazioni attuali.';
  }catch(e){needsReview=[400,403,404,409].includes(e.status)&&e.code!=='scene_busy';message=e.status===401?'Ripristino sospeso: ricollega l’account eWeLink.':String(e.message||message).slice(0,250);}
  await db().runTransaction(async t=>{
   const snapshot=await t.get(ref),data=snapshot.data();if(data?.last?.id!==claim)return;
   const next={...data,last:{...data.last,status,message,finishedAt:now(),until:0}};
   await finishIntent(t,s,claim,status==='succeeded',true);
   if(status==='succeeded'||needsReview){delete next.recovery;delete next.recoveryAt;}
   else{next.recoveryAt=now()+60000;next.recovery={...next.recovery,message};}
   if(completedOnce(next)){t.set(db().collection('ewelinkProgrammingHistory').doc(crypto.createHash('sha256').update(next.owner+':'+ref.id).digest('hex')),{...next,id:ref.id,archivedAt:now(),enabled:false});t.delete(ref);}else t.set(ref,next);
  });
 }
 let migrationPasses=0,migrationAt=0;
 async function adoptLegacy(){
  if(migrationPasses>=2||migrationAt>now())return;
  for(const status of ['unknown','skipped','claimed']){
   const snapshot=await db().collection('ewelinkProgrammingSchedules').where('last.status','==',status).get();
   for(const doc of snapshot.docs){const s=doc.data();if(!s.enabled||!eligible(s)||s.recoveryAt||s.last?.message?.startsWith('Spegnimento evitato:')||status==='claimed'&&s.last.until>now()||(s.last?.scheduleVersion!==undefined?s.last.scheduleVersion!==s.version:s.last?.at<(s.updatedAt||0)))continue;
    await db().runTransaction(async t=>{const current=await t.get(doc.ref),data=current.data();if(data?.enabled&&data.version===s.version&&!data.recoveryAt&&data.last?.id===s.last?.id)t.set(doc.ref,{...data,recoveryAt:now(),recovery:{since:data.last?.scheduledAt||data.last?.at||now(),message:'Verifica dello stato dopo un comando non completato.'}});});
   }
  }
  migrationPasses++;migrationAt=now()+180001;
 }
 return {eligible,prepare,claimIntent,finishIntent,renew,run,adoptLegacy};
};
