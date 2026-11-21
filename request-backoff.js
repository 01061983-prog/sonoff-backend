(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory;else root.PaceRequestBackoff=factory();})(typeof window==='undefined'?globalThis:window,function(now=Date.now){
 const scopes=new Map();
 function key(context,path){return context+'|'+path.split('?')[0];}
 return {
  wait(context,path){return Math.max(0,(scopes.get(key(context,path))||0)-now());},
  block(context,path,delay){const id=key(context,path);scopes.set(id,Math.max(scopes.get(id)||0,now()+Math.max(1000,Number(delay)||60000)));},
  error(context,path){return Object.assign(new Error('eWeLink sta limitando le richieste. Il collegamento riprenderà automaticamente dopo la pausa.'),{status:429,code:'rate_limited',retryAfterMs:this.wait(context,path)});}
 };
});
