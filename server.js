// server.js — Backend Sonoff / eWeLink OAuth2.0

const express = require("express");
const cors = require("cors");
const crypto = require("crypto"); // per HMAC-SHA256

const app = express();
app.use(express.json());

// ================== CONFIG ==================

const APPID = process.env.EWELINK_APP_ID;
const APPSECRET = process.env.EWELINK_APP_SECRET;

const REDIRECT_URL =
  process.env.EWELINK_REDIRECT_URL ||
  "https://sonoff-backend-k8sh.onrender.com/oauth/callback";

// Host API EU
const API_BASE =
  process.env.EWELINK_API_BASE || "https://eu-apia.coolkit.cc";

if (!APPID || !APPSECRET) {
  console.error(
    "ERRORE: EWELINK_APP_ID o EWELINK_APP_SECRET non impostati!"
  );
}

// Token in memoria
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

// ================== HMAC SIGN ==================

// Firma generica: HMAC-SHA256(message) con APPSECRET, in base64
function createSign(message) {
  return crypto
    .createHmac("sha256", APPSECRET)
    .update(message, "utf8")
    .digest("base64");
}

/**
 * Utility: costruisce una stringa "canonica" con i parametri ordinati
 * es: {a:1, c:3, b:2} -> "a=1&b=2&c=3"
 */
function buildCanonicalString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

// ================== HELPER TOKEN (refresh) ==================

async function ensureToken() {
  if (!oauth.accessToken) return;
  if (Date.now() < oauth.expiresAt - 5000) return;

  try {
    const bodyObj = {
      grantType: "refresh_token",
      refreshToken: oauth.refreshToken,
    };
    const bodyStr = JSON.stringify(bodyObj);
    const sign = createSign(bodyStr);

    const resp = await fetch(`${API_BASE}/v2/user/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CK-Appid": APPID,
        Authorization: `Sign ${sign}`,
      },
      body: bodyStr,
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
// ================== /login — REDIRECT A PAGINA OAUTH ==================

app.get("/login", (req, res) => {
  const state = "xyz123";
  const seq = Date.now().toString();
  const nonce = "abc12345";

  // Parametri richiesti da COOLKIT (dev docs)
  const params = {
    clientId: APPID,
    grantType: "authorization_code",
    nonce,
    redirectUrl: REDIRECT_URL,
    seq,
    state,
    showQRCode: "false"
  };

  // Firma HMAC-SHA256 dell’intera query string ORDINATA
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const sign = crypto
    .createHmac("sha256", APPSECRET)
    .update(sorted)
    .digest("base64");

  const url =
    "https://c2ccdn.coolkit.cc/oauth/index.html" +
    `?state=${encodeURIComponent(state)}` +
    `&clientId=${encodeURIComponent(APPID)}` +
    `&authorization=${encodeURIComponent(sign)}` +
    `&seq=${encodeURIComponent(seq)}` +
    `&redirectUrl=${encodeURIComponent(REDIRECT_URL)}` +
    `&nonce=${encodeURIComponent(nonce)}` +
    `&grantType=authorization_code` +
    `&showQRCode=false`;

  console.log("URL OAuth generato:", url);

  res.redirect(url);
});


// ================== /oauth/callback — SCAMBIO CODE → TOKEN ==================

app.get("/oauth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error("Errore callback OAuth:", error);
    return res.status(400).send("OAuth error: " + error);
  }

  if (!code) {
    console.error("Manca il code:", req.query);
    return res.status(400).send("Manca 'code' in OAuth callback");
  }

  try {
    const bodyObj = {
      code,
      redirectUrl: REDIRECT_URL,
      grantType: "authorization_code"
    };

    const bodyStr = JSON.stringify(bodyObj);

    // Firma del body
    const sign = crypto
      .createHmac("sha256", APPSECRET)
      .update(bodyStr)
      .digest("base64");

    console.log("Richiesta token, body:", bodyObj);
    console.log("Sign:", sign);

    const resp = await fetch(`${API_BASE}/v2/user/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CK-Appid": APPID,
        Authorization: `Sign ${sign}`
      },
      body: bodyStr
    });

    const data = await resp.json();
    console.log("Risposta token:", data);

    if (data.error !== 0) {
      return res
        .status(400)
        .send("Errore nello scambio code/token: " + JSON.stringify(data));
    }

    oauth.accessToken = data.data.accessToken;
    oauth.refreshToken = data.data.refreshToken;
    oauth.expiresAt = Date.now() + data.data.expiresIn * 1000;

    res.send("Autorizzazione completata. Puoi chiudere questa pagina.");
  } catch (e) {
    console.error("Eccezione callback:", e);
    res.status(500).send("Errore interno callback OAuth");
  }
});
