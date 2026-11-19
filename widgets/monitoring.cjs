'use strict';
function period(now){
 const tz='America/Los_Angeles',parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
 const midnight=(day)=>{const target=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)+day);let time=target;for(let i=0;i<3;i++){
  const name=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'}).formatToParts(new Date(time)).find(p=>p.type==='timeZoneName').value;
  const m=/GMT([+-])(\d{2}):(\d{2})/.exec(name),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3]))*60000:0;time=target-offset;
 }return time;};return {start:midnight(0),end:midnight(1)};
}
module.exports=function monitoring({projectId,accessToken,fetch=globalThis.fetch,now=Date.now}){
 return async()=>{
  if(!projectId||typeof accessToken!=='function')throw new Error('monitoring_not_configured');
  const time=now(),day=period(time),token=await accessToken();
  for(const metric of ['document/read_ops_count','document/read_count']){
   let next='',total=0,found=false,latest=0;
   for(let page=0;page<10;page++){
    const params=new URLSearchParams({filter:`metric.type="firestore.googleapis.com/${metric}"`,'interval.startTime':new Date(day.start).toISOString(),'interval.endTime':new Date(time).toISOString(),view:'FULL',pageSize:'100000',...(next?{pageToken:next}:{})});
    const response=await fetch(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries?${params}`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('monitoring_unavailable');
    const value=await response.json();
    for(const series of value.timeSeries||[])for(const p of series.points||[]){const end=Date.parse(p.interval?.endTime),v=Number(p.value?.int64Value);if(end>day.start&&end<=time&&Number.isSafeInteger(v)&&v>=0){found=true;total+=v;latest=Math.max(latest,end);}}
    next=value.nextPageToken||'';if(!next)break;if(page===9)throw new Error('monitoring_truncated');
   }
   if(found)return {project:projectId,reads:total,observedAt:latest,periodStart:new Date(day.start).toISOString(),periodEnd:new Date(day.end).toISOString()};
  }
  throw new Error('monitoring_no_samples');
 };
};
module.exports.period=period;
