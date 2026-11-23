'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const storage=new AsyncLocalStorage(),ids=new WeakMap();let serial=0;
function identity(obj){if(!ids.has(obj))ids.set(obj,++serial);return ids.get(obj);}
function read(key,operation){const scope=storage.getStore();if(!scope?.enabled)return operation();if(!scope.values.has(key))scope.values.set(key,Promise.resolve().then(operation));return scope.values.get(key);}
module.exports={
 middleware(req,res,next){const scope={enabled:req.method==='GET',values:new Map()};const close=()=>{scope.enabled=false;scope.values.clear();};res.once('finish',close);res.once('close',close);storage.run(scope,next);},
 get(ref){const path=ref.path||ref.key;if(!path)return ref.get();return read('doc:'+identity(ref.firestore||ref.db||module.exports)+':'+path,()=>ref.get());},
 read,
 // An explicit scope is useful for non-HTTP consumers and deterministic tests.
 run(fn){return storage.run({enabled:true,values:new Map()},fn);}
};
