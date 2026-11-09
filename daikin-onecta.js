// Daikin Onecta Cloud API: collegamento OAuth, stato e comandi degli split.
// Token cifrati in Firestore; limite Daikin 200 richieste/giorno e 20/minuto.
'use strict';
const crypto = require('crypto');

const IDP = 'https://idp.onecta.daikineurope.com/v1/oidc';
const API = 'https://api.onecta.daikineurope.com/v1';
const SCOPE = 'openid onecta:basic.integration offline_access';
const CACHE_MS = 5 * 60 * 1000;      // stato riutilizzato senza nuove chiamate
const FORCE_MIN_MS = 20 * 1000;      // aggiornamento manuale al massimo ogni 20 s
const PENDING_COOKIE = 'daikin_oauth';

module.exports = function createDaikin({ db, home, requireLogin, route, cloudError }) {
  const CLIENT_ID = process.env.DAIKIN_CLIENT_ID;
  const CLIENT_SECRET = process.env.DAIKIN_CLIENT_SECRET;
  const REDIRECT_URI = process.env.DAIKIN_REDIRECT_URI;
  const configured = Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
  const key = configured ? crypto.createHash('sha256').update('daikin-token:' + CLIENT_SECRET).digest() : null;
  const links = () => db().collection('daikinOnectaLinks');
  const tokens = new Map();     // owner -> {access, expires}
  const refreshing = new Map(); // owner -> promise
  const caches = new Map();     // owner -> {devices, at}
  const lastPower = new Map();  // owner:gateway:embedded -> ms
  let rate = null;

  const fail = (status, code, msg) => cloudError(status, code, msg);
  const seal = text => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
  };
  const open = value => {
    const [iv, tag, data] = String(value || '').split('.').map(p => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  };
  const mac = text => crypto.createHmac('sha256', key).update('daikin-pending:' + text).digest('base64url');
  const ownerOf = req => req.appAccount?.id || 'default';
  function needConfig() { if (!configured) throw fail(503, 'daikin_not_configured', 'Integrazione Daikin non configurata sul server.'); }
  function needWriter(req) { if (req.appImpersonating || req.appReadOnly) throw fail(403, 'daikin_owner', 'Il collegamento Daikin può essere gestito soltanto dal titolare della plancia.'); }

  async function tokenRequest(params) {
    const url = new URL(IDP + '/token');
    for (const [k, v] of Object.entries({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET })) url.searchParams.set(k, v);
    const response = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.access_token) {
      const revoked = data.error === 'invalid_grant';
      throw fail(revoked ? 409 : 502, revoked ? 'daikin_not_linked' : 'daikin_token', revoked ? 'Il collegamento Daikin è scaduto o revocato: ricollega l’account Onecta.' : 'Daikin non ha rilasciato il token (' + (data.error_description || data.error || 'HTTP ' + response.status) + ').');
    }
    return data;
  }
  async function store(owner, data, extra = {}) {
    const expires = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    tokens.set(owner, { access: data.access_token, expires });
    const doc = { accessEnc: seal(data.access_token), accessExpires: expires, updatedAt: Date.now(), ...extra };
    if (data.refresh_token) doc.refreshEnc = seal(data.refresh_token);
    await links().doc(owner).set(doc, { merge: true });
  }
  async function accessToken(owner) {
    const cached = tokens.get(owner);
    if (cached && cached.expires > Date.now() + 60000) return cached.access;
    if (refreshing.has(owner)) return refreshing.get(owner);
    const job = (async () => {
      const snap = await links().doc(owner).get();
      if (!snap.exists) throw fail(409, 'daikin_not_linked', 'Collega l’account Daikin Onecta per comandare gli split.');
      const d = snap.data();
      if (d.accessEnc && d.accessExpires > Date.now() + 60000) {
        const access = open(d.accessEnc); tokens.set(owner, { access, expires: d.accessExpires }); return access;
      }
      // Il refresh token ruota: il nuovo va salvato prima di usare l’access token.
      const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: open(d.refreshEnc) });
      await store(owner, data);
      return data.access_token;
    })();
    refreshing.set(owner, job);
    try { return await job; } finally { refreshing.delete(owner); }
  }

  const recent = []; // richieste dell'ultimo minuto (limite Daikin 20/min)
  async function pace() {
    for (;;) {
      const t = Date.now();
      while (recent.length && t - recent[0] > 60000) recent.shift();
      if (recent.length < 18) { recent.push(t); return; }
      await new Promise(r => setTimeout(r, 60000 - (t - recent[0]) + 250));
    }
  }
  async function call(owner, method, path, body) {
    await pace();
    if (rate?.retryUntil > Date.now()) throw fail(429, 'daikin_rate_limit', `Limite richieste Daikin raggiunto: riprova tra ${Math.ceil((rate.retryUntil - Date.now()) / 1000)} secondi.`);
    const send = async token => fetch(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Accept-Encoding': 'gzip', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000)
    });
    let response = await send(await accessToken(owner));
    if (response.status === 401) { tokens.delete(owner); await links().doc(owner).set({ accessExpires: 0 }, { merge: true }); response = await send(await accessToken(owner)); }
    const h = n => response.headers.get(n);
    if (h('x-ratelimit-remaining-day') !== null) rate = { day: Number(h('x-ratelimit-remaining-day')), dayLimit: Number(h('x-ratelimit-limit-day')) || 200, minute: Number(h('x-ratelimit-remaining-minute')), at: Date.now() };
    if (response.status === 429) {
      const wait = Number(h('retry-after')) || 60;
      rate = { ...(rate || {}), retryUntil: Date.now() + wait * 1000 };
      throw fail(429, 'daikin_rate_limit', `Limite richieste Daikin raggiunto: riprova tra ${wait} secondi.`);
    }
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    if (response.status === 401) throw fail(409, 'daikin_not_linked', 'Daikin non riconosce più il collegamento: ricollega l’account Onecta.');
    if (!response.ok) throw fail(response.status === 422 || response.status === 400 ? 400 : 502, 'daikin_error', 'Daikin ha rifiutato il comando: ' + (data?.message || data?.error || text.slice(0, 200) || 'HTTP ' + response.status));
    return data;
  }

  async function devices(owner, force) {
    const c = caches.get(owner);
    if (c && (Date.now() - c.at < (force ? FORCE_MIN_MS : CACHE_MS))) return c;
    const list = await call(owner, 'GET', '/gateway-devices');
    if (!Array.isArray(list)) throw fail(502, 'daikin_error', 'Elenco dispositivi Daikin non valido.');
    const entry = { devices: list, at: Date.now() };
    caches.set(owner, entry);
    return entry;
  }
  function managementPoint(owner, gatewayId, embeddedId) {
    const c = caches.get(owner);
    const gw = c?.devices.find(d => d.id === gatewayId);
    const mp = gw?.managementPoints?.find(m => m.embeddedId === embeddedId);
    if (!mp) throw fail(409, 'daikin_stale', 'Stato Daikin non aggiornato: ricarica la pagina Clima.');
    return mp;
  }
  // Legge un nodo dentro value seguendo un path "/a/b/c".
  function nodeAt(characteristic, path) {
    let node = characteristic;
    if (!path) return node;
    node = node.value;
    for (const part of path.split('/').filter(Boolean)) { node = node?.[part]; if (node === undefined) return undefined; }
    return node;
  }
  const ids = b => {
    if (typeof b?.gatewayId !== 'string' || !/^[\w-]{1,80}$/.test(b.gatewayId) || typeof b?.embeddedId !== 'string' || !/^[\w-]{1,40}$/.test(b.embeddedId)) throw fail(400, 'invalid_params', 'Dispositivo Daikin non valido.');
    return [encodeURIComponent(b.gatewayId), encodeURIComponent(b.embeddedId)];
  };
  const payload = (owner, entry, extra = {}) => ({ ok: true, linked: true, devices: entry.devices, fetchedAt: entry.at, rate, ...extra });

  function install(app) {
    app.get('/api/daikin/status', requireLogin, route(async (req, res) => {
      if (!configured) return res.json({ ok: true, configured: false, linked: false });
      const snap = await links().doc(ownerOf(req)).get();
      res.json({ ok: true, configured: true, linked: snap.exists && Boolean(snap.data().refreshEnc), linkedAt: snap.data()?.linkedAt || null, rate });
    }));

    app.get('/daikin/connect', requireLogin, route(async (req, res) => {
      needConfig(); needWriter(req);
      const state = crypto.randomBytes(24).toString('hex'), verifier = crypto.randomBytes(48).toString('base64url');
      const pending = Buffer.from(JSON.stringify({ state, verifier, owner: ownerOf(req), at: Date.now() })).toString('base64url');
      res.cookie(PENDING_COOKIE, pending + '.' + mac(pending), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600000, path: '/daikin/callback' });
      const url = new URL(IDP + '/authorize');
      url.search = new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE, state,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
      }).toString();
      res.redirect(url.href);
    }));

    app.get('/daikin/callback', requireLogin, route(async (req, res) => {
      needConfig(); needWriter(req);
      const [p, m] = String(req.cookies[PENDING_COOKIE] || '').split('.');
      res.clearCookie(PENDING_COOKIE, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/daikin/callback' });
      let pending = null;
      if (p && m && m.length === mac(p).length && crypto.timingSafeEqual(Buffer.from(m), Buffer.from(mac(p)))) { try { pending = JSON.parse(Buffer.from(p, 'base64url')); } catch {} }
      const back = status => res.redirect(home + '?daikin=' + status + '#clima');
      if (!pending || pending.state !== req.query.state || pending.owner !== ownerOf(req) || Date.now() - pending.at > 600000) return back('expired');
      if (req.query.error || typeof req.query.code !== 'string') return back('denied');
      const data = await tokenRequest({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: REDIRECT_URI, code_verifier: pending.verifier });
      if (!data.refresh_token) throw fail(502, 'daikin_token', 'Daikin non ha rilasciato il token di rinnovo.');
      await store(pending.owner, data, { linkedAt: Date.now(), linkedBy: req.appActor?.email || null });
      caches.delete(pending.owner);
      back('ok');
    }));

    app.post('/api/daikin/disconnect', requireLogin, route(async (req, res) => {
      needConfig(); needWriter(req);
      const owner = ownerOf(req), ref = links().doc(owner), snap = await ref.get();
      if (snap.exists) {
        const d = snap.data();
        for (const [enc, hint] of [[d.refreshEnc, 'refresh_token'], [d.accessEnc, 'access_token']]) {
          if (!enc) continue;
          const url = new URL(IDP + '/revoke');
          for (const [k, v] of Object.entries({ token: open(enc), client_id: CLIENT_ID, client_secret: CLIENT_SECRET, token_type_hint: hint })) url.searchParams.set(k, v);
          await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
        }
        await ref.delete();
      }
      tokens.delete(owner); caches.delete(owner);
      res.json({ ok: true });
    }));

    app.get('/api/daikin/devices', requireLogin, route(async (req, res) => {
      needConfig();
      res.json(payload(ownerOf(req), await devices(ownerOf(req), req.query.refresh === '1')));
    }));

    // PATCH di una caratteristica: verificata sullo stato in cache (deve essere settable).
    app.post('/api/daikin/command', requireLogin, route(async (req, res) => {
      needConfig();
      const owner = ownerOf(req), b = req.body || {};
      const [gw, mp] = ids(b);
      if (typeof b.characteristic !== 'string' || !/^[A-Za-z][A-Za-z0-9]{1,60}$/.test(b.characteristic)) throw fail(400, 'invalid_params', 'Comando Daikin non valido.');
      if (b.path !== undefined && (typeof b.path !== 'string' || !/^(\/[A-Za-z0-9]{1,40}){1,8}$/.test(b.path))) throw fail(400, 'invalid_params', 'Percorso del comando non valido.');
      if (!['string', 'number', 'boolean'].includes(typeof b.value)) throw fail(400, 'invalid_params', 'Valore non valido.');
      const point = managementPoint(owner, b.gatewayId, b.embeddedId), ch = point[b.characteristic];
      const target = ch && nodeAt(ch, b.path);
      if (!ch || !target || typeof target !== 'object') throw fail(400, 'daikin_unsupported', 'Funzione non disponibile su questo split.');
      if (target.settable === false || (!b.path && ch.settable === false)) throw fail(409, 'daikin_not_settable', 'In questo momento lo split non accetta questa impostazione (ad es. modalità che non prevede la temperatura).');
      if (Array.isArray(target.values) && !target.values.includes(b.value)) throw fail(400, 'invalid_params', 'Valore non ammesso per questo split.');
      if (typeof b.value === 'number') {
        if (!Number.isFinite(b.value) || (Number.isFinite(target.minValue) && b.value < target.minValue) || (Number.isFinite(target.maxValue) && b.value > target.maxValue)) throw fail(400, 'invalid_params', 'Valore fuori dall’intervallo ammesso.');
      }
      if (typeof b.value === 'string' && b.value.length > 64) throw fail(400, 'invalid_params', 'Valore troppo lungo.');
      // Protezione compressore: Daikin sconsiglia accensioni/spegnimenti a meno di 10 minuti.
      const powerKey = owner + ':' + b.gatewayId + ':' + b.embeddedId;
      if (b.characteristic === 'onOffMode') {
        const last = lastPower.get(powerKey);
        if (last && Date.now() - last < 600000 && b.confirm !== true) {
          throw fail(409, 'daikin_cooldown', `Lo split è stato acceso o spento ${Math.max(1, Math.round((Date.now() - last) / 60000))} minuti fa. Daikin consiglia di attendere 10 minuti tra due avvii del compressore.`);
        }
      }
      await call(owner, 'PATCH', `/gateway-devices/${gw}/management-points/${mp}/characteristics/${b.characteristic}`, { value: b.value, ...(b.path ? { path: b.path } : {}) });
      if (b.characteristic === 'onOffMode') lastPower.set(powerKey, Date.now());
      target.value = b.value; // stato locale aggiornato senza consumare richieste
      res.json(payload(owner, caches.get(owner)));
    }));

    app.post('/api/daikin/holiday', requireLogin, route(async (req, res) => {
      needConfig();
      const owner = ownerOf(req), b = req.body || {}, [gw, mp] = ids(b);
      managementPoint(owner, b.gatewayId, b.embeddedId);
      const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
      let body;
      if (b.enabled === true) {
        if (!date(b.startDate) || !date(b.endDate) || b.startDate > b.endDate) throw fail(400, 'invalid_params', 'Indica date di inizio e fine valide (la fine non può precedere l’inizio).');
        body = { enabled: true, startDate: b.startDate, endDate: b.endDate };
      } else body = { enabled: false };
      await call(owner, 'POST', `/gateway-devices/${gw}/management-points/${mp}/holiday-mode`, body);
      caches.delete(owner);
      res.json(payload(owner, await devices(owner, false)));
    }));

    app.post('/api/daikin/schedule/current', requireLogin, route(async (req, res) => {
      needConfig();
      const owner = ownerOf(req), b = req.body || {}, [gw, mp] = ids(b);
      const point = managementPoint(owner, b.gatewayId, b.embeddedId), mode = point.schedule?.value?.modes?.[b.mode];
      if (!mode || typeof b.enabled !== 'boolean' || typeof b.scheduleId !== 'string' || !mode.currentSchedule?.values?.includes(b.scheduleId)) throw fail(400, 'invalid_params', 'Programma Daikin non valido.');
      await call(owner, 'PUT', `/gateway-devices/${gw}/management-points/${mp}/schedule/${encodeURIComponent(b.mode)}/current`, { scheduleId: b.scheduleId, enabled: b.enabled });
      mode.currentSchedule.value = b.scheduleId; if (mode.enabled) mode.enabled.value = b.enabled;
      res.json(payload(owner, caches.get(owner)));
    }));

    app.post('/api/daikin/schedule/save', requireLogin, route(async (req, res) => {
      needConfig();
      const owner = ownerOf(req), b = req.body || {}, [gw, mp] = ids(b);
      const point = managementPoint(owner, b.gatewayId, b.embeddedId), mode = point.schedule?.value?.modes?.[b.mode];
      if (!mode || !b.schedules || typeof b.schedules !== 'object') throw fail(400, 'invalid_params', 'Programma Daikin non valido.');
      const allowed = Object.keys(mode.schedules || {});
      const keys = Object.keys(b.schedules);
      if (keys.length !== allowed.length || !allowed.every(id => keys.includes(id))) throw fail(400, 'invalid_params', 'Vanno inviati tutti i programmi della modalità.');
      if (JSON.stringify(b.schedules).length > 60000) throw fail(400, 'invalid_params', 'Programma troppo grande.');
      await call(owner, 'PUT', `/gateway-devices/${gw}/management-points/${mp}/schedule/${encodeURIComponent(b.mode)}/schedules`, b.schedules);
      caches.delete(owner);
      res.json(payload(owner, await devices(owner, false)));
    }));
  }
  // ---- Programmazioni: validazione al salvataggio ed esecuzione all'orario.
  // deviceId "daikin:<gateway>:<embedded>" per uno split, "daikin:all" per tutti.
  const ALL = 'daikin:all';
  const unitId = id => {
    const m = /^daikin:([\w-]{1,80}):([\w-]{1,40})$/.exec(String(id || ''));
    if (!m) throw fail(400, 'invalid_schedule', 'Split Daikin non valido.');
    return { gatewayId: m[1], embeddedId: m[2] };
  };
  const climateUnits = owner => (caches.get(owner)?.devices || []).flatMap(g => (g.managementPoints || []).filter(m => m.managementPointType === 'climateControl').map(m => ({ gatewayId: g.id, embeddedId: m.embeddedId, mp: m })));
  function validateSettings(mp, raw, action) {
    const settings = {};
    const name = mp.name?.value || 'Split';
    const bad = msg => { throw fail(400, 'invalid_schedule', `${name}: ${msg}`); };
    if (action !== 'on') return settings;
    const modes = mp.operationMode?.values || [];
    const mode = raw.operationMode || mp.operationMode?.value;
    if (raw.operationMode) { if (!modes.includes(raw.operationMode)) bad('modalità non disponibile.'); settings.operationMode = raw.operationMode; }
    const sp = mp.temperatureControl?.value?.operationModes?.[mode]?.setpoints?.roomTemperature;
    if (raw.roomTemperature !== undefined && raw.roomTemperature !== null && raw.roomTemperature !== '') {
      const t = Number(raw.roomTemperature);
      if (!sp) bad('in questa modalità la temperatura non si imposta.');
      if (!Number.isFinite(t) || t < sp.minValue || t > sp.maxValue) bad(`temperatura fuori intervallo (${sp.minValue}–${sp.maxValue} °C).`);
      settings.roomTemperature = t;
    }
    const fan = mp.fanControl?.value?.operationModes?.[mode];
    const pick = (key, node, label) => {
      if (raw[key] === undefined || raw[key] === '') return;
      if (!node?.values?.includes(raw[key])) bad(label + ' non disponibile in questa modalità.');
      settings[key] = raw[key];
    };
    pick('fanSpeed', fan?.fanSpeed?.currentMode, 'velocità ventola');
    if (settings.fanSpeed === 'fixed' && raw.fanLevel !== undefined && raw.fanLevel !== '') {
      const f = fan.fanSpeed.modes?.fixed, l = Number(raw.fanLevel);
      if (!f || !Number.isInteger(l) || l < f.minValue || l > f.maxValue) bad('livello ventola non valido.');
      settings.fanLevel = l;
    }
    pick('vertical', fan?.fanDirection?.vertical?.currentMode, 'direzione verticale');
    pick('horizontal', fan?.fanDirection?.horizontal?.currentMode, 'direzione orizzontale');
    for (const key of ['powerfulMode', 'econoMode', 'streamerMode']) {
      if (raw[key] === undefined || raw[key] === '') continue;
      if (!mp[key]?.values?.includes(raw[key])) bad('funzione non disponibile.');
      settings[key] = raw[key];
    }
    return settings;
  }
  async function prepareSchedule(req, input) {
    needConfig();
    const owner = ownerOf(req);
    await devices(owner, false);
    const raw = input.daikin && typeof input.daikin === 'object' ? input.daikin : {};
    if (input.deviceId === ALL) {
      const list = climateUnits(owner);
      if (!list.length) throw fail(400, 'invalid_schedule', 'Nessuno split Daikin trovato.');
      let settings = {};
      for (const u of list) settings = validateSettings(u.mp, raw, input.action); // stesse impostazioni valide per ogni split
      return { name: `Tutti gli split (${list.length})`, settings, owner, units: list.map(u => 'daikin:' + u.gatewayId + ':' + u.embeddedId) };
    }
    const { gatewayId, embeddedId } = unitId(input.deviceId);
    const mp = managementPoint(owner, gatewayId, embeddedId);
    return { name: mp.name?.value || 'Split', settings: validateSettings(mp, raw, input.action), owner, units: [input.deviceId] };
  }
  async function runUnit(owner, id, state, set) {
    const { gatewayId, embeddedId } = unitId(id);
    const base = `/gateway-devices/${encodeURIComponent(gatewayId)}/management-points/${encodeURIComponent(embeddedId)}/characteristics/`;
    const mp = managementPoint(owner, gatewayId, embeddedId);
    const name = mp.name?.value || 'Split';
    const patch = (ch, value, path) => call(owner, 'PATCH', base + ch, { value, ...(path ? { path } : {}) });
    lastPower.set(owner + ':' + gatewayId + ':' + embeddedId, Date.now());
    if (state === 'off') { await patch('onOffMode', 'off'); return name + ' spento'; }
    const mode = set.operationMode || mp.operationMode?.value;
    const fan = `/operationModes/${mode}/fan`;
    const current = (ch, path) => { const n = mp[ch]; if (!path) return n?.value; let v = n?.value; for (const p of path.split('/').filter(Boolean)) v = v?.[p]; return v?.value; };
    const steps = [['onOffMode', 'on']];
    if (set.operationMode) steps.push(['operationMode', set.operationMode]);
    if (set.roomTemperature !== undefined) steps.push(['temperatureControl', set.roomTemperature, `/operationModes/${mode}/setpoints/roomTemperature`]);
    if (set.fanSpeed) steps.push(['fanControl', set.fanSpeed, fan + 'Speed/currentMode']);
    if (set.fanLevel !== undefined) steps.push(['fanControl', set.fanLevel, fan + 'Speed/modes/fixed']);
    if (set.vertical) steps.push(['fanControl', set.vertical, fan + 'Direction/vertical/currentMode']);
    if (set.horizontal) steps.push(['fanControl', set.horizontal, fan + 'Direction/horizontal/currentMode']);
    for (const key of ['powerfulMode', 'econoMode', 'streamerMode']) if (set[key]) steps.push([key, set[key]]);
    let sent = 0;
    for (const [ch, value, path] of steps) {
      if (ch !== 'onOffMode' && current(ch, path) === value) continue; // già impostato: nessuna richiesta
      await patch(ch, value, path); sent++;
    }
    return name + ' acceso';
  }
  async function runSchedule(s, state) {
    needConfig();
    const owner = s.daikinOwner || 'default';
    caches.delete(owner);
    await devices(owner, false); // stato aggiornato: salta le impostazioni già uguali
    const ids = s.deviceId === ALL ? climateUnits(owner).map(u => 'daikin:' + u.gatewayId + ':' + u.embeddedId) : [s.deviceId];
    const ok = [], failed = [];
    for (const id of ids) {
      try { ok.push(await runUnit(owner, id, state, s.daikin || {})); }
      catch (e) { failed.push((e.message || 'errore').slice(0, 120)); }
    }
    caches.delete(owner);
    if (failed.length) throw new Error(`${ok.length}/${ids.length} split eseguiti. ${failed.join(' · ')}`.slice(0, 250));
    return ids.length > 1 ? `${ok.length} split ${state === 'off' ? 'spenti' : 'accesi'} tramite Daikin.` : ok[0] + ' tramite Daikin.';
  }
  return { install, configured, prepareSchedule, runSchedule };
};
