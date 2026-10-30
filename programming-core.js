'use strict';
const ZONE='Europe/Rome', NEVER=8640000000000000, DAY=86400000;
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function localParts(ms){return Object.fromEntries(fmt.formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
function dateKey(ms){const p=localParts(ms);return `${p.year}-${p.month}-${p.day}`;}
function addDays(date,n){return new Date(Date.parse(date+'T12:00:00Z')+n*DAY).toISOString().slice(0,10);}
function validDate(date){return /^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date+'T12:00:00Z'))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;}
function localTime(date,time,end=false){
 if(!validDate(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return null;
 const guess=Date.parse(date+'T'+time+':00Z'),candidates=new Set();
 for(const sample of [guess-DAY,guess,guess+DAY]){
  const p=localParts(sample),offset=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`)-Math.floor(sample/60000)*60000;
  const result=guess-offset,q=localParts(result);
  if(`${q.year}-${q.month}-${q.day}`===date&&`${q.hour}:${q.minute}`===time)candidates.add(result);
 }
 const values=[...candidates].sort((a,b)=>a-b);return values.length?(end?values.at(-1):values[0]):null;
}
function windows(s,from,to){
 const dates=[];
 if(s.repeat==='date')dates.push(s.date);
 else {for(let d=addDays(dateKey(from),-1),last=dateKey(to),i=0;d<=last&&i<370;d=addDays(d,1),i++)if(s.days.includes(new Date(d+'T12:00:00Z').getUTCDay()))dates.push(d);}
 return dates.map(date=>({start:localTime(date,s.start),end:s.end?localTime(s.repeat==='date'&&s.endDate?s.endDate:addDays(date,s.end<=s.start?1:0),s.end,true):null})).filter(w=>w.start!==null&&(!s.end||w.end!==null));
}
function events(s,from,to){
 return windows(s,from,to).flatMap(w=>[{at:w.start,state:s.action==='off'?'off':'on',pulse:s.action==='pulse'},...(w.end?[{at:w.end,state:'off',pulse:false}]:[])]).filter(e=>e.at>from&&e.at<=to).sort((a,b)=>a.at-b.at);
}
function nextEvent(s,after){if(!s.enabled)return null;return events(s,after,after+9*DAY).find(e=>e.at>after)|| (s.repeat==='date' ? events(s,after,NEVER-1).find(e=>e.at>after):null)||null;}
function validate(input,device,now=Date.now()){
 const err=message=>{throw Object.assign(new Error(message),{status:400,code:'invalid_schedule'});};
 if(!input||!device||input.deviceId!==device.deviceid)err('Seleziona un dispositivo del tuo account.');
 if(!['on','off','pulse'].includes(input.action))err('Scegli accensione, spegnimento o impulso.');
 if(!['date','weekly'].includes(input.repeat))err('Scegli una data o i giorni della settimana.');
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start||''))err('Indica un orario valido.');
 const end=input.end||null;
 if(end&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(end)||input.action!=='on'||end===input.start))err('Lo spegnimento facoltativo deve avere un orario diverso dall’accensione.');
 if(input.outlets!==undefined&&!Array.isArray(input.outlets))err('Canali non validi.');
 if(input.days!==undefined&&!Array.isArray(input.days))err('Giorni non validi.');
 const channels=Array.isArray(device.params?.switches)?device.params.switches.map(c=>c.outlet).filter(Number.isInteger):null;
 let outlets=[];
 if(channels){outlets=[...new Set(input.outlets||[])];if(!outlets.length||outlets.some(v=>!channels.includes(v)))err('Seleziona almeno un canale valido.');}
 else if(!['on','off'].includes(device.params?.switch))err('Questo dispositivo non espone un interruttore programmabile.');
 const name=typeof input.name==='string'?input.name.trim():'';
 if(name.length>100)err('Nome troppo lungo.');
 const s={name:name||device.name||'Programmazione',deviceId:device.deviceid,deviceName:device.name||device.deviceid,kind:channels?'multi':'single',outlets,action:input.action,repeat:input.repeat,date:input.repeat==='date'?input.date:null,days:input.repeat==='weekly'?[...new Set(input.days||[])].sort():[],start:input.start,end,...(input.repeat==='date'&&end&&input.endDate?{endDate:input.endDate}:{}),enabled:input.enabled!==false,timeZone:ZONE};
 if(s.repeat==='date'&&(!validDate(s.date)||localTime(s.date,s.start)===null))err('Data o orario non valido, anche rispetto al cambio dell’ora.');
 if(s.endDate&&(!validDate(s.endDate)||s.endDate<s.date||s.endDate===s.date&&s.end<=s.start))err('La data e l’ora di fine devono essere successive all’inizio.');
 if(s.repeat==='date'&&s.end&&localTime(s.endDate||addDays(s.date,s.end<=s.start?1:0),s.end,true)===null)err('L’orario di spegnimento non esiste nel giorno scelto per il cambio dell’ora.');
 if(s.repeat==='weekly'&&(!s.days.length||s.days.some(d=>!Number.isInteger(d)||d<0||d>6)))err('Seleziona almeno un giorno della settimana.');
 if(s.enabled&&!nextEvent(s,now))err('Tutti gli orari sono già trascorsi. Scegli una data futura.');
 return s;
}
function activeWindow(s,at){return s.enabled&&s.end&&windows(s,at-DAY,at).some(w=>w.start<=at&&w.end>at);}
function plan(s,all,now){
 // Recupera al massimo l'ultimo giorno: nessuna vecchia accensione viene riprodotta.
 const due=events(s,Math.max(s.nextAt-1,now-DAY-1),now),last=due.at(-1);
 if(!last)return {event:null,outlets:[],reason:'Orario saltato durante un’interruzione prolungata.'};
 if(last.state==='on'&&now-last.at>5*60000)return {event:null,outlets:[],reason:'Accensione saltata: ritardo superiore a 5 minuti.'};
 const selected=s.kind==='multi'?s.outlets:[null];
 const outlets=selected.filter(outlet=>last.state!=='off'||!all.some(other=>other.id!==s.id&&other.deviceId===s.deviceId&&activeWindow(other,now)&&(other.kind==='single'||other.outlets.includes(outlet))));
 return {event:last,outlets,reason:outlets.length?'':'Spegnimento evitato: un’altra fascia è ancora attiva.'};
}
module.exports={ZONE,NEVER,DAY,dateKey,addDays,localTime,windows,events,nextEvent,validate,activeWindow,plan};
