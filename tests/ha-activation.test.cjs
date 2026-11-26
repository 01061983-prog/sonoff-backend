'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),verify=require('../home-assistant/activation.cjs');
test('only explicit partial activation permits unavailable relays and requires at least one real state',()=>{
 const c={devices:[{deviceId:'one',entityId:'switch.one'},{deviceId:'two',entityId:'switch.two'}],excludedDevices:[{deviceId:'excluded'}]},s={ready:true,states:new Map([['switch.one',{state:'off'}],['switch.two',{state:'unavailable'}]])};
 assert.throws(()=>verify(c,s,false),{code:'ha_verify'});assert.deepEqual(verify(c,s,true),['one']);assert.throws(()=>verify({...c,excludedDevices:[]},s,true),{code:'ha_verify'});assert.throws(()=>verify(c,{...s,ready:false},true),{code:'ha_verify'});assert.throws(()=>verify(c,{ready:true,states:new Map()},true),{code:'ha_verify'});s.states.set('switch.two',{state:'on'});assert.deepEqual(verify(c,s,false),['one','two']);
});
