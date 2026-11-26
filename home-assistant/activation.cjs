'use strict';
const {fail,channels}=require('./protocol.cjs');
module.exports=function verifyAvailable(config,snapshot,availableOnly){
 if(!snapshot.ready)throw fail(409,'ha_verify','Collega prima il Raspberry.');
 const available=config.devices.filter(d=>channels(d).every(c=>['on','off'].includes(snapshot.states.get(c.entityId)?.state)));
 if(available.length!==config.devices.length&&!(availableOnly===true&&config.excludedDevices?.length&&available.length>0))throw fail(409,'ha_verify','Uno o più relè non sono disponibili.');
 return available.map(d=>d.deviceId);
};
