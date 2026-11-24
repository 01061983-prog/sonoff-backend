'use strict';
const fs=require('node:fs'),path=require('node:path'),{fail,hash}=require('../protocol.cjs');
module.exports=function createJournal({file,now=Date.now}){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});let records={};if(fs.existsSync(file)){records=JSON.parse(fs.readFileSync(file,'utf8'));if(!records||Array.isArray(records)||typeof records!=='object')throw Error('Invalid command journal');}
 const persist=()=>{const temp=file+'.tmp',fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(records));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}};
 let chain=Promise.resolve();
 return {run(command,operation){const task=chain.then(async()=>{
  const fingerprint=hash(JSON.stringify([command.entityId,command.state,command.revision]));const old=records[command.id];if(old){if(old.fingerprint!==fingerprint)throw fail(409,'ha_duplicate_mismatch');return old.result||{status:'uncertain'};}
  if(command.expiresAt<=now())return {status:'failed'};
  // Write before dispatch. After a crash an existing pending receipt is uncertain,
  // never grounds for replaying a physical command.
  if(Object.keys(records).length>=10000){for(const[id,r]of Object.entries(records))if(r.at<now()-30*86400000)delete records[id];if(Object.keys(records).length>=10000)throw fail(503,'ha_journal_full');}
  records[command.id]={fingerprint,at:now()};persist();
  let result;try{const state=await operation();result={status:'confirmed',state};}catch(e){result={status:['ha_entity','ha_device_offline'].includes(e.code)?'failed':'uncertain'};}
  records[command.id].result=result;persist();return result;
 });chain=task.catch(()=>{});return task;}};
};
