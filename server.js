// server.js — eWeLink OAuth2.0 Backend per Sonoff
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ===== ENV =====
const APPID = process.env.EWELINK_APP_ID;
const APPSECRET = process.env.EWELINK_APP_SECRET;

const REDIRECT_URI = "https://sonoff-backend-k8sh.onrender.com/oauth/callback";
const API_BASE = "https://eu-api.coolkit.cc";  // EU server

let oauth = {
  access_token: null,
  refresh_token: null,
  at_expires: 0
};

app.use(cors({
  origin: [
    "https://oratoriosluigi.altervista.org",
    "http://localhost:5500"
  ]
}));

// ============= LOGIN FLOW =============

// STEP 1 — Redirect utente alla pagina autorizzazione
app.get("/login", (req, res) => {
  const url =
    `https://c2ccdn.coolkit.cc/oauth/index.html?client_id=${APPID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&state=xyz123`;

  res.redirect(url);
});

// STEP 2 — Ricevo il CODE e prendo il token
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;

  const resp = await fetch(`${API_BASE}/v2/user/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: APPID,
      client_secret: APPSECRET,
      redirect_uri: REDIRECT_URI
    })
  });

  const data = await resp.json();

  if (data.error !== 0) {
    return res.send("Errore OAuth: " + JSON.stringify(data));
  }

  oauth.access_token = data.data.access_token;
  oauth.refresh_token = data.data.refresh_token;
  oauth.at_expires = Date.now() + (data.data.expires_in * 1000);

  return res.send("Autorizzazione completata. Ora torna sulla tua pagina Sonoff.");
});

// ============= API AUTENTICATE =============

// TOKEN VALIDATION
async function ensureToken() {
  if (Date.now() < oauth.at_expires - 5000) return;

  const resp = await fetch(`${API_BASE}/v2/user/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refresh_token,
      client_id: APPID,
      client_secret: APPSECRET
    })
  });

  const data = await resp.json();
  if (data.error === 0) {
    oauth.access_token = data.data.access_token;
    oauth.refresh_token = data.data.refresh_token;
    oauth.at_expires = Date.now() + (data.data.expires_in * 1000);
  }
}

// ====== GET DEVICES ======
app.get("/api/devices", async (req, res) => {
  if (!oauth.access_token)
    return res.json({ ok: false, msg: "Non autenticato su eWeLink" });

  await ensureToken();

  // 1) ottieni Family ID
  const familyResp = await fetch(`${API_BASE}/v2/family`, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + oauth.access_token,
      "X-CK-Appid": APPID
    }
  });
  const familyData = await familyResp.json();

  if (familyData.error !== 0)
    return res.json({ ok: false, error: familyData.error, msg: familyData.msg });

  const familyId = familyData.data.familyList[0].id;

  // 2) device list
  const devResp = await fetch(
    `${API_BASE}/v2/device/thing?num=0&familyid=${familyId}`, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + oauth.access_token,
        "X-CK-Appid": APPID
      }
    }
  );

  const devData = await devResp.json();

  if (devData.error !== 0)
    return res.json({ ok: false, error: devData.error, msg: devData.msg });

  const devices = devData.data.thingList
    .filter(d => d.itemType === 1)
    .map(i => i.itemData);

  res.json({ ok: true, devices });
});

// ====== TOGGLE ======
app.post("/api/toggle", async (req, res) => {
  const { deviceId, state } = req.body;

  await ensureToken();

  const resp = await fetch(`${API_BASE}/v2/device/thing/status`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + oauth.access_token,
      "Content-Type": "application/json",
      "X-CK-Appid": APPID
    },
    body: JSON.stringify({
      itemType: 1,
      id: deviceId,
      params: { switch: state }
    })
  });

  const data = await resp.json();
  res.json({ ok: data.error === 0, raw: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SERVER OK PORT", PORT));
