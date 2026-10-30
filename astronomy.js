'use strict';
const crypto=require('crypto'),core=require('./programming-core');
const PAVIA={name:'Pavia',latitude:45.19205,longitude:9.15917};
const failure=message=>Object.assign(new Error(message),{status:503,code:'astronomy_unavailable'});
function location(value=PAVIA){
 if(!value||typeof value.name!=='string'||!value.name.trim()||value.name.length>80||typeof value.latitude!=='number'||typeof value.longitude!=='number'||!Number.isFinite(value.latitude)||!Number.isFinite(value.longitude)||Math.abs(value.latitude)>90||Math.abs(value.longitude)>180)throw Object.assign(new Error('Indica una località e coordinate valide.'),{status:400,code:'invalid_location'});
 return {name:value.name.trim(),latitude:Number(value.latitude.toFixed(5)),longitude:Number(value.longitude.toFixed(5))};
}
module.exports=function createAstronomy({db,fetch:request=globalThis.fetch,now=Date.now}){
 const memory=new Map(),pending=new Map();
 async function month(loc,key){
  const id=crypto.createHash('sha256').update(`${loc.latitude}:${loc.longitude}:${key}:Europe/Rome:v2`).digest('hex');
  if(memory.has(id))return memory.get(id);
  if(pending.has(id))return pending.get(id);
  const work=(async()=>{
   const ref=db().collection('ewelinkSolarCalendar').doc(id),snap=await ref.get();
   if(snap.exists&&snap.data().version===1){const data=snap.data();memory.set(id,data);return data;}
   const from=key+'-01',to=new Date(Date.UTC(Number(key.slice(0,4)),Number(key.slice(5,7)),0)).toISOString().slice(0,10);
   const url=new URL('https://api.sunrise-sunset.org/v2');
   for(const[k,v]of Object.entries({lat:loc.latitude,lng:loc.longitude,date_start:from,date_end:to,tz:core.ZONE}))url.searchParams.set(k,String(v));
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
   let body;
   try{const response=await request(url.href,{signal:controller.signal});if(!response.ok)throw failure('Servizio astronomico temporaneamente non disponibile.');body=await response.json();}
   catch{throw failure('Impossibile aggiornare alba e tramonto da Internet. Riprova tra poco.');}
   finally{clearTimeout(timeout);}
   if(body.tzid!==core.ZONE||typeof body.lat!=='number'||typeof body.lng!=='number'||Math.abs(body.lat-loc.latitude)>0.0001||Math.abs(body.lng-loc.longitude)>0.0001||!Array.isArray(body.days))throw failure('Risposta astronomica non valida.');
   const days={};
   for(const row of body.days){
    if(!core.validDate(row.date)||row.date<from||row.date>to||days[row.date])throw failure('Date astronomiche non valide.');
    const entry={};
    for(const event of ['sunrise','sunset']){
     if(row[event]===null){entry[event]=null;continue;}
     if(typeof row[event]!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(row[event]))throw failure('Orario astronomico senza fuso valido.');
     const value=Date.parse(row[event]);
     if(!Number.isFinite(value)||core.dateKey(value)!==row.date)throw failure('Orario astronomico non valido per il giorno richiesto.');
     entry[event]=value;
    }
    days[row.date]=entry;
   }
   for(let date=from;date<=to;date=core.addDays(date,1))if(!days[date])throw failure('Calendario astronomico incompleto. Nessun orario inventato.');
   const data={version:1,days,updatedAt:now(),source:'https://sunrise-sunset.org'};
   await ref.set(data);if(memory.size>=128)memory.delete(memory.keys().next().value);memory.set(id,data);return data;
  })();pending.set(id,work);
  try{return await work;}finally{pending.delete(id);}
 }
 async function calendar(value,from,to){
  const loc=location(value);
  if(!core.validDate(from)||!core.validDate(to)||to<from||Date.parse(to)-Date.parse(from)>366*core.DAY)throw Object.assign(new Error('Intervallo astronomico non valido: massimo un anno.'),{status:400,code:'invalid_schedule'});
  const days={},keys=new Set();for(let d=from;d<=to;d=core.addDays(d,1))keys.add(d.slice(0,7));
  let updatedAt=0;
  for(const key of keys){const data=await month(loc,key);Object.assign(days,data.days);updatedAt=Math.max(updatedAt,data.updatedAt);}
  for(const date of Object.keys(days))if(date<from||date>to)delete days[date];
  return {location:loc,days,from,through:to,updatedAt,source:'https://sunrise-sunset.org'};
 }
 async function prepare(input){
  // Never accept a calendar or a timestamp supplied by the browser.
  const clean={...input};delete clean.solar;
  if(!core.usesSolar(clean))return clean;
  if(clean.repeat==='date'&&(!core.validDate(clean.date)||clean.endDate&&!core.validDate(clean.endDate)))throw Object.assign(new Error('Data non valida.'),{status:400,code:'invalid_schedule'});
  const today=core.dateKey(now()),from=core.addDays(clean.repeat==='date'?clean.date:today,-1),to=core.addDays(clean.repeat==='date'?(clean.endDate||clean.date):today,clean.repeat==='date'?1:40);
  clean.solar=await calendar(clean.location,from,to);return clean;
 }
 return {prepare,calendar,location,PAVIA};
};
module.exports.PAVIA=PAVIA;
