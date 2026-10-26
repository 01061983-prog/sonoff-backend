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
app.use(express.json());
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

function clearSession(res) {
  for (const name of ["ewelink_access", "ewelink_refresh", "ewelink_expires"]) {
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
  const expiry = Number(req.cookies.ewelink_expires);
  if (req.cookies.ewelink_access && (!expiry || expiry > Date.now() + 60000)) return next();
  return renewSession(req, res).then(() => next()).catch(error => failure(res, error));
}
function failure(res, error) {
  if (error.code === "not_authenticated") {
    // Conserva il refresh token: /login potrà tentare un rinnovo senza chiedere credenziali.
    res.clearCookie("ewelink_access", COOKIE_OPTIONS);
    res.clearCookie("ewelink_expires", COOKIE_OPTIONS);
  }
  return res.status(error.status || 502).json({
    ok: false, error: error.code || "upstream_error", msg: error.message,
    providerError: error.providerError
  });
}
const route = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => failure(res, e));

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
      const authError = response.status === 401 || [401, 402].includes(data?.error);
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

app.get("/", (_req, res) => res.json({ ok: true, message: "Backend Sonoff OAuth attivo" }));

app.get("/login", route(async (req, res) => {
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
  res.redirect(returnUrl(pending.returnUrl));
}));

app.post("/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

async function families(token) {
  const response = await api("/v2/family", token);
  if (!Array.isArray(response.data?.familyList)) throw new Error("Elenco family non valido.");
  return response.data.familyList;
}

app.get("/api/devices", requireLogin, route(async (req, res) => {
  const token = req.cookies.ewelink_access;
  const homes = await families(token);
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
        devices.set(d.deviceid, {
          deviceid: d.deviceid, name: d.name, online: d.online === true,
          params: d.params || {}, familyId: home.id, itemType: thing.itemType
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
  res.json({ ok: true, devices: [...devices.values()] });
}));

app.get("/api/scenes", requireLogin, route(async (req, res) => {
  const token = req.cookies.ewelink_access;
  const homes = await families(token);
  if (!homes.length) return res.json({ ok: true, scenes: [] });
  const response = await api("/v2/scene?familyid=" + encodeURIComponent(homes[0].id), token);
  if (!Array.isArray(response.data?.sceneList)) throw new Error("Elenco scene non valido.");
  res.json({ ok: true, scenes: response.data.sceneList });
}));

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
  const switches = [...new Set(body.outlets)].map(outlet => ({ outlet, switch: body.state }));
  const sent = { type: 1, id: body.deviceId, params: { switches } };
  const raw = await api("/v2/device/thing/status", req.cookies.ewelink_access, sent);
  res.json({ ok: true, sent, raw });
}));

app.use((error, _req, res, _next) => {
  res.status(error.type === "entity.parse.failed" ? 400 : 500).json({
    ok: false, error: "invalid_request", msg: "Richiesta non valida."
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server avviato sulla porta", PORT));
