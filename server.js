// server.js – Backend Sonoff + OAuth2.0 eWeLink (versione corretta)

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

// libreria ufficiale CoolKit V2
const eWeLink = require("ewelink-api-next").default;

const app = express();
app.use(express.json());

// ====== CONFIGURAZIONE APPID / SECRET / REGIONE ======

const APPID = process.env.EWELINK_APP_ID;
const APPSECRET = process.env.EWELINK_APP_SECRET;
const REGION = process.env.EWELINK_REGION || "eu";

const REDIRECT_URI = "https://sonoff-backend-k8sh.onrender.com/oauth/callback";
const API_BASE = "https://eu-apia.coolkit.cc"; // per account EU

if (!APPID || !APPSECRET) {
  console.error(
    "ERRORE: EWELINK_APP_ID o EWELINK_APP_SECRET non sono impostati su Render."
  );
}

// client WebAPI ufficiale (lo uso solo per creare l'URL di login)
const webApiClient = new eWeLink.WebAPI({
  appId: APPID,
  appSecret: APPSECRET,
  region: REGION,
  requestRecord: false,
});

// Stato OAuth in memoria
let oauth = {
  access_token: null,
  refresh_token: null,
  at_expires: null,
};

// ====== CORS (front-end Altervista) ======

app.use(
  cors({
    origin: [
      "https://oratoriosluigi.altervista.org",
      "http://localhost:5500",
    ],
    credentials: true,
  })
);

// ====== 1) LOGIN: reindirizza alla pagina ufficiale di login eWeLink ======

app.get("/oauth/login", async (req, res) => {
  try {
    // lascio alla libreria il compito di costruire l’URL giusto
    const loginUrl = webApiClient.oauth.createLoginUrl({
      redirectUrl: REDIRECT_URI,
      grantType: "authorization_code",
      state: "oratorio",
    });

    console.log("Redirect a pagina di login eWeLink:", loginUrl);
    res.redirect(loginUrl);
  } catch (err) {
    console.error("Errore nella creazione loginUrl:", err);
    res.status(500).send("Errore nella creazione dell'URL di login.");
  }
});

// ====== 2) CALLBACK: riceve ?code=... e chiede il token ======

app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    console.error("Callback senza code:", req.query);
    return res.status(400).send("Manca il parametro 'code' nella callback.");
  }

  console.log("Ricevuto code OAuth:", code, "state:", state);

  const tokenUrl = `${API_BASE}/v2/user/oauth/token`;

  const body = JSON.stringify({
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });

  // HMAC SHA256 del body, come richiesto dalla doc eWeLink
  const sign = crypto
    .createHmac("sha256", APPSECRET)
    .update(Buffer.from(body, "utf8"))
    .digest("base64");

  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Sign " + sign,
        "X-CK-Appid": APPID,
      },
      body,
    });

    const data = await resp.json();
    console.log("Risposta /oauth/token:", data);

    if (data.error !== 0) {
      return res
        .status(500)
        .send("Errore nel recupero del token: " + (data.msg || data.error));
    }

    oauth.access_token = data.data.access_token;
    oauth.refresh_token = data.data.refresh_token;
    oauth.at_expires = Date.now() + data.data.expires_in * 1000;

    console.log("Access token salvato, scadenza:", new Date(oauth.at_expires));

    // Torno alla tua pagina HTML su Altervista
    res.redirect("https://oratoriosluigi.altervista.org/sonoff.html");
  } catch (err) {
    console.error("Errore chiamando /oauth/token:", err);
    res.status(500).send("Errore interno durante lo scambio del code.");
  }
});

// ====== 3) LISTA DISPOSITIVI ======

app.get("/api/devices", async (req, res) => {
  if (!oauth.access_token) {
    return res.status(401).json({ ok: false, error: "Non autenticato" });
  }

  // se è scaduto, per ora rispondo 401 (potremmo usare il refresh_token)
  if (oauth.at_expires && Date.now() >= oauth.at_expires) {
    return res
      .status(401)
      .json({ ok: false, error: "Access token scaduto, rifai il login" });
  }

  try {
    const url = `${API_BASE}/v2/device/thing?num=0`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + oauth.access_token,
        "X-CK-Appid": APPID,
      },
    });

    const data = await resp.json();
    console.log("Risposta /v2/device/thing:", data);

    if (data.error !== 0) {
      return res
        .status(500)
        .json({ ok: false, error: data.msg || "Errore getDevices" });
    }

    const devices = (data.data.thingList || []).map((i) => i.itemData);
    res.json({ ok: true, devices });
  } catch (err) {
    console.error("Errore /api/devices:", err);
    res.status(500).json({ ok: false, error: "Errore interno" });
  }
});

// ====== 4) TOGGLE ON/OFF ======

app.post("/api/toggle", async (req, res) => {
  const { deviceId, state } = req.body || {};

  if (!oauth.access_token) {
    return res.status(401).json({ ok: false, error: "Non autenticato" });
  }

  if (!deviceId || !["on", "off"].includes(state)) {
    return res
      .status(400)
      .json({ ok: false, error: "Parametri non validi per toggle" });
  }

  try {
    const url = `${API_BASE}/v2/device/thing/status`;

    const body = JSON.stringify({
      type: 1,
      id: deviceId,
      params: { switch: state },
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + oauth.access_token,
        "X-CK-Appid": APPID,
      },
      body,
    });

    const data = await resp.json();
    console.log("Risposta toggle:", data);

    if (data.error !== 0) {
      return res
        .status(500)
        .json({ ok: false, error: data.msg || "Errore toggle" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Errore /api/toggle:", err);
    res.status(500).json({ ok: false, error: "Errore interno" });
  }
});

// ====== AVVIO SERVER ======

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server eWeLink OAuth attivo sulla porta " + PORT);
});
