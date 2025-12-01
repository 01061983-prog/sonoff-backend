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
app.get("/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error("Errore riportato da OAuth callback:", error);
    return res
      .status(400)
      .send("OAuth error from provider: " + error);
  }

  if (!code) {
    console.error("Manca il code in callback, query:", req.query);
    return res
      .status(400)
      .send("Missing 'code' in OAuth callback, query=" + JSON.stringify(req.query));
  }

  try {
    const body = {
      clientId: APPID,
      clientSecret: APPSECRET,
      grantType: "authorization_code",
      code,
      redirectUrl: REDIRECT_URL,
      // parametri aggiuntivi richiesti dalla doc / come nei log che ti hanno citato
      authorization: "Sign",
      seq: "1",
      nonce: "abc12345",
      state: state || "xyz123",
    };

    console.log("Richiesta /v2/user/oauth/token body:", body);

    const resp = await fetch(`${API_BASE}/v2/user/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    console.log("oauth token response:", data);

    if (data.error !== 0 || !data.data) {
      // invece di 500 generico, ti faccio vedere il JSON esatto
      return res
        .status(400)
        .send("Errore nello scambio code/token: " + JSON.stringify(data));
    }

    oauth.accessToken = data.data.accessToken;
    oauth.refreshToken = data.data.refreshToken;
    oauth.expiresAt = Date.now() + data.data.expiresIn * 1000;

    return res.send(
      "Autorizzazione completata. Puoi chiudere questa pagina e tornare al pannello Sonoff."
    );
  } catch (e) {
    console.error("Eccezione /oauth/callback:", e);
    return res
      .status(500)
      .send("Eccezione nello scambio token: " + e.message);
  }
});
