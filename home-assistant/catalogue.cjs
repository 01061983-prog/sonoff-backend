'use strict';
const {binding,pulseProfile,hash,fail,channels}=require('./protocol.cjs');
const discoveryEntity=s=>typeof s==='string'&&/^[a-z_]+\.[a-z0-9_]{1,150}$/.test(s);
function discover(rows,registry,devices){
 const states=new Map(rows.map(s=>[s.entity_id,s]));
 return devices.flatMap(d=>{
  const matter=registry.filter(e=>e.platform==='matter'&&e.device_id===d.id&&discoveryEntity(e.entity_id));
  if(matter.length){
   const controls=matter.filter(e=>e.entity_id.startsWith('switch.')&&!e.disabled_by&&!e.entity_category),primary=controls[0]||matter[0];
   const category=primary.device_class||primary.original_device_class||states.get(primary.entity_id)?.attributes?.device_class;
   const safe=controls.length===1&&category==='outlet';
   // Registry identity survives entity renames. Preserve IDs explicitly migrated in HA.
   const identity=(d.identifiers||[]).filter(v=>Array.isArray(v)&&v[0]==='matter').map(v=>String(v[1])).sort();
   const legacy=primary.entity_id.match(/_sonoff_([a-f0-9]{10})_1$/)?.[1];
   const deviceId=legacy||hash('matter:'+JSON.stringify(identity.length?identity:[d.id])).slice(0,10);
   const state=states.get(primary.entity_id)?.state;
   return [{deviceId,entityId:primary.entity_id,name:String(d.name_by_user||d.name||states.get(primary.entity_id)?.attributes?.friendly_name||'Presa Matter').slice(0,100),model:String(d.model||'Presa Matter').slice(0,100),source:'matter',supported:safe,state:safe&&['on','off'].includes(state)?state:'unknown',...(!safe?{reason:'Dispositivo Matter rilevato; supportate le prese con un solo comando ON/OFF'}:{})}];
  }
  if(registry.some(e=>e.platform==='sonoff'&&e.device_id===d.id&&e.entity_id?.endsWith('_legacy')))return [];
  const entries=registry.filter(e=>e.platform==='sonoff'&&e.device_id===d.id&&discoveryEntity(e.entity_id)&&!e.entity_id.endsWith('_legacy'));if(!entries.length)return [];
  const deviceId=(d.identifiers||[]).find(v=>Array.isArray(v)&&v[0]==='sonoff'&&/^[a-f0-9]{10}$/.test(v[1]))?.[1]||entries.map(e=>e.entity_id.match(/_sonoff_([a-f0-9]{10})(?:_|$)/)?.[1]).find(Boolean);if(!deviceId)return [];
  const controls=entries.filter(e=>/^(switch|light)\./.test(e.entity_id)&&!e.disabled_by),model=String(d.model||'Sconosciuto').slice(0,100);
  const pulse=pulseProfile({deviceId,model,entityId:controls.find(e=>e.entity_id.endsWith('_1'))?.entity_id});
  const expected=model==='G2'?2:['MINIR4','S61STPF'].includes(model)||pulse?1:0;
  const physical=controls.filter(e=>(!pulse||e.entity_id===pulse.entityId)&&new RegExp('_sonoff_'+deviceId+'_[12]$').test(e.entity_id)).sort((a,b)=>a.entity_id.localeCompare(b.entity_id));
  const safe=expected>0&&physical.length===expected&&physical.every((e,i)=>e.entity_id.endsWith('_'+(i+1)));
  const primary=physical[0]||controls[0]||entries[0],state=states.get(primary.entity_id);
  const result={deviceId,entityId:primary.entity_id,name:String(d.name_by_user||d.name||state?.attributes?.friendly_name||deviceId).slice(0,100),model,supported:safe,state:safe&&physical.every(e=>['on','off'].includes(states.get(e.entity_id)?.state))?(physical.some(e=>states.get(e.entity_id).state==='on')?'on':'off'):'unknown'};
  if(safe&&pulse){result.controlMode='pulse';result.pulseMs=pulse.pulseMs;}
  if(safe&&expected===2)result.channels=physical.map((e,outlet)=>({outlet,entityId:e.entity_id}));
  if(!safe)result.reason=expected?'Canali fisici da verificare':'Modello rilevato; controllo da integrare in PACE';
  return [result];
 }).slice(0,200);
}
function entry(d){
 if(!d||!discoveryEntity(d.entityId)||! /^[a-f0-9]{10}$/.test(d.deviceId)||typeof d.model!=='string'||!d.model||d.model.length>100||typeof d.name!=='string'||!d.name||d.name.length>100||![undefined,true,false].includes(d.supported))throw Error('Invalid catalogue');
 if(d.source!==undefined&&d.source!=='matter')throw Error('Invalid catalogue source');
 const supported=d.supported!==false;
 const clean={entityId:d.entityId,deviceId:d.deviceId,name:d.name,model:d.model,supported,...(d.source?{source:d.source}:{}),state:['on','off'].includes(d.state)?d.state:'unknown'};
 if(supported){const parsed=binding({owner:'a'.repeat(64),accountId:'b'.repeat(64),workspaceId:'catalogue',workspaceName:'catalogue',devices:[{...clean,kind:'multi',outlets:d.source!=='matter'&&d.model==='G2'?[0,1]:[0],...(d.channels?{channels:d.channels}:{})}]}).devices[0];if(parsed.channels)clean.channels=parsed.channels;if(parsed.controlMode){clean.controlMode=parsed.controlMode;clean.pulseMs=parsed.pulseMs;}}
 else clean.reason=typeof d.reason==='string'?d.reason.slice(0,160):'Compatibilità da verificare';
 return clean;
}
// Only an explicit replacement can reuse a saved PACE identity. No name matching.
function addDevices(config,entityIds,found,replacements={}){
 if(!Array.isArray(entityIds)||!entityIds.length||entityIds.length>200||new Set(entityIds).size!==entityIds.length||!replacements||typeof replacements!=='object'||Array.isArray(replacements)||Object.keys(replacements).some(e=>!entityIds.includes(e)))throw fail(400,'ha_mapping');
 const devices=config.devices.map(d=>({...d})),used=new Set();
 for(const entityId of entityIds){
  const d=found.find(d=>d.entityId===entityId);if(!d||d.supported===false)throw fail(400,'ha_mapping','Ripeti la ricerca dei dispositivi.');
  const replacement=Object.prototype.hasOwnProperty.call(replacements,entityId)?replacements[entityId]:null;
  if(replacement!==null){
   const index=devices.findIndex(old=>old.deviceId===replacement),old=devices[index];
   if(!old||used.has(replacement)||d.source!=='matter'||old.controlMode==='pulse'||channels(old).length!==1||devices.some((old,i)=>i!==index&&(old.entityId===entityId||old.deviceId===d.deviceId)))throw fail(400,'ha_replacement','Sostituzione del collegamento non valida.');
   used.add(replacement);devices[index]={...d,deviceId:old.deviceId,name:old.name,kind:old.kind,outlets:old.outlets};
  }else if(!devices.some(old=>old.entityId===entityId)){
   if(devices.some(old=>old.deviceId===d.deviceId))throw fail(409,'ha_duplicate','Dispositivo già collegato.');
   devices.push({...d,kind:'multi',outlets:d.channels?d.channels.map(c=>c.outlet):[0]});
  }
 }
 return devices;
}
module.exports={discover,entry,addDevices};
