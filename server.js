// server.js – Backend Sonoff usando ewelink-api (senza APP_ID/APP_SECRET custom)

const express = require("express");
const cors = require("cors");
const Ewelink = require("ewelink-api");

const app = express();
app.use(express.json());

// ====== ENV DA RENDER ======
const EWELINK_USERNAME   = process.env.EWELINK_USERNAME;   // email account eWeLink
const EWELINK_PASSWORD   = process.env.EWELINK_PASSWORD;   // password account eWeLink
const EWELINK_REGION     = process.env.EWELINK_REGION || "eu";

if (!EWELINK_USERNAME || !EWELINK_PASSWORD) {
  console.error("ERRORE: EWELINK_USERNAME o EWELINK_PASSWORD non impostati!");
}
if (!EWELINK_REGION) {
  console.error("ATTENZIONE: EWELINK_REGION non impostata (es. 'eu', 'us', 'cn')");
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
      region: EWELINK_REGION
      // NIENTE APP_ID / APP_SECRET qui
    });
    console.log("Connessione eWeLink creata per", EWELINK_USERNAME);
  }
  return connection;
}

// ROUTE DI TEST
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend Sonoff attivo" });
});

// 1) LISTA DISPOSITIVI – /api/devices
app.get("/api/devices", async (req, res) => {
  try {
    const conn = await getConnection();

    const result = await conn.getDevices();

    console.log("Risposta grezza getDevices:", result);

    // Caso OK: result è un array di dispositivi
    if (Array.isArray(result)) {
      return res.json({ ok: true, devices: result });
    }

    // Caso errore restituito da ewelink-api
    if (result && typeof result === "object" && result.error) {
      console.error("getDevices ewelink-api error:", result);
      // NOTA: niente status(400), rispondo sempre 200 con ok:false
      return res.json({
        ok: false,
        error: result.error,
        msg: result.msg || "Errore da eWeLink",
      });
    }

    // Risposta inattesa
    console.error("getDevices risposta inattesa:", result);
    return res.json({
      ok: false,
      error: "unknown_response",
      msg: "Risposta sconosciuta da ewelink-api",
    });
  } catch (e) {
    console.error("Errore interno /api/devices:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message,
    });
  }
});
