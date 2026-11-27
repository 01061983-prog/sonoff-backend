'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {discover,entry,addDevices}=require('../home-assistant/catalogue.cjs'),{binding}=require('../home-assistant/protocol.cjs');
const fixture=()=>({devices:[{id:'matter-device',name:'New plug',model:'Matter Over WiFi Smart Switch',identifiers:[['matter','stable-node-1']],serial_number:'not-transmitted'}],registry:[{entity_id:'switch.new_plug',device_id:'matter-device',platform:'matter',original_device_class:'outlet'}],rows:[{entity_id:'switch.new_plug',state:'off',attributes:{device_class:'outlet',secret:'not-transmitted'}}]});
const config=()=>({owner:'a'.repeat(64),accountId:'b'.repeat(64),workspaceId:'landriano',workspaceName:'Landriano',devices:[{deviceId:'1000000001',name:'Keep name',entityId:'switch.old_plug',model:'S61STPF',kind:'multi',outlets:[0]}]});
test('Matter plugs have stable PACE IDs across entity renames, generic models, unavailable states and no secret telemetry',()=>{
 const f=fixture(),first=discover(f.rows,f.registry,f.devices).map(entry)[0];assert.equal(first.source,'matter');assert.equal(first.supported,true);assert.equal(first.state,'off');assert.match(first.deviceId,/^[a-f0-9]{10}$/);assert(!JSON.stringify(first).includes('not-transmitted'));
 f.registry[0].entity_id='switch.renamed';f.rows[0]={entity_id:'switch.renamed',state:'unavailable',attributes:{device_class:'outlet'}};const second=discover(f.rows,f.registry,f.devices).map(entry)[0];assert.equal(first.deviceId,second.deviceId);assert.equal(second.state,'unknown');assert.equal(second.supported,true);
 f.registry[0].entity_id='switch.pompa_sala_prove_sonoff_1002b977f0_1';assert.equal(discover([],f.registry,f.devices)[0].deviceId,'1002b977f0');
});
test('Matter does not authorize lights, sensors, configuration switches or ambiguous multi-relay devices',()=>{
 for(const variant of ['light','sensor','config','multi','ordinary-switch']){const f=fixture();if(variant==='light')f.registry[0].entity_id='light.plug';if(variant==='sensor')f.registry[0].entity_id='sensor.power';if(variant==='config')f.registry[0].entity_category='config';if(variant==='multi')f.registry.push({...f.registry[0],entity_id:'switch.second'});if(variant==='ordinary-switch'){delete f.registry[0].original_device_class;delete f.rows[0].attributes.device_class;}const result=discover(f.rows,f.registry,f.devices).map(entry);assert.equal(result.length,1);assert.equal(result[0].supported,false);assert.throws(()=>entry({...result[0],supported:true,entityId:'sensor.power'}));}
});
test('Matter additions are idempotent and replacing a selected single relay preserves ID, name and saved program targets',()=>{
 const f=fixture(),found=discover(f.rows,f.registry,f.devices).map(entry),c=config(),before=JSON.stringify(c),ids=[found[0].entityId];const added=addDevices(c,ids,found);assert.equal(added.length,2);assert.equal(addDevices({...c,devices:added},ids,found).length,2);
 const replaced=binding({...c,devices:addDevices(c,ids,found,{[ids[0]]:c.devices[0].deviceId})});assert.equal(replaced.devices.length,1);assert.equal(replaced.devices[0].deviceId,c.devices[0].deviceId);assert.equal(replaced.devices[0].name,c.devices[0].name);assert.equal(replaced.devices[0].source,'matter');assert.equal(replaced.devices[0].entityId,ids[0]);assert.equal(JSON.stringify(c),before);
 assert.throws(()=>addDevices(c,ids,found,{[ids[0]]:'1000000999'}),{code:'ha_replacement'});assert.throws(()=>addDevices(c,ids,found,{'switch.foreign':'1000000001'}),{code:'ha_mapping'});assert.throws(()=>addDevices(c,['switch.foreign'],found),{code:'ha_mapping'});
 assert.throws(()=>addDevices({...c,devices:[{...c.devices[0],controlMode:'pulse'}]},ids,found,{[ids[0]]:c.devices[0].deviceId}),{code:'ha_replacement'});
 assert.throws(()=>addDevices(c,[...ids,...ids],found),{code:'ha_mapping'});
});
test('Matter mappings are single ON/OFF switches and retain existing pulse and model restrictions',()=>{
 const f=fixture(),d=discover(f.rows,f.registry,f.devices).map(entry)[0],c=config(),device={...d,kind:'multi',outlets:[0]};assert.equal(binding({...c,devices:[device]}).devices[0].source,'matter');
 for(const bad of [{...device,source:'fake'},{...device,entityId:'light.fake'},{...device,controlMode:'pulse'},{...device,outlets:[0,1]},{...device,channels:[{outlet:0,entityId:device.entityId}]}])assert.throws(()=>binding({...c,devices:[bad]}));
 assert.throws(()=>binding({...c,devices:[{...device,source:undefined}]}),{code:'ha_model'});
});
