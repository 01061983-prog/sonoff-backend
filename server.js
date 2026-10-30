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
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" };

if (!APPID || !APPSECRET) throw new Error("Impostare EWELINK_APP_ID ed EWELINK_APP_SECRET su Render.");
app.use(cors({
  origin: ["https://oratoriosluigi.altervista.org", "http://localhost:5500"],
  credentials: true
}));
app.use(express.json({ limit: "768kb" }));
app.use(cookieParser());
app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

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
    if (programming && req.browserSession && error.code === "not_authenticated" && !res.headersSent) {
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
  "index.html", "sonoff.html.html", "app.css", "manifest.webmanifest", "sw.js",
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


app.get("/", (_req, res) => res.json({ ok: true, message: "Backend Sonoff OAuth attivo" }));

app.get("/login", route(async (req, res) => {
  if (programming) {
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
  const seq = Date.now().toString();
  const nonce = crypto.randomBytes(4).toString("hex");
  const state = crypto.randomBytes(24).toString("hex");
  res.cookie("ewelink_oauth", JSON.stringify({ state, returnUrl: returnUrl(req.query.returnUrl) }), {
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
  try { pending = JSON.parse(req.cookies.ewelink_oauth || "null"); } catch {}
  res.clearCookie("ewelink_oauth", { httpOnly: true, secure: true, sameSite: "Lax", path: "/oauth/callback" });
  if (!pending || typeof req.query.state !== "string" || req.query.state !== pending.state) {
    return res.status(400).send("Accesso scaduto o non valido. Riapri la plancia e riprova.");
  }
  if (req.query.error || typeof req.query.code !== "string" || !req.query.code) {
    return res.status(400).send("Accesso eWeLink non completato. Riprova dalla plancia.");
  }
  const body = { code: req.query.code, redirectUrl: REDIRECT_URL, grantType: "authorization_code" };
  const data = await api("/v2/user/oauth/token", null, body, "Sign " + sign(JSON.stringify(body)));
  saveSession(req, res, data.data || {});
  if (programming) await programming.connectBrowser(req, res, data.data);
  res.redirect(returnUrl(pending.returnUrl));
}));

app.post("/logout", route(async (req, res) => {
  if (programming) await programming.logoutBrowser(req);
  clearSession(res);
  res.json({ ok: true });
}));

async function families(token) {
  const response = await api("/v2/family", token);
  if (!Array.isArray(response.data?.familyList)) throw new Error("Elenco family non valido.");
  return response.data.familyList;
}

async function listDevices(token, homes, {includeOwnership = false} = {}) {
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
        if (includeOwnership && devices.get(d.deviceid)?.itemType === 1 && thing.itemType !== 1) continue;
        devices.set(d.deviceid, {
          deviceid: d.deviceid, name: d.name, online: d.online === true,
          params: d.params || {}, familyId: home.id, itemType: thing.itemType,
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
  // Restituisce solo dispositivi reali: non inventa stati o dispositivi online.
  return [...devices.values()];
}
app.get("/api/session", requireLogin, (_req, res) => res.json({ok:true}));
app.get("/api/devices", requireLogin, route(async (req, res) => {
  res.json({ ok: true, devices: await listDevices(req.cookies.ewelink_access) });
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
  return { workspace: { id: home.id, name: home.name || "Oratorio" }, ref: getSceneDatabase().collection("sanLuigiScenarioWorkspaces").doc(docId) };
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
    scenes: data.scenes || [], executions: data.executions || {} };
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

app.post("/api/user-scenes", requireLogin, route(async (req, res) => {
  const context = await sceneContext(req);
  const body = req.body || {};
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
  unsubscribe = context.ref.onSnapshot(snapshot => send("scenes", scenePayload(context, snapshot)), () => {
    send("sync-error", { message: "Connessione Firebase interrotta. Riprova l’aggiornamento." });
    res.end();
  });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 20000);
  // Una nuova connessione verifica periodicamente che l'account sia ancora autenticato.
  const maximum = setTimeout(() => res.end(), 15 * 60 * 1000);
  res.on("close", () => { unsubscribe(); clearInterval(heartbeat); clearTimeout(maximum); });
}));

async function runCloudScene(context, run, scene, accessToken) {
  let completed = 0, failure = null;
  try {
    if (scene.mode === "toggle") {
      const devices = await listDevices(accessToken, [context.workspace]);
      const states = scene.actions.flatMap(action => {
        const device = devices.find(device => device.deviceid === action.deviceId);
        if (!device?.online) throw new Error("Dispositivo non disponibile. Nessun comando inviato.");
        const values = action.kind === "multi" ? action.outlets.map(outlet => device.params.switches?.find(channel=>channel.outlet===outlet)?.switch) : [device.params.switch];
        if (values.some(value=>!["on","off"].includes(value))) throw new Error("Stato delle luci non verificabile. Nessun comando inviato.");
        return values;
      });
      const target = states.every(state=>state==="on") ? "off" : "on";
      scene = {...scene,actions:scene.actions.map(action=>({...action,state:target}))};
    }
    for (const action of scene.actions) {
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
        message: failure ? failure.message : "Comandi accettati da eWeLink." };
      transaction.set(context.ref, { ...data, executions: { ...data.executions, [scene.id]: result } });
    });
  } catch { console.error("Impossibile registrare l’esito dello scenario", run.runId); }
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
  const sent = { type: 1, id: deviceId, params };
  const raw = await api("/v2/device/thing/status", req.cookies.ewelink_access, sent);
  res.json({ ok: true, sent, raw });
}));

app.post("/api/toggle-multi", requireLogin, route(async (req, res) => {
  const body = req.body;
  if (!validCommand(body) || !Array.isArray(body.outlets) || !body.outlets.length ||
      !body.outlets.every(n => Number.isInteger(n) && n >= 0)) {
    return res.status(400).json({ ok: false, error: "invalid_params", msg: "deviceId, outlets o state non validi." });
  }
  await assertNoSceneRunning(req);
  const switches = [...new Set(body.outlets)].map(outlet => ({ outlet, switch: body.state }));
  const sent = { type: 1, id: body.deviceId, params: { switches } };
  const raw = await api("/v2/device/thing/status", req.cookies.ewelink_access, sent);
  res.json({ ok: true, sent, raw });
}));

// Programmazione autonoma: disabilitata finché non viene attivata su Render.
// I token sono conservati soltanto dopo il consenso esplicito al primo salvataggio.
if (process.env.EWELINK_PROGRAMMING_ENABLED === "true") {
  programming = require("./programming")({db:getSceneDatabase, api, listDevices, appid:APPID, secret:APPSECRET, saveSession, region:new URL(API_BASE).hostname.split("-")[0]});
  programming.start();
}
function requireProgramming() {
  if (!programming) throw cloudError(503, "programming_not_configured", "Programmazione in preparazione: esecuzione automatica non ancora attivata.");
  return programming;
}
app.get("/api/programming", requireLogin, route(async(req,res) => res.json(await requireProgramming().list(req))));
app.post("/api/programming", requireLogin, route(async(req,res) => res.json(await requireProgramming().mutate(req))));

app.use((error, _req, res, _next) => {
  res.status(error.type === "entity.parse.failed" ? 400 : 500).json({
    ok: false, error: "invalid_request", msg: "Richiesta non valida."
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server avviato sulla porta", PORT));
