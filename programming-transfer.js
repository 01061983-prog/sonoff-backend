'use strict';
// Called only after administrator authentication, desktop and CSRF validation.
// Moves existing documents atomically; never executes a timer or copies tokens.
module.exports=function({db,programming,listDevices,now=Date.now}){
 const fail=(code,msg)=>Object.assign(new Error(msg),{status:409,code});
 const collection=name=>db().collection(name);
 const schedules=owner=>collection('ewelinkProgrammingSchedules').where('owner','==',owner);
 const rows=snap=>snap.docs.filter(d=>!d.data().archivedAt).map(d=>({...d.data(),id:d.id}));
 const fingerprint=values=>values.map(s=>[s.id,s.version]).sort((a,b)=>a[0].localeCompare(b[0]));
 const org=snap=>({revision:snap.data()?.revision||0,folders:snap.data()?.folders||[],assignments:snap.data()?.assignments||{}});
 function check(records){
  if(records.some(s=>s.kind==='scene'||s.kind==='daikin'||s.targetType==='scene'||s.targetType==='daikin'||!['on','off'].includes(s.action)))throw fail('transfer_target','Il trasferimento automatico supporta solo programmazioni ON/OFF di singoli dispositivi. Scenari, clima e impulsi richiedono una verifica dedicata.');
  if(records.some(s=>s.last?.status==='claimed'&&s.last.until>now()))throw fail('transfer_busy','Un comando programmato è in esecuzione. Attendi e ripeti l’anteprima.');
 }
 async function preview({source,target}){
  if(source===target)throw fail('transfer_same','I due accessi usano già lo stesso archivio. Non occorre trasferire programmi.');
  const snap=await schedules(source).get(),records=rows(snap);check(records);
  const sourceOrg=org(await collection('ewelinkProgrammingOrganization').doc(source).get());
  const targetOrg=org(await collection('ewelinkProgrammingOrganization').doc(target).get());
  return {source,target,versions:fingerprint(records),sourceRevision:sourceOrg.revision,targetRevision:targetOrg.revision,
   names:records.map(s=>s.name||s.deviceName||s.id),folders:sourceOrg.folders.map(f=>f.name)};
 }
 async function execute({proof,actorId,targetId,readConnections}){
  const {source,target}=proof;
  // Validate the destination grant before changing ownership. Reads only.
  const credentials=await programming().access(target);
  const devices=await listDevices(credentials.accessToken);
  const key=require('crypto').createHash('sha256').update(JSON.stringify([actorId,targetId,proof])).digest('hex');
  const transferRef=collection('ewelinkProgrammingTransfers').doc(key);
  return db().runTransaction(async t=>{
   const done=await t.get(transferRef);if(done.exists)return {alreadyTransferred:true,count:done.data().count};
   const actorRef=collection('ewelinkAppAccounts').doc(actorId),targetRef=collection('ewelinkAppAccounts').doc(targetId);
   const actorSnap=await t.get(actorRef),targetSnap=await t.get(targetRef);
   const actor=actorSnap.data(),customer=targetSnap.data();
   if(!actor||actor.role!=='admin'||actor.status!=='active'||!readConnections(actor).some(c=>c.owner===source)||!customer||customer.status!=='active'||customer.providerOwner!==target)throw fail('transfer_account','La plancia o il collegamento sono cambiati. Ripeti l’anteprima.');
   const sourceSnap=await t.get(schedules(source)),destinationRows=await t.get(schedules(target));
   const records=rows(sourceSnap),existing=rows(destinationRows);check(records);
   const sourceOrgRef=collection('ewelinkProgrammingOrganization').doc(source),targetOrgRef=collection('ewelinkProgrammingOrganization').doc(target);
   const from=org(await t.get(sourceOrgRef)),to=org(await t.get(targetOrgRef));
   const sourceAccount=await t.get(collection('ewelinkProgrammingAccounts').doc(source));
   const targetAccountRef=collection('ewelinkProgrammingAccounts').doc(target),targetAccount=await t.get(targetAccountRef);
   const sourceIntentRef=collection('ewelinkProgrammingIntents').doc(source),targetIntentRef=collection('ewelinkProgrammingIntents').doc(target);
   const sourceIntent=(await t.get(sourceIntentRef)).data()||{},targetIntent=(await t.get(targetIntentRef)).data()||{};
   if(JSON.stringify(fingerprint(records))!==JSON.stringify(proof.versions)||from.revision!==proof.sourceRevision||to.revision!==proof.targetRevision)throw fail('transfer_changed','Cartelle o programmi sono cambiati. Ripeti l’anteprima prima di trasferire.');
   if(records.length+existing.length>100)throw fail('transfer_limit','La plancia di destinazione supererebbe il limite di 100 programmazioni.');
   if(!sourceAccount.data()?.credentials||sourceAccount.data()?.revoked||sourceAccount.data()?.reauthRequired)throw fail('transfer_auth','Ricollega il collegamento sorgente prima del trasferimento.');
   if(!targetAccount.data()?.credentials||targetAccount.data()?.revoked||targetAccount.data()?.reauthRequired)throw fail('transfer_auth','Ricollega eWeLink nella plancia cliente prima del trasferimento.');
   for(const s of records){
    const d=devices.find(d=>d.deviceid===s.deviceId);
    const outlets=Array.isArray(d?.params?.switches)?d.params.switches.map(c=>c.outlet):['on','off'].includes(d?.params?.switch)?[0]:[];
    if(!d||s.kind==='single'&&!['on','off'].includes(d.params?.switch)||s.kind==='multi'&&!Array.isArray(d.params?.switches)||!(s.outlets||[]).every(o=>outlets.includes(o)&&(!d.controlOutlets||d.controlOutlets.includes(o))))throw fail('transfer_device','Il dispositivo o i canali di «'+(s.name||s.deviceName)+'» non sono disponibili nella plancia cliente. Nessun programma è stato trasferito.');
   }
   const folders=[...to.folders],mapping=new Map();
   for(const f of from.folders){
    let dest=folders.find(x=>x.name.toLocaleLowerCase('it')===f.name.toLocaleLowerCase('it'));
    if(!dest){dest={...f,id:folders.some(x=>x.id===f.id)?require('crypto').randomUUID():f.id};folders.push(dest);}
    mapping.set(f.id,dest.id);
   }
   if(folders.length>50)throw fail('transfer_limit','La plancia di destinazione supererebbe il limite di 50 cartelle.');
   const assignments={...to.assignments};
   for(const s of records){const folder=mapping.get(from.assignments[s.id]);if(folder)assignments[s.id]=folder;}
   const movedVersions=new Map(records.map(s=>[s.id,(s.version||0)+1])),remainingIntents={},mergedIntents={...(targetIntent.entries||{})};
   for(const[k,v]of Object.entries(sourceIntent.entries||{})){
    if(!movedVersions.has(v.scheduleId)){remainingIntents[k]=v;continue;}
    const old=mergedIntents[k];if(!old||v.at>old.at||v.at===old.at&&v.state==='on'&&old.state==='off')mergedIntents[k]={...v,version:movedVersions.get(v.scheduleId)};
   }
   // All reads above; all writes below. Same IDs, timing and execution history.
   for(const s of records){const {id,...value}=s;t.set(collection('ewelinkProgrammingSchedules').doc(id),{...value,owner:target,version:(s.version||0)+1,...(value.last?.scheduleVersion===s.version?{last:{...value.last,scheduleVersion:(s.version||0)+1}}:{})});}
   if(Object.keys(sourceIntent.entries||{}).length){t.set(sourceIntentRef,{...sourceIntent,entries:remainingIntents});t.set(targetIntentRef,{...targetIntent,entries:mergedIntents});}
   t.set(sourceOrgRef,{folders:[],assignments:{},revision:from.revision+1,updatedAt:now()});
   t.set(targetOrgRef,{folders,assignments,revision:to.revision+1,updatedAt:now()});
   if(records.length&&sourceAccount.data()?.automationEnabled!==false)t.set(targetAccountRef,{automationEnabled:true,updatedAt:now()},{merge:true});
   t.set(actorRef,{providerConnections:readConnections(actor).map(c=>c.owner===source?{...c,workspaceAccountId:targetId}:c),updatedAt:now()},{merge:true});
   t.set(transferRef,{actorId,targetId,source,target,count:records.length,at:now()});
   return {count:records.length};
  });
 }
 return {preview,execute};
};
