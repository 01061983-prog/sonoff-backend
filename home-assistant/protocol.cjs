'use strict';
const crypto=require('node:crypto');
const fail=(status,code,message)=>Object.assign(new Error(message||code),{status,code});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const id=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const entity=s=>typeof s==='string'&&/^(switch|light)\.[a-z0-9_]{1,150}$/.test(s);
function binding(input){
 if(!input||!id(input.owner)||!id(input.accountId)||typeof input.workspaceId!=='string'||!input.workspaceId||input.workspaceId.length>160||typeof input.workspaceName!=='string'||!input.workspaceName.trim()||input.workspaceName.length>100||!Array.isArray(input.devices)||!input.devices.length||input.devices.length>200)throw fail(400,'ha_mapping','Mappatura Home Assistant incompleta.');
 const workspaces=input.workspaces;if(workspaces!==undefined&&(!Array.isArray(workspaces)||!workspaces.length||workspaces.length>20||workspaces.some(h=>!h||typeof h.id!=='string'||!h.id||h.id.length>160||typeof h.name!=='string'||!h.name.trim()||h.name.length>100)||new Set(workspaces.map(h=>h.id)).size!==workspaces.length||!workspaces.some(h=>h.id===input.workspaceId)))throw fail(400,'ha_workspaces','Case della plancia non valide.');
 const ids=new Set(),entities=new Set();
 const devices=input.devices.map(d=>{
  if(!d||typeof d.deviceId!=='string'||!/^[a-f0-9]{10}$/i.test(d.deviceId)||!entity(d.entityId)||!['single','multi'].includes(d.kind)||typeof d.name!=='string'||!d.name.trim()||d.name.length>100||ids.has(d.deviceId)||entities.has(d.entityId))throw fail(400,'ha_mapping','Ogni relè richiede un ID PACE e una sola entità switch/light univoci.');
  ids.add(d.deviceId);entities.add(d.entityId);
  // Initial migration is deliberately limited to verified single-relay MINIR4s.
  if(d.kind==='multi'&&(!Array.isArray(d.outlets)||d.outlets.length!==1||d.outlets[0]!==0))throw fail(400,'ha_channels','MINIR4 supporta soltanto il relè fisico CH 1 (outlet 0).');
  return {deviceId:d.deviceId,name:d.name.trim(),entityId:d.entityId,kind:d.kind,outlets:d.kind==='multi'?[0]:[],model:'MINIR4'};
 });
 return {owner:input.owner,accountId:input.accountId,workspaceId:input.workspaceId,workspaceName:input.workspaceName.trim(),devices,...(workspaces?{workspaces:workspaces.map(h=>({id:h.id,name:h.name.trim()}))}:{})};
}
function safeState(s){
 if(!s||!entity(s.entity_id)||typeof s.state!=='string')throw fail(400,'ha_state','Stato Home Assistant non valido.');
 return {entity_id:s.entity_id,state:['on','off','unavailable','unknown'].includes(s.state)?s.state:'unknown',last_updated:typeof s.last_updated==='string'?s.last_updated:null};
}
module.exports={fail,hash,id,entity,binding,safeState};
