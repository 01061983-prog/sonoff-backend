const {test}=require('node:test'),assert=require('node:assert/strict');const create=require('../monitoring.cjs');
test('quota day follows midnight Pacific, including 23/25-hour DST days',()=>{
 assert.equal(new Date(create.period(Date.parse('2026-11-19T10:00:00Z')).start).toISOString(),'2026-11-19T08:00:00.000Z');
 const spring=create.period(Date.parse('2026-03-08T14:00:00Z')),fall=create.period(Date.parse('2026-11-01T14:00:00Z'));
 assert.equal(spring.end-spring.start,23*3600000);assert.equal(fall.end-fall.start,25*3600000);
});
test('counts all returned pages and rejects missing samples instead of reporting zero',async()=>{
 let calls=0;const read=create({projectId:'test',accessToken:async()=>'fake',now:()=>Date.parse('2026-11-19T10:00:00Z'),fetch:async()=>({ok:true,json:async()=>({timeSeries:[{points:[{interval:{endTime:'2026-11-19T09:00:00Z'},value:{int64Value:++calls===1?'15':'25'}}]}],...(calls===1?{nextPageToken:'next'}:{})})})});assert.equal((await read()).reads,40);assert.equal(calls,2);
 const empty=create({projectId:'test',accessToken:async()=>'fake',fetch:async()=>({ok:true,json:async()=>({})})});await assert.rejects(empty(),/monitoring_no_samples/);
});
