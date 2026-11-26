'use strict';
const {binding,pulseProfile}=require('./protocol.cjs');
const discoveryEntity=s=>typeof s==='string'&&/^[a-z_]+\.[a-z0-9_]{1,150}$/.test(s);
function discover(rows,registry,devices){
 const states=new Map(rows.map(s=>[s.entity_id,s]));
 return devices.flatMap(d=>{
  const entries=registry.filter(e=>e.platform==='sonoff'&&e.device_id===d.id&&discoveryEntity(e.entity_id));if(!entries.length)return [];
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
 const supported=d.supported!==false;
 const clean={entityId:d.entityId,deviceId:d.deviceId,name:d.name,model:d.model,supported,state:['on','off'].includes(d.state)?d.state:'unknown'};
 if(supported){const parsed=binding({owner:'a'.repeat(64),accountId:'b'.repeat(64),workspaceId:'catalogue',workspaceName:'catalogue',devices:[{...clean,kind:'multi',outlets:d.model==='G2'?[0,1]:[0],...(d.channels?{channels:d.channels}:{})}]}).devices[0];if(parsed.channels)clean.channels=parsed.channels;if(parsed.controlMode){clean.controlMode=parsed.controlMode;clean.pulseMs=parsed.pulseMs;}}
 else clean.reason=typeof d.reason==='string'?d.reason.slice(0,160):'Compatibilità da verificare';
 return clean;
}
module.exports={discover,entry};
