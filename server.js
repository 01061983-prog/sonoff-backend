// server.js – Backend semplice per pannello Sonoff

const express = require("express");
const cors = require("cors");
const Ewelink = require("ewelink-api");

const app = express();
app.use(express.json());

// CORS: front-end ammessi
app.use(
  cors({
    origin: [
      "https://oratoriosluigi.altervista.org",
      "http://localhost:5500"
    ]
  })
);

// --- CONFIGURAZIONE DA ENV SU RENDER ---
// (le metti nella sezione Environment)
const EWELINK_USERNAME = process.env.EWELINK_USERNAME; // la tua mail eWeLink
const EWELINK_PASSWORD = process.env.EWELINK_PASSWORD; // la tua password
const EWELINK_REGION   = process.env.EWELINK_REGION || "eu"; // es. "eu"
const EWELINK_APP_ID   = process.env.EWELINK_APP_ID;
const EWELINK_APP_SECRET = process.env.EWELINK_APP_SECRET;

// Connessione condivisa
let connection = null;

// Crea (o riusa) la connessione verso eWeLink
async function getConnection() {
  if (
    !EWELINK_USERNAME ||
    !EWELINK_PASSWORD ||
    !EWELINK_APP_ID ||
    !EWELINK_APP_SECRET
  ) {
    throw new Error("Mancano le variabili ENV eWeLink sul server");
  }

  if (!connection) {
    connection = new Ewelink({
      email: EWELINK_USERNAME,
      password: EWELINK_PASSWORD,
      region: EWELINK_REGION,
      APP_ID: EWELINK_APP_ID,
      APP_SECRET: EWELINK_APP_SECRET
    });
  }

  return connection;
}

// --- API: lista dispositivi ---
app.get("/api/devices", async (req, res) => {
  try {
    const conn = await getConnection();
    const devices = await conn.getDevices();
    res.json({ ok: true, devices });
  } catch (err) {
    console.error("Errore /api/devices:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: accendi/spegni ---
app.post("/api/toggle", async (req, res) => {
  const { deviceId, state, outlet } = req.body; // state: "on" | "off"

  if (!deviceId || !state) {
    return res
      .status(400)
      .json({ ok: false, error: "deviceId o state mancanti" });
  }

  try {
    const conn = await getConnection();

    let result;
    if (typeof outlet === "number") {
      // multi-canale
      result = await conn.setDevicePowerState(deviceId, state, outlet);
    } else {
      result = await conn.setDevicePowerState(deviceId, state);
    }

    res.json({ ok: true, result });
  } catch (err) {
    console.error("Errore /api/toggle:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- AVVIO SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server Sonoff attivo sulla porta " + PORT);
});
