(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory;else root.PaceRequestBackoff=factory();})(typeof window==='undefined'?globalThis:window,function(now=Date.now){
 const scopes=new Map();
 function key(context,path){return context+'|'+path.split('?')[0];}
 return {
  wait(context,path){return Math.max(0,(scopes.get(key(context,path))?.until||0)-now());},
  block(context,path,delay,details={}){const id=key(context,path),before=scopes.get(id)||{};scopes.set(id,{until:Math.max(before.until||0,now()+Math.max(1000,Number(delay)||60000)),message:details.message||before.message,code:details.code||before.code});},
  error(context,path){return Object.assign(new Error(scopes.get(key(context,path))?.message||'eWeLink sta limitando le richieste. Il collegamento riprenderà automaticamente dopo la pausa.'),{status:429,code:scopes.get(key(context,path))?.code||'rate_limited',retryAfterMs:this.wait(context,path)});}
 };
});
