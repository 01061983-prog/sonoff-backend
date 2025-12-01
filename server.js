// server.js — Backend Sonoff / eWeLink OAuth2.0

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

// ================== CONFIG ==================

const APPID = process.env.EWELINK_APP_ID;
const APPSECRET = process.env.EWELINK_APP_SECRET;

// Se vuoi, puoi mettere questa anche in env come EWELINK_REDIRECT_URL
const REDIRECT_URL =
  process.env.EWELINK_REDIRECT_URL ||
  "https://sonoff-backend-k8sh.onrender.com/oauth/callback";

// Host API EU (puoi sovrascrivere con env EWELINK_API_BASE se serve)
const API_BASE =
  process.env.EWELINK_API_BASE || "https://eu-apia.coolkit.cc";

if (!APPID || !APPSECRET) {
  console.error("ERRORE: EWELINK_APP_ID o EWELINK_APP_SECRET non impostati!");
}

// Token in memoria (per uso base va bene così)
let oauth = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0, // timestamp ms
};

// ================== CORS ==================

app.use(
  cors({
    origin: [
      "https://oratoriosluigi.altervista.org",
      "http://localhost:5500",
    ],
  })
);

// ================== HELPER TOKEN ==================

async function ensureToken() {
  // Se non ho token, non posso fare nulla
  if (!oauth.accessToken) return;

  // Se non è in scadenza, esco
  if (Date.now() < oauth.expiresAt - 5000) return;

  // Refresh token
  try {
    const resp = await fetch(`${API_BASE}/v2/user/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: APPID,
        clientSecret: APPSECRET,
        grantType: "refresh_token",
        refreshToken: oauth.refreshToken,
      }),
    });

    const data = await resp.json();
    console.log("refresh token response:", data);

    if (data.error === 0 && data.data) {
      oauth.accessToken = data.data.accessToken;
      oauth.refreshToken = data.data.refreshToken;
      oauth.expiresAt = Date.now() + data.data.expiresIn * 1000;
    } else {
      console.error("Errore refresh token:", data);
      oauth.accessToken = null;
      oauth.refreshToken = null;
      oauth.expiresAt = 0;
    }
  } catch (e) {
    console.error("Eccezione refresh token:", e);
    oauth.accessToken = null;
    oauth.refreshToken = null;
    oauth.expiresAt = 0;
  }
}

// ================== ROUTE BASE ==================

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend Sonoff OAuth attivo" });
});

// ================== /login — REDIRECT A PAGINA OAUTH ==================
//
// URL richiesto da eWeLink docs:
// https://c2ccdn.coolkit.cc/oauth/index.html
//   ?state=XXX
//   &clientId=XXX
//   &authorization=XXX
//   &seq=123
//   &redirectUrl=https://XXX.com/redirect.html
//   &nonce=zt123456
//   &grantType=authorization_code
//   &showQRCode=false
//
app.get("/login", (req, res) => {
  const state = "xyz123";    // opzionale, per sicurezza
  const seq = "1";           // può essere un contatore
  const nonce = "abc12345";  // stringa qualsiasi

  const url =
    "https://c2ccdn.coolkit.cc/oauth/index.html" +
    "?state=" + encodeURIComponent(state) +
    "&clientId=" + encodeURIComponent(APPID) +
    "&authorization=Sign" +
    "&seq=" + encodeURIComponent(seq) +
    "&redirectUrl=" + encodeURIComponent(REDIRECT_URL) +
    "&nonce=" + encodeURIComponent(nonce) +
    "&grantType=authorization_code" +
    "&showQRCode=false";

  res.redirect(url);
});

// ================== /oauth/callback — RICEVE CODE E FA /v2/user/oauth/token ==================

app.get("/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error("Errore riportato da OAuth callback:", error);
    return res.status(400).send("OAuth error: " + error);
  }

  if (!code) {
    console.error("Manca il code in callback, query:", req.query);
    return res.status(400).send("Missing 'code' in OAuth callback");
  }

  try {
    const resp = await fetch(`${API_BASE}/v2/user/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: APPID,
        clientSecret: APPSECRET,
        grantType: "authorization_code",
        code,
        redirectUrl: REDIRECT_URL,
      }),
    });

    const data = await resp.json();
    console.log("oauth token response:", data);

    if (data.error !== 0 || !data.data) {
      return res
        .status(500)
        .send("Errore nello scambio code/token: " + JSON.stringify(data));
    }

    oauth.accessToken = data.data.accessToken;
    oauth.refreshToken = data.data.refreshToken;
    oauth.expiresAt = Date.now() + data.data.expiresIn * 1000;

    // messaggio semplice, poi l'utente torna alla pagina HTML
    res.send(
      "Autorizzazione completata. Puoi chiudere questa pagina e tornare al pannello Sonoff."
    );
  } catch (e) {
    console.error("Eccezione /oauth/callback:", e);
    res.status(500).send("Eccezione nello scambio token");
  }
});

// ================== /api/devices — LISTA DISPOSITIVI ==================

app.get("/api/devices", async (req, res) => {
  if (!oauth.accessToken) {
    return res.json({
      ok: false,
      error: "not_authenticated",
      msg: "Non autenticato su eWeLink. Vai prima su /login.",
    });
  }

  await ensureToken();

  try {
    // 1) Family
    const familyResp = await fetch(`${API_BASE}/v2/family`, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + oauth.accessToken,
        "X-CK-Appid": APPID,
      },
    });
    const familyData = await familyResp.json();
    console.log("family response:", familyData);

    if (familyData.error !== 0 || !familyData.data) {
      return res.json({
        ok: false,
        error: familyData.error,
        msg: familyData.msg || "Errore lettura family",
      });
    }

    const familyList = familyData.data.familyList || [];
    if (!familyList.length) {
      return res.json({
        ok: true,
        devices: [],
        msg: "Nessuna family associata all'account",
      });
    }

    const familyId = familyList[0].id;

    // 2) Device list
    const devResp = await fetch(
      `${API_BASE}/v2/device/thing?num=0&familyid=${encodeURIComponent(
        familyId
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + oauth.accessToken,
          "X-CK-Appid": APPID,
        },
      }
    );

    const devData = await devResp.json();
    console.log("device thing response:", devData);

    if (devData.error !== 0 || !devData.data) {
      return res.json({
        ok: false,
        error: devData.error,
        msg: devData.msg || "Errore lettura dispositivi",
      });
    }

    const devices =
      (devData.data.thingList || [])
        .filter((i) => i.itemType === 1 || i.itemType === 2)
        .map((i) => i.itemData) || [];

    return res.json({ ok: true, devices });
  } catch (e) {
    console.error("Eccezione /api/devices:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message,
    });
  }
});

// ================== /api/toggle — ON/OFF DISPOSITIVO ==================

app.post("/api/toggle", async (req, res) => {
  const { deviceId, state } = req.body;

  if (!oauth.accessToken) {
    return res.json({
      ok: false,
      error: "not_authenticated",
      msg: "Non autenticato su eWeLink. Vai prima su /login.",
    });
  }

  if (!deviceId || (state !== "on" && state !== "off")) {
    return res.json({
      ok: false,
      error: "invalid_params",
      msg: "deviceId o state non validi",
    });
  }

  await ensureToken();

  try {
    const resp = await fetch(`${API_BASE}/v2/device/thing/status`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + oauth.accessToken,
        "Content-Type": "application/json",
        "X-CK-Appid": APPID,
      },
      body: JSON.stringify({
        itemType: 1,
        id: deviceId,
        params: {
          switch: state,
        },
      }),
    });

    const data = await resp.json();
    console.log("toggle response:", data);

    if (data.error !== 0) {
      return res.json({
        ok: false,
        error: data.error,
        msg: data.msg || "Errore nel comando",
      });
    }

    return res.json({ ok: true, result: data });
  } catch (e) {
    console.error("Eccezione /api/toggle:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message,
    });
  }
});

// ================== AVVIO SERVER ==================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server avviato sulla porta", PORT);
});
