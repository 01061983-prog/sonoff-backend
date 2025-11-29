// server.js – Backend Sonoff usando ewelink-api (con APP_ID/APP_SECRET)

const express = require("express");
const cors = require("cors");
const Ewelink = require("ewelink-api");

const app = express();
app.use(express.json());

// ====== ENV DA RENDER ======
const EWELINK_USERNAME   = process.env.EWELINK_USERNAME;   // email account eWeLink
const EWELINK_PASSWORD   = process.env.EWELINK_PASSWORD;   // password account eWeLink
const EWELINK_REGION     = process.env.EWELINK_REGION || "eu";
const EWELINK_APP_ID     = process.env.EWELINK_APP_ID;
const EWELINK_APP_SECRET = process.env.EWELINK_APP_SECRET;

if (!EWELINK_USERNAME || !EWELINK_PASSWORD) {
  console.error("ERRORE: EWELINK_USERNAME o EWELINK_PASSWORD non impostati!");
}
if (!EWELINK_APP_ID || !EWELINK_APP_SECRET) {
  console.error("ATTENZIONE: EWELINK_APP_ID o EWELINK_APP_SECRET non impostati!");
}

// ====== CORS: front-end ammessi ======
app.use(
  cors({
    origin: [
      "https://oratoriosluigi.altervista.org",
      "http://localhost:5500"
    ]
  })
);

// ====== CONNESSIONE UNICA A EWeLink (ewelink-api) ======
let connection = null;

async function getConnection() {
  if (!connection) {
    connection = new Ewelink({
      email: EWELINK_USERNAME,
      password: EWELINK_PASSWORD,
      region: EWELINK_REGION,
      APP_ID: EWELINK_APP_ID,
      APP_SECRET: EWELINK_APP_SECRET,
    });
    console.log("Connessione eWeLink creata per", EWELINK_USERNAME);
  }
  return connection;
}

// 3) LISTA DISPOSITIVI – USO SOLO ewelink-api
app.get("/api/devices", async (req, res) => {
  try {
    const conn = await getConnection();

    // la libreria gestisce internamente login / token
    const devices = await conn.getDevices();

    // ewelink-api di solito restituisce oppure un array oppure un oggetto { error, msg, ... }
    if (Array.isArray(devices)) {
      return res.json({ ok: true, devices });
    }

    // gestione caso errore dalla libreria/API
    if (devices && devices.error) {
      console.error("getDevices ewelink-api error:", devices);
      return res
        .status(400)
        .json({ ok: false, error: devices.error, msg: devices.msg || "Errore da eWeLink" });
    }

    // fallback generico
    return res
      .status(500)
      .json({ ok: false, error: "unknown_response", msg: "Risposta sconosciuta da ewelink-api" });
  } catch (e) {
    console.error("Errore interno /api/devices:", e);
    return res.status(500).json({ ok: false, error: "internal_error", msg: e.message });
  }
});

// porta (Render di solito usa process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
