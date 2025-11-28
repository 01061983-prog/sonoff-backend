// server.js - backend Sonoff / eWeLink v2 ufficiale

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

// ==== CONFIGURAZIONE ====

const APP_ID = process.env.EWELINK_APP_ID;
const APP_SECRET = process.env.EWELINK_APP_SECRET;
const DEFAULT_REGION = process.env.EWELINK_REGION || "eu";

// Controllo rapido: se mancano le variabili, il server parte ma segnala errore
if (!APP_ID || !APP_SECRET) {
  console.error(
    "ERRORE: EWELINK_APP_ID o EWELINK_APP_SECRET non impostati nelle Environment Variables di Render."
  );
}

// Domini frontend permessi
const allowedOrigins = [
  "https://oratoriosluigi.altervista.org",
  "http://localhost:5500",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origine non consentita: " + origin), false);
    },
  })
);

app.use(express.json());

// ==== MAPPA DOMAIN API PER REGIONE ====

const API_BASE = {
  cn: "https://cn-apia.coolkit.cn",
  as: "https://as-apia.coolkit.cc",
  us: "https://us-apia.coolkit.cc",
  eu: "https://eu-apia.coolkit.cc",
};

// Stato auth in memoria (valido finché il server rimane su)
let auth = null; // { at, region, apikey }

// Helper: restituisce base URL in base alla regione corrente
function getApiBase(region) {
  return API_BASE[region] || API_BASE[DEFAULT_REGION];
}

// ==== LOGIN DIRETTO (senza OAuth) ====

// Esegue il login e aggiorna `auth`
async function ewelinkLogin(email, password, regionHint) {
  let region = regionHint || DEFAULT_REGION;
  const payload = { email, password };

  // Funzione che chiama /v2/user/login per una regione specifica
  async function tryLoginOnce(reg) {
    const url = `${getApiBase(reg)}/v2/user/login`;
    const body = JSON.stringify(payload);

    // HMAC SHA256 del body con APP_SECRET, base64
    const sign = crypto
      .createHmac("sha256", APP_SECRET)
      .update(Buffer.from(body, "utf8"))
      .digest("base64");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Sign " + sign,
        "X-CK-Appid": APP_ID,
      },
      body,
    });

    const data = await resp.json();
    return data;
  }

  // Primo tentativo nella regione indicata
  let data = await tryLoginOnce(region);

  // Se la regione è sbagliata, il server risponde con error = 10004
  if (data.error === 10004 && data.data && data.data.region) {
    region = data.data.region;
    data = await tryLoginOnce(region);
  }

  if (data.error !== 0) {
    // error 407 -> appid senza permessi, 400 -> param error, ecc.
    throw new Error(
      `Login fallito (error=${data.error}, msg=${data.msg || "unknown"})`
    );
  }

  // Salvo i dati di autenticazione
  auth = {
    at: data.data.at, // accessToken
    region,
    apikey: data.data.user ? data.data.user.apikey : undefined,
  };

  console.log("Login OK, regione:", region);
}

// ==== GET DEVICES ====

async function ewelinkGetDevices() {
  if (!auth || !auth.at) {
    throw new Error("Non autenticato");
  }

  const url = `${getApiBase(auth.region)}/v2/device/thing?num=0`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + auth.at,
      "X-CK-Appid": APP_ID,
    },
  });

  const data = await resp.json();

  if (data.error !== 0) {
    throw new Error(
      `Errore getDevices (error=${data.error}, msg=${data.msg || "unknown"})`
    );
  }

  // thingList -> itemType 1/2 sono device, itemData contiene il device
  const devices = (data.data.thingList || [])
    .filter((i) => i.itemType === 1 || i.itemType === 2)
    .map((i) => i.itemData);

  return devices;
}

// ==== TOGGLE DEVICE ====

async function ewelinkToggleDevice(deviceId, state) {
  if (!auth || !auth.at) {
    throw new Error("Non autenticato");
  }

  const url = `${getApiBase(auth.region)}/v2/device/thing/status`;

  const body = JSON.stringify({
    type: 1, // device
    id: deviceId,
    params: {
      switch: state, // "on" o "off"
    },
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + auth.at,
      "X-CK-Appid": APP_ID,
    },
    body,
  });

  const data = await resp.json();

  if (data.error !== 0) {
    throw new Error(
      `Errore toggle (error=${data.error}, msg=${data.msg || "unknown"})`
    );
  }
}

// ==== ENDPOINTS EXPRESS ====

// LOGIN + LISTA DISPOSITIVI
app.post("/api/login", async (req, res) => {
  const { email, password, region } = req.body || {};

  if (!APP_ID || !APP_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "Configurazione server mancante (APP_ID/APP_SECRET)",
    });
  }

  if (!email || !password) {
    return res
      .status(400)
      .json({ ok: false, error: "Email o password mancanti" });
  }

  try {
    // login (usa eventuale hint di regione dal client, es. "eu")
    await ewelinkLogin(email, password, region);

    // prendo i dispositivi dell'account
    const devices = await ewelinkGetDevices();

    return res.json({ ok: true, devices });
  } catch (e) {
    console.error("Errore login/getDevices:", e.message);
    return res.status(401).json({ ok: false, error: e.message });
  }
});

// TOGGLE ON/OFF
app.post("/api/toggle", async (req, res) => {
  const { deviceId, state } = req.body || {};

  if (!deviceId || !["on", "off"].includes(state)) {
    return res
      .status(400)
      .json({ ok: false, error: "Parametri non validi per toggle" });
  }

  if (!auth || !auth.at) {
    return res
      .status(401)
      .json({ ok: false, error: "Non sei loggato (manca il token)" });
  }

  try {
    await ewelinkToggleDevice(deviceId, state);
    return res.json({ ok: true });
  } catch (e) {
    console.error("Errore toggle:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ==== AVVIO SERVER ====

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server eWeLink attivo sulla porta " + PORT);
});
