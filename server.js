// server.js – Backend Sonoff usando ewelink-api

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

// ROUTE DI TEST
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend Sonoff attivo" });
});

// 1) LISTA DISPOSITIVI – /api/devices
app.get("/api/devices", async (req, res) => {
  try {
    const conn = await getConnection();

    // ewelink-api gestisce internamente login/token
    const result = await conn.getDevices();

    // Se è un array, è la lista dispositivi
    if (Array.isArray(result)) {
      return res.json({ ok: true, devices: result });
    }

    // Se è un oggetto con error, propago come 400
    if (result && typeof result === "object" && result.error) {
      console.error("getDevices ewelink-api error:", result);
      return res
        .status(400)
        .json({
          ok: false,
          error: result.error,
          msg: result.msg || "Errore da eWeLink",
        });
    }

    // Risposta inattesa
    console.error("getDevices risposta inattesa:", result);
    return res
      .status(500)
      .json({
        ok: false,
        error: "unknown_response",
        msg: "Risposta sconosciuta da ewelink-api",
      });
  } catch (e) {
    console.error("Errore interno /api/devices:", e);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", msg: e.message });
  }
});

// 2) TOGGLE DISPOSITIVO – /api/toggle
app.post("/api/toggle", async (req, res) => {
  const { deviceId, state } = req.body;

  if (!deviceId || (state !== "on" && state !== "off")) {
    return res
      .status(400)
      .json({ ok: false, error: "invalid_params", msg: "deviceId o state non validi" });
  }

  try {
    const conn = await getConnection();

    // Per dispositivi singolo canale
    const result = await conn.setDevicePowerState(deviceId, state);

    if (result && result.error) {
      console.error("setDevicePowerState error:", result);
      return res
        .status(400)
        .json({
          ok: false,
          error: result.error,
          msg: result.msg || "Errore da eWeLink",
        });
    }

    return res.json({ ok: true, result });
  } catch (e) {
    console.error("Errore interno /api/toggle:", e);
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", msg: e.message });
  }
});

// PORTA (Render usa process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
