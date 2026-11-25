const test=require('node:test'),assert=require('node:assert/strict'),feedback=require('../command-feedback.js');
const devices=[{deviceid:'relay',provider:'home_assistant',online:true,observedAt:10,params:{switches:[{outlet:0,switch:'off'}]}},{deviceid:'other',params:{switch:'off'}}];
const body={deviceId:'relay',state:'on',outlets:[0]};
const result=()=>({sent:{id:'relay',params:{switches:[{outlet:0,switch:'on'}]}},raw:{error:0,provider:'home_assistant',data:{status:'confirmed',source:'home_assistant',state:'on',observedAt:20}}});
test('only a matching bridge read-back can update the clicked relay without another list request',()=>{const next=feedback(devices,result(),body);assert.equal(next[0].params.switches[0].switch,'on');assert.equal(devices[0].params.switches[0].switch,'off');assert.equal(next[1],devices[1]);});
test('uncertain, wrong-provider, wrong-relay and mismatched confirmations require a fresh read',()=>{for(const change of [r=>r.raw.data.status='uncertain',r=>r.raw.provider='ewelink',r=>r.sent.id='other',r=>r.raw.data.state='off',r=>r.sent.params.switches[0].outlet=1,r=>delete r.raw.data.observedAt]){const r=result();change(r);assert.equal(feedback(devices,r,body),null);}});
test('a delayed command response cannot overwrite a newer state event',()=>{const newer=devices.map(d=>({...d,observedAt:30}));assert.equal(feedback(newer,result(),body),newer);});
