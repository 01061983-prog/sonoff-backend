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

    if (Array.isArray(result)) {
      return res.json({ ok: true, devices: result });
    }

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

    const result = await conn.setDevicePowerState(deviceId, state);

    console.log("Risposta setDevicePowerState:", result);

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
