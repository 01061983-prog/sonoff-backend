const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
let csrf='',auth,sdk;
async function request(path,body){const r=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-App-CSRF':csrf}:{},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.msg||'Collegamento temporaneamente non disponibile. Riprova.');return data;}
async function session(){const data=await request('/api/app/session');if(data.authenticated===false){$('login').hidden=false;$('confirm').hidden=true;$('status').textContent='Accedi al tuo account PACE.';return false;}csrf=data.csrf;$('login').hidden=true;$('confirm').hidden=false;$('status').textContent='Account PACE: '+(data.actor?.name||data.account.name);return true;}
async function exchange(user){await request('/api/app/login',{idToken:await user.getIdToken(),remember:false});await session();}
async function run(fn){document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){$('status').textContent=e.message||'Accesso non riuscito. Riprova.';}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
await run(async()=>{
 if(!/^[A-Za-z0-9_-]{43}$/.test(params.get('challenge')||'')||!/^[A-Za-z0-9_-]{32,100}$/.test(params.get('state')||'')||!/^[A-Za-z0-9_-]{16,100}$/.test(params.get('installationId')||''))throw new Error('Richiesta scaduta. Avvia il collegamento dall’app PACE Widgets.');
 if(await session())return;
 const config=await request('/api/app/config');
 const [app,fb]=await Promise.all([import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js'),import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js')]);
 sdk=fb;auth=fb.getAuth(app.initializeApp(config.firebase,'pace-widgets-connect'));auth.languageCode='it';await fb.setPersistence(auth,fb.browserSessionPersistence);
 const result=await fb.getRedirectResult(auth);if(result)await exchange(result.user);
});
$('google').onclick=()=>run(async()=>{if(!auth)throw new Error('Riapri il collegamento dall’app.');const provider=new sdk.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await sdk.signInWithRedirect(auth,provider);});
$('emailForm').onsubmit=e=>{e.preventDefault();void run(async()=>{if(!auth)throw new Error('Riapri il collegamento dall’app.');const result=await sdk.signInWithEmailAndPassword(auth,$('email').value,$('password').value);$('password').value='';await exchange(result.user);});};
$('approve').onclick=()=>run(async()=>{const data=await request('/api/widgets/pair',{challenge:params.get('challenge'),state:params.get('state'),installationId:params.get('installationId')});location.assign(data.callback);});
