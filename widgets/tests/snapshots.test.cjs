const {test}=require('node:test'),assert=require('node:assert/strict');const create=require('../snapshots.cjs');
const base={deviceid:'test-light',name:'Luce fittizia',online:true,params:{switch:'off'},familyId:'test-home',itemType:1,ownerApikey:'fake-user-key'};
test('normalization never guesses unknown state or turns a pulse into a switch',()=>{
 assert.equal(create.normalize({...base,online:undefined,params:{}}).online,null);assert.equal(create.normalize({...base,params:{}}).state,'unknown');
 assert.equal(create.normalize({...base,params:{switch:'on',pulse:'on'}}).kind,'pulse');
 assert.equal(create.normalize({...base,params:{switches:[{outlet:0,switch:'on'},{outlet:1,switch:'off'}]}}).state,'mixed');
});
test('concurrent snapshots share a provider read and do not start idle sockets',async()=>{
 let reads=0,opens=0;const snapshots=create({access:async()=>({accessToken:'fake',atExpiredTime:9999999999999}),listDevices:async()=>{reads++;return [structuredClone(base)];},appid:'fake',fetch:async()=>{opens++;throw new Error('should not connect');}});
 const workspace={id:'board-test',providerOwner:'owner-test'};await Promise.all([snapshots.read(workspace),snapshots.read(workspace),snapshots.read(workspace)]);assert.equal(reads,1);assert.equal(opens,0);snapshots.stop();
});
test('an authorized stream updates only known devices after authenticated handshake',async()=>{
 class Socket {static current;constructor(){Socket.current=this;this.listeners={};this.readyState=1;}addEventListener(k,fn){this.listeners[k]=fn;}send(){}close(){this.listeners.close?.();}emit(k,value){this.listeners[k]?.(value);}}
 const events=[];const snapshots=create({access:async()=>({accessToken:'fake',atExpiredTime:9999999999999}),listDevices:async()=>[structuredClone(base)],appid:'fake',WebSocket:Socket,fetch:async()=>({ok:true,json:async()=>({error:0,domain:'eu-pconnect1.coolkit.cc',port:8080})}),onChanged:async(...args)=>events.push(args)});
 const workspace={id:'board-test',providerOwner:'owner-test'};await snapshots.watch(workspace);await new Promise(r=>setTimeout(r,1));const socket=Socket.current;assert.ok(socket);socket.emit('open',{});
 socket.emit('message',{data:JSON.stringify({action:'update',deviceid:'test-light',params:{switch:'on'}})});assert.equal((await snapshots.read(workspace)).devices[0].state,'off');
 socket.emit('message',{data:JSON.stringify({error:0,config:{hbInterval:90}})});
 socket.emit('message',{data:JSON.stringify({action:'update',deviceid:'foreign-device',params:{switch:'on'}})});assert.equal((await snapshots.read(workspace)).devices.length,1);
 socket.emit('message',{data:JSON.stringify({action:'update',deviceid:'test-light',params:{switch:'on'}})});assert.equal((await snapshots.read(workspace)).devices[0].state,'on');
 await new Promise(r=>setTimeout(r,650));assert.equal(events.length,1);assert.deepEqual(events[0][1],['test-light']);snapshots.stop();
});
