// server.js — Sonoff / eWeLink OAuth e comandi dispositivi
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const app = express();
const APPID = process.env.EWELINK_APP_ID;
const APPSECRET = process.env.EWELINK_APP_SECRET;
const API_BASE = process.env.EWELINK_API_BASE || "https://eu-apia.coolkit.cc";
const REDIRECT_URL = process.env.EWELINK_REDIRECT_URL ||
  "https://sonoff-backend-k8sh.onrender.com/oauth/callback";
const HOME = new URL("/app/index.html", REDIRECT_URL).href;
const GATE_ID = "1000ac81a0";
// The MINIR4 has one relay; cloud payloads can retain synthetic outlets 1–3.
const singleRelayDevices = new Set();
function physicalOutlets(id,outlets){return singleRelayDevices.has(id)?outlets.filter(outlet=>outlet===0):outlets;}
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" };

if (!APPID || !APPSECRET) throw new Error("Impostare EWELINK_APP_ID ed EWELINK_APP_SECRET su Render.");
app.use(cors({
  origin: ["https://oratoriosluigi.altervista.org", "http://localhost:5500"],
  credentials: true
}));
app.use(express.json({ limit: "768kb" }));
app.use(cookieParser());
app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
require("./spartiti-import")(app); // import brani da link per oratoriosluigi.altervista.org/spartiti

function sign(text) {
  return crypto.createHmac("sha256", APPSECRET).update(text).digest("base64");
}
function returnUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === new URL(HOME).origin) return url.href;
  } catch {}
  return HOME;
}
const DAY = 24 * 60 * 60 * 1000;
const refreshJobs = new Map();
let programming = null;
let pushNotify = null;
let daikinModule = null;
let appAccounts = null;
const APP_AUTH_ENABLED = process.env.EWELINK_APP_AUTH_ENABLED === "true";

function clearSession(res) {
  for (const name of ["ewelink_access", "ewelink_refresh", "ewelink_expires", "ewelink_session"]) {
    res.clearCookie(name, COOKIE_OPTIONS);
  }
}

function saveSession(req, res, data) {
  const access = data.accessToken || data.at;
  const refresh = data.refreshToken || data.rt;
  if (!access || !refresh) throw new Error("Token mancanti nella risposta eWeLink.");
  const now = Date.now();
  const accessExpiry = Number(data.atExpiredTime) || now + 30 * DAY;
  const refreshExpiry = Number(data.rtExpiredTime) || now + 60 * DAY;
  if (accessExpiry <= now || refreshExpiry <= now) throw new Error("Token eWeLink già scaduti.");
  res.cookie("ewelink_access", access, { ...COOKIE_OPTIONS, maxAge: accessExpiry - now });
  res.cookie("ewelink_refresh", refresh, { ...COOKIE_OPTIONS, maxAge: refreshExpiry - now });
  res.cookie("ewelink_expires", String(accessExpiry), { ...COOKIE_OPTIONS, maxAge: accessExpiry - now });
  req.cookies.ewelink_access = access;
  req.cookies.ewelink_refresh = refresh;
  req.cookies.ewelink_expires = String(accessExpiry);
}

async function renewSession(req, res) {
  const refresh = req.cookies.ewelink_refresh;
  if (!refresh) {
    const error = new Error("Accedi tramite /login.");
    error.code = "not_authenticated";
    error.status = 401;
    throw error;
  }
  // Condivide il rinnovo tra richieste concorrenti che usano lo stesso token.
  const now = Date.now();
  for (const [key, job] of refreshJobs) if (job.until < now) refreshJobs.delete(key);
  const key = crypto.createHash("sha256").update(refresh).digest("hex");
  let job = refreshJobs.get(key);
  if (!job) {
    const body = { rt: refresh };
    job = {
      until: Infinity,
      promise: api("/v2/user/refresh", null, body, "Sign " + sign(JSON.stringify(body)))
        .then(response => {
          const data = response.data;
          if (!data?.at || !data?.rt) throw new Error("Risposta di rinnovo eWeLink non valida.");
          return { ...data, atExpiredTime: Number(data.atExpiredTime) || Date.now() + 30 * DAY,
            rtExpiredTime: Number(data.rtExpiredTime) || Date.now() + 60 * DAY };
        })
    };
    refreshJobs.set(key, job);
    job.promise.then(() => { job.until = Date.now() + 10000; }, () => { refreshJobs.delete(key); });
  }
  saveSession(req, res, await job.promise);
}

function requireLogin(req, res, next) {
  if (appAccounts) return appAccounts.provider(req).then(() => next()).catch(error => failure(res,error,req));
  if (programming && !req.programmingChecked) {
    req.programmingChecked = true;
    return programming.restoreSession(req, res).then(async () => {
      if (!req.browserSession && req.cookies.ewelink_access && Number(req.cookies.ewelink_expires) > Date.now() + 60000) await programming.connectBrowser(req, res);
      return requireLogin(req, res, next);
    }).catch(error => failure(res, error, req));
  }
  const expiry = Number(req.cookies.ewelink_expires);
  if (req.cookies.ewelink_access && (!expiry || expiry > Date.now() + 60000)) return next();
  return renewSession(req, res).then(() => next()).catch(error => failure(res, error, req));
}
function failure(res, error, req) {
  if (error.code === "not_authenticated") {
    // Conserva il refresh token: /login potrà tentare un rinnovo senza chiedere credenziali.
    res.clearCookie("ewelink_access", COOKIE_OPTIONS);
    res.clearCookie("ewelink_expires", COOKIE_OPTIONS);
  }
  return res.status(error.status || 502).json({
    ok: false, error: error.code || "upstream_error", msg: error.message,
    providerError: error.providerError,
    canResume: error.code === "not_authenticated" && Boolean(req?.browserSession)
  });
}
const route = fn => async (req, res) => {
  try { return await fn(req, res); }
  catch (error) {
    if (!appAccounts && programming && req.browserSession && error.code === "not_authenticated" && !res.headersSent) {
      const used = req.cookies.ewelink_access;
      try {
        await programming.restoreSession(req, res);
        if (used !== req.cookies.ewelink_access) {
          // Ripete solo letture: mai un comando, neppure dopo una nuova autorizzazione.
          if (req.method === "GET" && req.path?.startsWith("/api/")) return await fn(req, res);
          error = cloudError(409, "session_updated", "Collegamento aggiornato da un altro dispositivo. Aggiorna lo stato prima di riprovare il comando.");
        }
      } catch (recoveryError) { error = recoveryError; }
      if (error.code === "not_authenticated") {
        try { await programming.markAuthenticationRequired(req); } catch {}
      }
    }
    return failure(res, error, req);
  }
};

if(APP_AUTH_ENABLED){
  if(process.env.EWELINK_PROGRAMMING_ENABLED!=="true")throw new Error("L’accesso webapp richiede l’archivio credenziali della programmazione.");
  const adminEmail=String(process.env.EWELINK_APP_ADMIN_EMAIL||"").trim().toLowerCase();
  if(!adminEmail)throw new Error("Impostare EWELINK_APP_ADMIN_EMAIL prima di attivare gli account.");
  const webConfig=JSON.parse(process.env.FIREBASE_WEB_CONFIG||"{}");
  if(!webConfig.apiKey||!webConfig.authDomain||webConfig.projectId!==process.env.FIREBASE_PROJECT_ID)throw new Error("Configurazione pubblica Firebase Auth mancante o non coerente.");
  const sameOriginGoogle = process.env.EWELINK_SAME_ORIGIN_GOOGLE ??
    String(new URL(HOME).origin === "https://sonoff-backend-k8sh.onrender.com" && webConfig.projectId === "ewelink-oratorio");
  if (sameOriginGoogle === "true") {
    const firebaseHosting = new URL(`https://${webConfig.projectId}.firebaseapp.com`);
    const authHelper = /^\/__\/auth\/(?:handler|iframe|links)(?:\.js)?$|^\/__\/auth\/experiments\.js$|^\/__\/firebase\/init\.json$/;
    app.all(authHelper, express.raw({type:"application/x-www-form-urlencoded",limit:"64kb"}), async (req,res) => {
      if (!["GET","HEAD","POST"].includes(req.method)) return res.sendStatus(405);
      const url = new URL(firebaseHosting);
      url.pathname = req.path;
      url.search = new URL(req.originalUrl, firebaseHosting).search;
      const form = req.method === "POST" && Buffer.isBuffer(req.body);
      if (req.method === "POST" && !form) return res.sendStatus(415);
      try {
        const response = await fetch(url, {
          method:req.method,
          redirect:"manual",
          signal:AbortSignal.timeout(10000),
          ...(form ? {body:req.body,headers:{"Content-Type":"application/x-www-form-urlencoded"}} : {})
        });
        // Il browser deve ricevere gli helper sul dominio della plancia.
        if (response.status >= 300 && response.status < 400) return res.sendStatus(502);
        const type = response.headers.get("content-type");
        if (type) res.set("Content-Type",type);
        res.set("X-Content-Type-Options","nosniff");
        return res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
      } catch {
        return res.status(502).send("Accesso Google temporaneamente non disponibile.");
      }
    });
    webConfig.authDomain = new URL(HOME).host;
  }
  appAccounts=require('./app-accounts')({db:getSceneDatabase,auth:()=>{getSceneDatabase();return require('firebase-admin/auth').getAuth(require('firebase-admin/app').getApps().find(a=>a.name==='san-luigi-scenes'));},secret:APPSECRET,appid:APPID,adminEmail,origin:new URL(HOME).origin,webConfig,programming:()=>requireProgramming()});
  appAccounts.install(app,route);
}else app.get('/api/app/config',(_req,res)=>res.json({ok:true,enabled:false}));

// Spazia le richieste verso eWeLink. Nessun reinvio automatico dei comandi.
let queue = Promise.resolve();
let lastRequest = 0;
async function api(path, token, body, authorization) {
  const slot = queue.then(async () => {
    const delay = Math.max(0, 550 - (Date.now() - lastRequest));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequest = Date.now();
  });
  queue = slot.catch(() => {});
  await slot;
  if (appAccounts && body !== undefined && path === "/v2/device/thing/status") await appAccounts.tokenAllowed(token);
  if(path==="/v2/device/thing/status"&&body?.params?.switches&&singleRelayDevices.has(body.id)){
    const switches=body.params.switches.filter(channel=>channel.outlet===0);
    if(!switches.length)throw cloudError(400,"invalid_channels","Questo MINIR4 dispone soltanto del canale 1. Modifica il comando selezionando CH1.");
    body={...body,params:{...body.params,switches}};
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(API_BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CK-Appid": APPID,
        Authorization: authorization || "Bearer " + token
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error("Risposta non JSON da eWeLink (HTTP " + response.status + ")."); }
    if (!response.ok || data?.error !== 0) {
      const error = new Error(data?.msg || "Errore eWeLink HTTP " + response.status);
      const authError = response.status === 401 || [401, 402].includes(data?.error) ||
        (path === "/v2/user/refresh" && data?.error === 405);
      error.providerError = data?.error;
      error.code = authError ? "not_authenticated" : (data?.error || "upstream_error");
      error.status = authError ? 401 : 502;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Tempo scaduto: esito non confermato. Verifica lo stato prima di riprovare.");
    throw error;
  } finally { clearTimeout(timer); }
}

// Pagina e API sullo stesso sito: i cookie non dipendono da accessi cross-site.
app.use("/app", express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: 0 }));

// Compatibilità con i file caricati accanto a server.js su GitHub.
// Sono esposti soltanto gli asset elencati, mai il codice del backend.
const WEBAPP_ASSETS = [
  "index.html", "sonoff.html.html", "app.css", "text-size.js", "scene-pages.js", "room-map.js", "room-map.css", "account-auth.js", "account-auth.css", "menu-bar.js", "menu-bar.css", "push-settings.js", "climate.js", "climate.css", "manifest.webmanifest", "sw.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "icons/icon-maskable.png", "icons/apple-touch-icon.png"
];
for (const asset of WEBAPP_ASSETS) {
  app.get("/app/" + asset, (_req, res) => {
    res.sendFile(path.join(__dirname, asset), { dotfiles: "deny" }, error => {
      if (error && !res.headersSent) {
        res.status(error.statusCode || error.status || 404).send("File webapp mancante: " + asset);
      }
    });
  });
}
app.get("/app", (_req, res) => res.redirect(HOME));
app.get("/app/", (_req, res) => res.redirect(HOME));


app.get("/", (_req, res) => res.json({ ok: true, message: "Backend Sonoff OAuth attivo", oauthLinkVersion: 4 }));

app.get("/login", route(async (req, res) => {
  if (appAccounts) {
    await appAccounts.session(req);
    if(req.appImpersonating) throw cloudError(403,"app_link_owner","Il collegamento eWeLink deve essere completato dal titolare dell’account.");
    req.oauthConnection=appAccounts.linkIntent(req);
    res.clearCookie("ewelink_link_intent",{...COOKIE_OPTIONS,path:"/login"});
    if(req.appAccount.providerOwner&&!req.oauthConnection){
      try{await appAccounts.provider(req);return res.redirect(returnUrl(req.query.returnUrl));}
      catch(error){if(error.code!=="not_authenticated")throw error;}
    }
    for(const name of ["ewelink_access","ewelink_refresh","ewelink_expires","ewelink_session"])delete req.cookies[name];
  }
  if (!appAccounts && programming) {
    try {
      await programming.restoreSession(req, res);
      if (!req.browserSession && req.cookies.ewelink_access && Number(req.cookies.ewelink_expires) > Date.now() + 60000) await programming.connectBrowser(req, res);
    }
    catch (error) {
      if (error.code !== "not_authenticated") throw error;
      for (const name of ["ewelink_access", "ewelink_refresh", "ewelink_expires"]) delete req.cookies[name];
    }
  }
  const expiry = Number(req.cookies.ewelink_expires);
  if (req.cookies.ewelink_access && expiry > Date.now() + 60000) {
    return res.redirect(returnUrl(req.query.returnUrl));
  }
  if (req.cookies.ewelink_refresh) {
    try {
      await renewSession(req, res);
      return res.redirect(returnUrl(req.query.returnUrl));
    } catch (error) {
      if (error.code !== "not_authenticated" && error.code !== 405) throw error;
      clearSession(res);
    }
  }
  if(appAccounts&&!req.oauthConnection){const selected=appAccounts.selectedConnection(req,req.appAccount);if(selected)req.oauthConnection={add:false,owner:selected.owner,slot:selected.slot||'',label:selected.label};}
  const seq = Date.now().toString();
  const nonce = crypto.randomBytes(4).toString("hex");
  const state = crypto.randomBytes(24).toString("hex");
  const pending = {state,returnUrl:returnUrl(req.query.returnUrl),...(appAccounts?{accountId:req.appAccount.id,actorUid:req.appActor.uid,...(req.oauthConnection?{connection:req.oauthConnection}:{})}: {})};
  res.cookie("ewelink_oauth", appAccounts ? appAccounts.sealPending(pending) : JSON.stringify(pending), {
    httpOnly: true, secure: true, sameSite: "Lax", signed: false, maxAge: 600000, path: "/oauth/callback"
  });
  const query = new URLSearchParams({
    state, clientId: APPID, authorization: sign(`${APPID}_${seq}`), seq,
    redirectUrl: REDIRECT_URL, nonce, grantType: "authorization_code", showQRCode: "false"
  });
  res.redirect("https://c2ccdn.coolkit.cc/oauth/index.html?" + query.toString());
}));

app.get("/oauth/callback", route(async (req, res) => {
  let pending;
  try { pending = appAccounts ? appAccounts.openPending(req.cookies.ewelink_oauth) : JSON.parse(req.cookies.ewelink_oauth || "null"); } catch {}
  res.clearCookie("ewelink_oauth", { httpOnly: true, secure: true, sameSite: "Lax", path: "/oauth/callback" });
  if (!pending || typeof req.query.state !== "string" || req.query.state !== pending.state) {
    return res.status(400).send("Accesso scaduto o non valido. Riapri la plancia e riprova.");
  }
  if (req.query.error || typeof req.query.code !== "string" || !req.query.code) {
    return res.status(400).send("Accesso eWeLink non completato. Riprova dalla plancia.");
  }
  if(appAccounts){await appAccounts.session(req);if(req.appImpersonating||pending.accountId!==req.appAccount.id||pending.actorUid!==req.appActor.uid)throw cloudError(403,"app_oauth_account","Accesso eWeLink iniziato da un altro account. Riparti dalla tua plancia.");}
  const body = { code: req.query.code, redirectUrl: REDIRECT_URL, grantType: "authorization_code" };
  const data = await api("/v2/user/oauth/token", null, body, "Sign " + sign(JSON.stringify(body)));
  saveSession(req, res, data.data || {});
  if(appAccounts){
    const connection=pending.connection;
    const selected=connection?null:appAccounts.selectedConnection(req,req.appAccount);
    const expectedOwner=connection?.add?null:connection?.owner||selected?.owner;
    const slot=connection?.slot||selected?.slot||'';
    const identityAccount={...req.appAccount,providerOwner:expectedOwner,oauthConnectionSlot:slot};
    const owner=await programming.resolveOAuthOwner(req,data.data,identityAccount);
    await appAccounts.bind(req.appAccount,owner,{add:connection?.add===true,slot,label:connection?.label,expectedOwner});
    await appAccounts.selectConnection(req,res,owner);
  }
  if (programming) await programming.connectBrowser(req, res, appAccounts ? undefined : data.data);
  res.redirect(returnUrl(pending.returnUrl));
}));

app.post("/logout", route(async (req, res) => {
  if(appAccounts)throw cloudError(409,"app_logout","Usa l’uscita dall’account della webapp.");
  if (programming) await programming.logoutBrowser(req);
  clearSession(res);
  res.json({ ok: true });
}));

async function families(token) {
  const response = await api("/v2/family", token);
  if (!Array.isArray(response.data?.familyList)) throw new Error("Elenco family non valido.");
  return response.data.familyList;
}

// Ricerca autorizzata per ID: non modifica lo stato dei dispositivi.
async function readLinkedDevice(token,id,workspaceId){
  let found=null,lastError;
  for(const itemType of [1,2]){
    try{
      const raw=await api("/v2/device/thing",token,{thingList:[{itemType,id}]});
      found=raw.data?.thingList?.find(t=>[1,2].includes(t.itemType)&&t.itemData?.deviceid===id);
      if(found)break;
    }catch(error){if(error.code==="not_authenticated")throw error;lastError=error;}
  }
  if(!found)throw lastError||cloudError(404,"device_not_found","Il dispositivo non è accessibile a questo account eWeLink.");
  const d=found.itemData,uiid=d.extra?.uiid??d.extra?.extra?.uiid??d.uiid;
  // UIID 2 è Dual-Channel Plug: gli altri slot della risposta non sono canali fisici.
  if(uiid!==2)throw cloudError(400,"unsupported_linked_model","La mappatura dei canali di questo modello deve essere verificata prima di collegarlo.");
  const switches=[0,1].map(outlet=>{
    const channel=d.params?.switches?.find(c=>c.outlet===outlet);
    if(!channel||!["on","off"].includes(channel.switch))throw cloudError(502,"invalid_device_state","Stato dei due canali non verificabile. Nessun comando disponibile.");
    return {outlet,switch:channel.switch};
  });
  return {deviceid:id,name:d.name||id,online:d.online===true,params:{switches},familyId:workspaceId,itemType:found.itemType,uiid:2,linkedById:true};
}
async function assertLinkedDeviceChannels(token,id,outlets,registry){
  if(!programming?.linkedDevices)return;
  const entry=(registry||await programming.linkedDevices(token)).find(d=>d.id===id);
  if(entry&&(!Array.isArray(outlets)||!outlets.length||outlets.some(o=>![0,1].includes(o))))throw cloudError(400,"invalid_linked_channels","Per questo dispositivo scegli soltanto Canale 1 o Canale 2.");
}
app.post("/api/linked-devices",requireLogin,route(async(req,res)=>{
  const id=typeof req.body?.deviceId==="string"?req.body.deviceId.trim().toLowerCase():"",workspaceId=req.body?.workspaceId;
  if(!/^[a-f0-9]{10}$/.test(id))throw cloudError(400,"invalid_device","Indica un ID dispositivo eWeLink valido di 10 caratteri.");
  const homes=await families(req.cookies.ewelink_access);
  if(typeof workspaceId!=="string"||!homes.some(h=>h.id===workspaceId))throw cloudError(403,"workspace_forbidden","Scegli una casa eWeLink del tuo account.");
  const verified=await readLinkedDevice(req.cookies.ewelink_access,id,workspaceId);
  const result=await requireProgramming().registerLinkedDevice(req,{id,name:verified.name,workspaceId});
  res.json({...result,channels:2});
}));

async function listDevices(token, homes, {includeOwnership = false, deviceIds = null, linkedRegistry} = {}) {
  homes = homes || await families(token);
  const devices = new Map();
  for (const home of homes) {
    let beginIndex = -9999999;
    const seen = new Set();
    while (true) {
      const query = new URLSearchParams({ familyid: home.id, num: "30", beginIndex: String(beginIndex) });
      const response = await api("/v2/device/thing?" + query.toString(), token);
      const things = response.data?.thingList;
      if (!Array.isArray(things)) throw new Error("Elenco dispositivi non valido.");
      for (const thing of things) {
        if (![1, 2].includes(thing.itemType) || !thing.itemData?.deviceid) continue;
        const d = thing.itemData;
        const singleRelay=String(d.productModel||'').toUpperCase()==='MINIR4';
        if(singleRelay)singleRelayDevices.add(d.deviceid);
        const params=singleRelay&&Array.isArray(d.params?.switches)?{...d.params,switches:d.params.switches.filter(channel=>channel.outlet===0)}:d.params||{};
        if (includeOwnership && devices.get(d.deviceid)?.itemType === 1 && thing.itemType !== 1) continue;
        devices.set(d.deviceid, {
          deviceid: d.deviceid, name: d.name, online: d.online === true,
          params, familyId: home.id, itemType: thing.itemType,
          ...(singleRelay?{controlOutlets:[0]}:{}),
          ...(includeOwnership && thing.itemType === 1 && !d.sharedBy && typeof d.apikey === "string" ? {ownerApikey:d.apikey} : {})
        });
      }
      if (things.length < 30) break;
      const next = things[things.length - 1].index;
      if (!Number.isFinite(next) || next === beginIndex || seen.has(next)) throw new Error("Paginazione dispositivi non valida.");
      seen.add(next);
      beginIndex = next;
    }
  }
  const warnings=[];
  if(!includeOwnership&&programming?.linkedDevices){
    const linked=linkedRegistry||await programming.linkedDevices(token);
    for(const entry of linked.filter(d=>homes.some(h=>h.id===d.workspaceId)&&(!deviceIds||deviceIds.includes(d.id)))){
      try{devices.set(entry.id,await readLinkedDevice(token,entry.id,entry.workspaceId));}
      catch(error){
        if(error.code==="not_authenticated")throw error;
        devices.delete(entry.id);warnings.push((entry.name||entry.id)+": lettura non disponibile. Verifica il collegamento eWeLink.");
      }
    }
  }
  const result=[...devices.values()];if(warnings.length)Object.defineProperty(result,"warnings",{value:warnings});
  return result;
}
app.get("/api/session", requireLogin, (_req, res) => res.json({ok:true}));
app.get("/api/devices", requireLogin, route(async (req, res) => {
  const devices=await listDevices(req.cookies.ewelink_access);
  res.json({ok:true,devices,warnings:devices.warnings||[]});
}));

// Letture di diagnostica: nessun endpoint di comando viene chiamato.
app.get("/api/device-diagnostics", requireLogin, route(async (req, res) => {
  const id=req.query.deviceId;
  if(typeof id!=="string"||!/^[0-9a-f]{10}$/i.test(id))throw cloudError(400,"invalid_device","Indica un ID dispositivo eWeLink valido.");
  const token=req.cookies.ewelink_access,homes=await families(token),checks=[],matches=[];
  const info=thing=>{
    const d=thing.itemData||{},p=d.params||{};
    return {deviceId:d.deviceid,name:d.name||null,itemType:thing.itemType,brand:d.brandName||null,model:d.productModel||null,uiid:d.extra?.uiid??d.extra?.extra?.uiid??d.uiid??null,online:typeof d.online==="boolean"?d.online:null,switch:["on","off"].includes(p.switch)?p.switch:null,channels:Array.isArray(p.switches)?p.switches.map(c=>({outlet:c.outlet,state:["on","off"].includes(c.switch)?c.switch:null})):[]};
  };
  const readError=e=>{
    if(e.code==="not_authenticated")throw e;
    return {httpStatus:e.status||502,providerError:e.providerError??e.code??null,message:String(e.message||"Lettura non riuscita").slice(0,400)};
  };
  for(const home of homes){
    try{
      const query=new URLSearchParams({familyid:home.id,num:"0",beginIndex:"-9999999"});
      const raw=await api("/v2/device/thing?"+query,token),things=raw.data?.thingList;
      if(!Array.isArray(things))throw new Error("Elenco dispositivi non valido.");
      const found=things.filter(t=>t.itemData?.deviceid===id).map(info);matches.push(...found);
      checks.push({source:"all-devices",home:home.name||null,reportedTotal:raw.data?.total??null,received:things.length,found:found.length>0});
    }catch(e){checks.push({source:"all-devices",home:home.name||null,...readError(e)});}
  }
  const listed=(await listDevices(token,homes)).some(d=>d.deviceid===id);
  for(const itemType of [1,2]){
    try{
      const raw=await api("/v2/device/thing",token,{thingList:[{itemType,id}]}),things=raw.data?.thingList;
      if(!Array.isArray(things))throw new Error("Risposta dispositivo non valida.");
      const found=things.filter(t=>t.itemData?.deviceid===id).map(info);matches.push(...found);
      checks.push({source:itemType===1?"specified-owned":"specified-shared",found:found.length>0});
      if(found.length)break;
    }catch(e){checks.push({source:itemType===1?"specified-owned":"specified-shared",...readError(e)});}
  }
  try{
    // GET legge lo stato; soltanto POST sullo stesso percorso sarebbe un comando.
    const raw=await api("/v2/device/thing/status?"+new URLSearchParams({type:"1",id}),token);
    const p=raw.data?.params;
    if(!p||typeof p!=="object"||Array.isArray(p))throw new Error("Stato non disponibile nella risposta eWeLink.");
    checks.push({source:"read-status",found:true,switch:["on","off"].includes(p.switch)?p.switch:null,channels:Array.isArray(p.switches)?p.switches.map(c=>({outlet:c.outlet,state:["on","off"].includes(c.switch)?c.switch:null})):[]});
  }catch(e){checks.push({source:"read-status",...readError(e)});}
  res.set("Cache-Control","no-store");res.json({ok:true,deviceId:id,listed,matches,checks});
}));

app.get("/api/scenes", requireLogin, route(async (req, res) => {
  const token = req.cookies.ewelink_access;
  const homes = await families(token);
  if (!homes.length) return res.json({ ok: true, scenes: [] });
  const response = await api("/v2/scene?familyid=" + encodeURIComponent(homes[0].id), token);
  if (!Array.isArray(response.data?.sceneList)) throw new Error("Elenco scene non valido.");
  res.json({ ok: true, scenes: response.data.sceneList });
}));

// ================== SCENARI CONDIVISI FIREBASE ==================
// Credenziali soltanto sul server Render, mai nel frontend o in GitHub.
let sceneDatabase;
function getSceneDatabase() {
  if (sceneDatabase) return sceneDatabase;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw cloudError(503, "sync_not_configured", "Sincronizzazione Firebase non ancora configurata sul server.");
  }
  const { initializeApp, applicationDefault, cert, getApps } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const options = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? { credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) }
    : { credential: applicationDefault() };
  if (process.env.FIREBASE_PROJECT_ID) options.projectId = process.env.FIREBASE_PROJECT_ID;
  const firebaseApp = getApps().find(app => app.name === "san-luigi-scenes") || initializeApp(options, "san-luigi-scenes");
  sceneDatabase = getFirestore(firebaseApp);
  return sceneDatabase;
}
function cloudError(status, code, message) {
  const error = new Error(message); error.status = status; error.code = code; return error;
}
const sceneContexts = new Map();
async function sceneContext(req) {
  const token = req.cookies.ewelink_access;
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  for (const [id, entry] of sceneContexts) if (entry.expires < now) sceneContexts.delete(id);
  let entry = sceneContexts.get(key);
  if (!entry) {
    const homes = await families(token);
    entry = { homes, expires: now + 60000 };
    sceneContexts.set(key, entry);
  }
  const requested = req.query?.workspaceId || req.body?.workspaceId || process.env.EWELINK_SCENES_FAMILY_ID;
  const home = requested ? entry.homes.find(home => home.id === requested) : entry.homes[0];
  if (!home) throw cloudError(403, "workspace_forbidden", "La casa eWeLink richiesta non è accessibile a questo account.");
  const docId = crypto.createHash("sha256").update(APPID + ":" + home.id).digest("hex");
  let ref=getSceneDatabase().collection("sanLuigiScenarioWorkspaces").doc(docId);
  if(appAccounts)ref=await appAccounts.context(req,home,ref);
  return { workspace: { id: home.id, name: home.name || "Oratorio" }, ref };
}
function cleanScene(scene) {
  if (!scene || typeof scene.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(scene.id) ||
      typeof scene.name !== "string" || !scene.name.trim() || scene.name.length > 100 ||
      !Array.isArray(scene.actions) || scene.actions.length < 1 || scene.actions.length > 30) {
    throw cloudError(400, "invalid_scene", "Nome o azioni dello scenario non validi (massimo 30 azioni).");
  }
  const actions = scene.actions.map(action => {
    if (!action || !validCommand(action) || !["gate", "single", "multi"].includes(action.kind)) {
      throw cloudError(400, "invalid_scene", "Azione scenario non valida.");
    }
    if (action.pulse !== undefined && typeof action.pulse !== "boolean") throw cloudError(400, "invalid_scene", "Modalità impulso non valida.");
    const pulse = action.kind === "gate" || action.pulse === true;
    const result = { deviceId: action.deviceId, kind: action.kind, state: pulse ? "on" : action.state };
    if (pulse) result.pulse = true;
    if (action.kind === "multi") {
      if (!Array.isArray(action.outlets) || !action.outlets.length || action.outlets.length > 32 || !action.outlets.every(n => Number.isInteger(n) && n >= 0 && n < 128)) {
        throw cloudError(400, "invalid_scene", "Canali dello scenario non validi.");
      }
      result.outlets = [...new Set(action.outlets)];
    }
    return result;
  });
  if (scene.mode !== undefined && !["toggle", "command"].includes(scene.mode)) throw cloudError(400, "invalid_scene", "Modalità scenario non valida.");
  if (scene.mode === "toggle" && actions.some(action => action.pulse)) throw cloudError(400, "invalid_scene", "Un comando a impulso non può diventare accendi/spegni.");
  return { id: scene.id, name: scene.name.trim(), type: "manuale", actions, ...(scene.mode === "toggle" ? {mode:"toggle"} : {}) };
}
function unifyPorticoScenes(scenes) {
  const on = scenes.find(scene => scene.id === "default-portico-on");
  const off = scenes.find(scene => scene.id === "default-portico-off");
  const signature = scene => JSON.stringify(scene.actions.map(action => [action.deviceId, action.kind, [...(action.outlets || [])].sort((a,b)=>a-b)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if (!on || !off || on.actions.some(a=>a.state!=="on" || a.pulse || a.kind==="gate") || off.actions.some(a=>a.state!=="off" || a.pulse || a.kind==="gate") || signature(on)!==signature(off)) return {scenes, archived:[]};
  return {scenes:scenes.filter(scene=>scene.id!==off.id).map(scene=>scene.id===on.id ? {...scene,name:/^Portico\s*[–-]\s*tutte accese$/i.test(scene.name)?"Portico":scene.name,mode:"toggle",version:(scene.version||1)+1,updatedAt:Date.now()} : scene),archived:[off]};
}
function workspaceData(snapshot) {
  return snapshot.exists ? snapshot.data() : { revision: 0, scenes: [], executions: {} };
}
function scenePayload(context, snapshot) {
  const data = workspaceData(snapshot);
  return { ok: true, exists: snapshot.exists, workspace: context.workspace, revision: data.revision || 0,
    scenes: data.scenes || [], executions: data.executions || {}, rooms: data.rooms || [] };
}
function currentExecution(data) {
  return Object.values(data.executions || {}).find(run => run.status === "running" && run.expiresAt > Date.now());
}

app.get("/api/user-scenes", requireLogin, route(async (req, res) => {
  const context = await sceneContext(req);
  const initial = await context.ref.get();
  if (unifyPorticoScenes(workspaceData(initial).scenes || []).archived.length) await getSceneDatabase().runTransaction(async transaction => {
    const snapshot = await transaction.get(context.ref), data = workspaceData(snapshot);
    if (currentExecution(data)) return;
    const unified = unifyPorticoScenes(data.scenes || []);
    if (unified.archived.length) transaction.set(context.ref,{...data,scenes:unified.scenes,archivedScenes:[...(data.archivedScenes||[]),...unified.archived],revision:(data.revision||0)+1,updatedAt:Date.now()});
  });
  res.json(scenePayload(context, await context.ref.get()));
}));

function cleanRoom(room) {
  if (!room || typeof room.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(room.id) ||
      typeof room.name !== "string" || !room.name.trim() || room.name.length > 80 ||
      !Array.isArray(room.members) || room.members.length > 200) {
    throw cloudError(400, "invalid_room", "Indica un nome per la stanza (massimo 80 caratteri) e al massimo 200 elementi.");
  }
  const seen = new Set();
  const members = room.members.map(member => {
    if (!member || !["scene", "device"].includes(member.kind) || typeof member.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(member.id))
      throw cloudError(400, "invalid_room", "Elemento della stanza non valido.");
    const key = member.kind + ":" + member.id;
    if (seen.has(key)) throw cloudError(400, "invalid_room", "Un elemento è stato inserito due volte nella stanza.");
    seen.add(key); return {kind:member.kind, id:member.id};
  });
  const mode=room.mode||"list";
  if(!["list","map"].includes(mode))throw cloudError(400,"invalid_room","Tipo di stanza non valido.");
  if(mode==="map"){
    for(let i=0;i<members.length;i++){
      const pin=room.members[i];
      if(pin.kind!=="device"||!Number.isFinite(pin.x)||!Number.isFinite(pin.y)||pin.x<0||pin.x>1||pin.y<0||pin.y>1||!["bulb","power"].includes(pin.icon))
        throw cloudError(400,"invalid_room","Controlla i dispositivi e le posizioni nell’immagine.");
      Object.assign(members[i],{x:pin.x,y:pin.y,icon:pin.icon});
    }
  }
  const annotations=[];
  if(mode==='map'&&room.annotations!==undefined){
    if(!Array.isArray(room.annotations)||room.annotations.length>30)throw cloudError(400,'invalid_room','Puoi inserire al massimo 30 riferimenti nell’immagine.');
    const ids=new Set();
    for(const label of room.annotations){
      if(!label||typeof label.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(label.id)||ids.has(label.id)||typeof label.text!=='string'||!label.text.trim()||label.text.length>60||!Number.isFinite(label.x)||!Number.isFinite(label.y)||label.x<0||label.x>1||label.y<0||label.y>1)
        throw cloudError(400,'invalid_room','Controlla testo e posizione dei riferimenti (massimo 60 caratteri).');
      const sized=label.width!==undefined||label.height!==undefined;
      if(sized&&(!Number.isFinite(label.width)||!Number.isFinite(label.height)||label.width<.1||label.width>.9||label.height<.025||label.height>.5))
        throw cloudError(400,'invalid_room','Dimensione del riferimento non valida. Ridimensionalo usando gli angoli.');
      ids.add(label.id);annotations.push({id:label.id,text:label.text.trim(),x:label.x,y:label.y,...(sized?{width:label.width,height:label.height}:{})});
    }
  }
  return {id:room.id, name:room.name.trim(), mode, members,annotations};
}
function roomImageRef(context,id){
  return getSceneDatabase().collection("ewelinkRoomImages").doc(crypto.createHash("sha256").update(context.ref.path+":"+id).digest("hex"));
}
function validateRoomImage(image){
  if(typeof image!=="string"||image.length>360000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)||Buffer.from(image.slice(23),"base64").subarray(0,2).toString("hex")!=="ffd8")
    throw cloudError(400,"invalid_room_image","Scegli un’immagine JPEG valida, di dimensioni ridotte.");
  return image;
}
function requireRoomEditor(req){
  if(/iPhone|iPod|Windows Phone|Android.*Mobile/i.test(req.headers?.["user-agent"]||""))
    throw cloudError(403,"room_editor_device","Crea e modifica le stanze da computer o tablet.");
}
app.get("/api/room-image",requireLogin,route(async(req,res)=>{
  const context=await sceneContext(req),id=req.query.roomId;
  if(typeof id!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw cloudError(400,"invalid_room","Stanza non valida.");
  const workspace=workspaceData(await context.ref.get());
  const room=workspace.rooms?.find(room=>room.id===id&&room.mode==="map");
  if(!room)throw cloudError(404,"room_not_found","Stanza non disponibile.");
  const stored=await roomImageRef(context,id).get();
  if(!stored.exists||!stored.data().image)throw cloudError(404,"room_image_missing","Immagine non disponibile. Ricaricala da Modifica stanza.");
  res.json({ok:true,image:stored.data().image,imageVersion:stored.data().version});
}));
async function changeRoom(context, body, req) {
  requireRoomEditor(req);
  const image=body.room?.image===undefined?undefined:validateRoomImage(body.room.image);
  const incoming = body.op === "room-upsert" ? cleanRoom(body.room) : null;
  const id = incoming?.id || body.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0)
    throw cloudError(400,"invalid_room","Identificativo o versione della stanza non valido.");
  let allowedDevices = new Set();
  if (incoming?.members.some(member=>member.kind === "device")) {
    const devices = await listDevices(req.cookies.ewelink_access,[context.workspace]);
    allowedDevices = new Set(devices.map(device=>device.deviceid));
  }
  await getSceneDatabase().runTransaction(async transaction => {
    const snapshot = await transaction.get(context.ref), data = workspaceData(snapshot);
    if (!snapshot.exists) throw cloudError(409,"room_conflict","Attendi la sincronizzazione degli scenari prima di creare una stanza.");
    if (currentExecution(data)) throw cloudError(409,"scene_busy","Attendi la fine del comando prima di modificare le stanze.");
    const rooms = [...(data.rooms || [])], index = rooms.findIndex(room=>room.id === id);
    const actualVersion = index < 0 ? 0 : rooms[index].version || 1;
    const previous=rooms[index];
    if (actualVersion !== body.expectedVersion) throw cloudError(409,"room_conflict","Questa stanza è cambiata su un altro dispositivo. Riaprila prima di salvare.");
    if (incoming) {
      if (incoming.members.some(member=>member.kind === "scene" ? !(data.scenes || []).some(scene=>scene.id===member.id) : !allowedDevices.has(member.id)))
        throw cloudError(400,"room_member_unavailable","Uno degli elementi non è più disponibile. Rimuovilo dalla stanza oppure aggiorna i dispositivi.");
      if(incoming.mode==="map"&&!image&&!previous?.imageVersion)
        throw cloudError(400,"room_image_required","Carica un’immagine per la stanza.");
      const next = {...incoming,annotations:incoming.mode==='map'&&body.room.annotations===undefined?previous?.annotations||[]:incoming.annotations,version:actualVersion+1,updatedAt:Date.now(),
        ...(incoming.mode==="map"?{imageVersion:image?actualVersion+1:previous.imageVersion}:{})};
      if(image&&incoming.mode==="map")transaction.set(roomImageRef(context,id),{image,version:next.imageVersion});
      if(previous?.mode==="map"&&incoming.mode!=="map")transaction.set(roomImageRef(context,id),{image:null,version:actualVersion+1});
      if (index < 0) rooms.push(next); else rooms[index] = next;
    } else if (index >= 0) {
      rooms.splice(index,1);
      if(previous?.mode==="map")transaction.set(roomImageRef(context,id),{image:null,version:actualVersion+1});
    }
    if (rooms.length > 80 || Buffer.byteLength(JSON.stringify(rooms)) > 150000) throw cloudError(400,"room_limit","Limite stanze raggiunto: massimo 80 stanze.");
    transaction.set(context.ref,{...data,rooms,revision:(data.revision||0)+1,updatedAt:Date.now()});
  });
}

app.post("/api/user-scenes", requireLogin, route(async (req, res) => {
  const context = await sceneContext(req);
  const body = req.body || {};
  if (["room-upsert","room-delete"].includes(body.op)) {
    await changeRoom(context,body,req);
    return res.json(scenePayload(context,await context.ref.get()));
  }
  const validOps = ["init", "upsert", "delete", "import"];
  if (!validOps.includes(body.op)) throw cloudError(400, "invalid_operation", "Operazione scenario non valida.");
  let incoming;
  if (["init", "import"].includes(body.op)) {
    if (!Array.isArray(body.scenes) || body.scenes.length > 200) throw cloudError(400, "invalid_scene", "Elenco scenari non valido.");
    incoming = body.scenes.map(cleanScene);
    if (new Set(incoming.map(scene => scene.id)).size !== incoming.length) throw cloudError(400, "invalid_scene", "Identificativi scenario duplicati.");
  } else if (body.op === "upsert") incoming = cleanScene(body.scene);
  else if (typeof body.id !== "string") throw cloudError(400, "invalid_scene", "Identificativo scenario mancante.");
  const database = getSceneDatabase();
  await database.runTransaction(async transaction => {
    const snapshot = await transaction.get(context.ref);
    const data = workspaceData(snapshot);
    if (body.op === "init" && snapshot.exists) return;
    if (currentExecution(data)) throw cloudError(409, "scene_busy", "Attendi la fine dello scenario in esecuzione.");
    let scenes = [...(data.scenes || [])];
    const now = Date.now();
    if (["init", "import"].includes(body.op)) {
      const ids = new Set(scenes.map(scene => scene.id));
      for (const scene of incoming) if (!ids.has(scene.id)) { scenes.push({ ...scene, version: 1, updatedAt: now }); ids.add(scene.id); }
    } else {
      const id = body.op === "delete" ? body.id : incoming.id;
      const index = scenes.findIndex(scene => scene.id === id);
      const actualVersion = index < 0 ? 0 : scenes[index].version || 1;
      if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== actualVersion) {
        throw cloudError(409, "scene_conflict", "Questo scenario è stato modificato da un altro dispositivo. Ricaricalo prima di salvare.");
      }
      if (body.op === "delete") { if (index >= 0) scenes.splice(index, 1); }
      else if (index < 0) scenes.push({ ...incoming, version: 1, updatedAt: now });
      else scenes[index] = { ...incoming, version: actualVersion + 1, updatedAt: now };
    }
    const unified = unifyPorticoScenes(scenes); scenes = unified.scenes;
    if (scenes.length > 200 || Buffer.byteLength(JSON.stringify(scenes)) > 650000) throw cloudError(400, "scene_limit", "Limite scenari raggiunto.");
    transaction.set(context.ref, { ...data, scenes, ...(unified.archived.length ? {archivedScenes:[...(data.archivedScenes||[]),...unified.archived]} : {}), revision: (data.revision || 0) + 1, updatedAt: now });
  });
  res.json(scenePayload(context, await context.ref.get()));
}));

app.get("/api/user-scenes/events", requireLogin, route(async (req, res) => {
  const context = await sceneContext(req);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let unsubscribe = () => {};
  const send = (name, payload) => { if (!res.writableEnded) res.write("event: " + name + "\ndata: " + JSON.stringify(payload) + "\n\n"); };
  unsubscribe = context.ref.onSnapshot(async snapshot => {
    try{if(appAccounts)await appAccounts.session(req);send("scenes",scenePayload(context,snapshot));}
    catch{send("sync-error",{message:"Accesso alla plancia non più autorizzato."});res.end();}
  }, () => {
    send("sync-error", { message: "Connessione Firebase interrotta. Riprova l’aggiornamento." });
    res.end();
  });
  const heartbeat = setInterval(async () => {
    try{if(appAccounts)await appAccounts.session(req);if(!res.writableEnded)send("heartbeat",{});}
    catch{send("sync-error",{message:"Sessione terminata. Accedi nuovamente."});res.end();}
  }, 20000);
  // Una nuova connessione verifica periodicamente che l'account sia ancora autenticato.
  const maximum = setTimeout(() => res.end(), 15 * 60 * 1000);
  res.on("close", () => { unsubscribe(); clearInterval(heartbeat); clearTimeout(maximum); });
}));

async function protectManualCommands(token,actions){
  return programming?.protectManual?programming.protectManual(token,actions):{actions,protected:[],message:null};
}
async function runCloudScene(context, run, scene, accessToken) {
  let completed = 0, failure = null, protectionMessage = null;
  try {
    const linkedRegistry=programming?.linkedDevices?await programming.linkedDevices(accessToken):[];
    for(const action of scene.actions)await assertLinkedDeviceChannels(accessToken,action.deviceId,action.kind==="multi"?action.outlets:action.kind==="gate"?[0]:null,linkedRegistry);
    if (scene.mode === "toggle") {
      const devices = await listDevices(accessToken, [context.workspace], {deviceIds:scene.actions.map(action=>action.deviceId),linkedRegistry});
      scene={...scene,actions:scene.actions.map(action=>action.kind==='multi'?{...action,outlets:physicalOutlets(action.deviceId,action.outlets)}:action)};
      const states = scene.actions.flatMap(action => {
        const device = devices.find(device => device.deviceid === action.deviceId);
        if (!device?.online) throw new Error("Dispositivo non disponibile. Nessun comando inviato.");
        const values = action.kind === "multi" ? action.outlets.map(outlet => device.params.switches?.find(channel=>channel.outlet===outlet)?.switch) : [device.params.switch];
        if (!values.length||values.some(value=>!["on","off"].includes(value))) throw new Error("Stato delle luci non verificabile. Nessun comando inviato.");
        return values;
      });
      const target = states.every(state=>state==="on") ? "off" : "on";
      scene = {...scene,actions:scene.actions.map(action=>({...action,state:target}))};
    }
    const guarded=await protectManualCommands(accessToken,scene.actions);
    protectionMessage=guarded.message;
    for (const action of guarded.actions) {
      const params = action.kind === "multi"
        ? { switches: action.outlets.map(outlet => ({ outlet, switch: action.state })) }
        : action.kind === "gate" || action.deviceId === GATE_ID
          ? { switches: [{ outlet: 0, switch: action.state }] }
          : { switch: action.state };
      await api("/v2/device/thing/status", accessToken, { type: 1, id: action.deviceId, params });
      completed++;
      // Rinnova il blocco dopo ogni risposta confermata; se il processo termina,
      // il comando diventa da verificare senza restare bloccato indefinitamente.
      await getSceneDatabase().runTransaction(async transaction => {
        const snapshot = await transaction.get(context.ref);
        const data = workspaceData(snapshot);
        if (data.executions?.[scene.id]?.runId !== run.runId) throw new Error("Blocco scenario non più valido. Verifica l’esito prima di riprovare.");
        transaction.set(context.ref, { ...data, executions: { ...data.executions,
          [scene.id]: { ...data.executions[scene.id], completed, expiresAt: Date.now() + 120000 } } });
      });
    }
  } catch (error) { failure = error; }
  try {
    await getSceneDatabase().runTransaction(async transaction => {
      const snapshot = await transaction.get(context.ref);
      const data = workspaceData(snapshot);
      if (data.executions?.[scene.id]?.runId !== run.runId) return;
      const result = { ...run, status: failure ? "failed" : "succeeded", completed, finishedAt: Date.now(),
        protectionMessage,message: failure ? failure.message : protectionMessage || "Comandi accettati da eWeLink." };
      transaction.set(context.ref, { ...data, executions: { ...data.executions, [scene.id]: result } });
    });
  } catch { console.error("Impossibile registrare l’esito dello scenario", run.runId); }
  return {status:failure?"failed":"succeeded",completed,message:failure?failure.message:protectionMessage||"Comandi accettati da eWeLink."};
}


function programmingSceneSignature(scene){return crypto.createHash("sha256").update(JSON.stringify(cleanScene(scene))).digest("hex");}
async function getProgrammingScene(req,id,workspaceId){
  if(typeof id!=="string"||typeof workspaceId!=="string")throw cloudError(400,"invalid_scene","Scegli uno scenario sincronizzato.");
  const context=await sceneContext({...req,query:{workspaceId},body:{}}),snapshot=await context.ref.get();
  const stored=(workspaceData(snapshot).scenes||[]).find(scene=>scene.id===id);
  if(!stored)throw cloudError(404,"scene_not_found","Scenario non più disponibile. Modifica la programmazione.");
  const scene=cleanScene(stored);return {...scene,workspaceId:context.workspace.id,signature:programmingSceneSignature(scene)};
}
async function runProgrammingScene(schedule,credentials,actions){
  const context=await sceneContext({cookies:{ewelink_access:credentials.accessToken},query:{workspaceId:schedule.workspaceId}});
  const run=await getSceneDatabase().runTransaction(async transaction=>{
    const snapshot=await transaction.get(context.ref),data=workspaceData(snapshot);
    const scene=(data.scenes||[]).find(scene=>scene.id===schedule.sceneId);
    if(!scene||programmingSceneSignature(scene)!==schedule.sceneSignature)throw cloudError(409,"scene_changed","Scenario modificato o eliminato: apri e salva di nuovo la programmazione.");
    if(currentExecution(data))throw cloudError(409,"scene_busy","Uno scenario è già in esecuzione. Comando programmato non ripetuto.");
    const run={runId:crypto.randomUUID(),sceneId:scene.id,status:"running",completed:0,total:actions.length,startedAt:Date.now(),expiresAt:Date.now()+120000};
    transaction.set(context.ref,{...data,executions:{...(data.executions||{}),[scene.id]:run}});return run;
  });
  return runCloudScene(context,run,{id:schedule.sceneId,actions},credentials.accessToken);
}

app.post("/api/user-scenes/run", requireLogin, route(async (req, res) => {
  const context = await sceneContext(req);
  const sceneId = req.body?.id;
  const acquired = await getSceneDatabase().runTransaction(async transaction => {
    const snapshot = await transaction.get(context.ref);
    const data = workspaceData(snapshot);
    const scene = (data.scenes || []).find(scene => scene.id === sceneId);
    if (!scene) throw cloudError(404, "scene_not_found", "Scenario non trovato. Aggiorna l’elenco.");
    if (currentExecution(data)) throw cloudError(409, "scene_busy", "Uno scenario è già in esecuzione su un dispositivo.");
    const run = { runId: crypto.randomUUID(), sceneId, status: "running", completed: 0, total: scene.actions.length,
      startedAt: Date.now(), expiresAt: Date.now() + 120000 };
    const executions = Object.fromEntries(Object.entries(data.executions || {}).filter(([id]) => (data.scenes || []).some(s => s.id === id)));
    executions[sceneId] = run;
    transaction.set(context.ref, { ...data, executions });
    return { run, scene: cleanScene(scene) };
  });
  res.status(202).json({ ok: true, accepted: true, run: acquired.run });
  // Il risultato arriva tramite Firebase/SSE. Nessun comando viene ritentato.
  void runCloudScene(context, acquired.run, acquired.scene, req.cookies.ewelink_access);
}));


async function assertNoSceneRunning(req) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return;
  const context = await sceneContext(req);
  const snapshot = await context.ref.get();
  if (currentExecution(workspaceData(snapshot))) throw cloudError(409, "scene_busy", "Attendi lo scenario già in esecuzione prima di inviare altri comandi.");
}

function validCommand(body) {
  return body && typeof body.deviceId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(body.deviceId) && ["on", "off"].includes(body.state);
}

app.post("/api/toggle", requireLogin, route(async (req, res) => {
  if (!validCommand(req.body)) {
    return res.status(400).json({ ok: false, error: "invalid_params", msg: "deviceId o state non validi." });
  }
  const { deviceId, state } = req.body;
  const params = deviceId === GATE_ID
    ? { switches: [{ outlet: 0, switch: state }] }
    : { switch: state };
  await assertNoSceneRunning(req);
  // Il cancello è un dispositivo: type 1. Type 2 indicherebbe un gruppo.
  // L'eventuale modalità impulso resta configurata sul Sonoff.
  await assertLinkedDeviceChannels(req.cookies.ewelink_access,deviceId,null);
  const guard=await protectManualCommands(req.cookies.ewelink_access,[{deviceId,kind:deviceId===GATE_ID?'gate':'single',state}]);
  if(!guard.actions.length)return res.json({ok:true,sent:null,raw:null,protectionMessage:guard.message,protected:guard.protected});
  const sent = { type: 1, id: deviceId, params };
  const raw = await api("/v2/device/thing/status", req.cookies.ewelink_access, sent);
  res.json({ ok: true, sent, raw, protectionMessage:guard.message,protected:guard.protected });
}));

app.post("/api/toggle-multi", requireLogin, route(async (req, res) => {
  const body = req.body;
  if (!validCommand(body) || !Array.isArray(body.outlets) || !body.outlets.length ||
      !body.outlets.every(n => Number.isInteger(n) && n >= 0)) {
    return res.status(400).json({ ok: false, error: "invalid_params", msg: "deviceId, outlets o state non validi." });
  }
  await assertNoSceneRunning(req);
  await assertLinkedDeviceChannels(req.cookies.ewelink_access,body.deviceId,body.outlets);
  const guard=await protectManualCommands(req.cookies.ewelink_access,[{deviceId:body.deviceId,kind:'multi',outlets:[...new Set(body.outlets)],state:body.state}]);
  if(!guard.actions.length)return res.json({ok:true,sent:null,raw:null,protectionMessage:guard.message,protected:guard.protected});
  const switches = guard.actions[0].outlets.map(outlet => ({ outlet, switch: body.state }));
  const sent = { type: 1, id: body.deviceId, params: { switches } };
  const raw = await api("/v2/device/thing/status", req.cookies.ewelink_access, sent);
  res.json({ ok: true, sent, raw, protectionMessage:guard.message,protected:guard.protected });
}));

// Programmazione autonoma: disabilitata finché non viene attivata su Render.
// I token sono conservati soltanto dopo il consenso esplicito al primo salvataggio.
if (process.env.EWELINK_PROGRAMMING_ENABLED === "true") {
  pushNotify = require("./push-notify")({db:getSceneDatabase, identity:req=>requireProgramming().identity(req), requireLogin, route, cloudError});
  pushNotify.install(app);
  programming = require("./programming")({onExecuted:(s,status,message)=>pushNotify.scheduleExecuted(s,status,message),daikin:()=>daikinModule,db:getSceneDatabase, api, listDevices, appid:APPID, secret:APPSECRET, saveSession, authorizeOwner:owner=>appAccounts?appAccounts.authorizeOwner(owner):null, solarFetch:fetch, getScene:getProgrammingScene, runScene:runProgrammingScene, region:new URL(API_BASE).hostname.split("-")[0]});
  programming.start();
}
function requireProgramming() {
  if (!programming) throw cloudError(503, "programming_not_configured", "Programmazione in preparazione: esecuzione automatica non ancora attivata.");
  return programming;
}
app.get("/api/locations", requireLogin, route(async(req,res) => res.json(require('./italian-locations').query(req.query))));
app.get("/api/solar", requireLogin, route(async(req,res) => res.json(await requireProgramming().solarPreview(req))));
app.get("/api/programming", requireLogin, route(async(req,res) => res.json(await requireProgramming().list(req))));
app.post("/api/programming", requireLogin, route(async(req,res) => res.json(await requireProgramming().mutate(req))));

// Split Daikin tramite Onecta Cloud API (credenziali DAIKIN_* su Render).
daikinModule=require("./daikin-onecta")({db:getSceneDatabase,home:HOME,requireLogin,route,cloudError});
daikinModule.install(app);

app.use((error, _req, res, _next) => {
  res.status(error.type === "entity.parse.failed" ? 400 : 500).json({
    ok: false, error: "invalid_request", msg: "Richiesta non valida."
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server avviato sulla porta", PORT));
