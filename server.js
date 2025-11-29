// server.js – Backend semplice per pannello Sonoff usando ewelink-api

const express = require("express");
const cors = require("cors");
const Ewelink = require("ewelink-api");

const app = express();
app.use(express.json());

// ====== ENV DA RENDER ======
const EWELINK_USERNAME = process.env.EWELINK_USERNAME; // email account eWeLink
const EWELINK_PASSWORD = process.env.EWELINK_PASSWORD; // password account eWeLink

if (!EWELINK_USERNAME || !EWELINK_PASSWORD) {
  console.error("ERRORE: EWELINK_USERNAME o EWELINK_PASSWORD non impostati!");
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

// ====== CONNESSIONE UNICA A EWeLink ======
let connection = null;

async function getConnection() {
  if (!connection) {
    connection = new Ewelink({
      email: EWELINK_USERNAME,
      password: EWELINK_PASSWORD
      // niente region: la scopre la libreria
    });
    console.log("Connessione eWeLink creata per", EWELINK_USERNAME);
  }
  return connection;
}

// ====== API: lista dispositivi ======
app.get("/api/devices", async (req, res) => {
  try {
    const conn = await getConnection();
    const raw = await conn.getDevices();

    console.log("DEBUG getDevices raw:", JSON.stringify(raw).slice(0, 500));

    let devices = [];

    if (Array.isArray(raw)) {
      devices = raw;
    } else if (raw && Array.isArray(raw.devices)) {
      devices = raw.devices;
    } else if (raw && Array.isArray(raw.data)) {
      devices = raw.data;
    }

    if (!devices.length) {
      return res.json({ ok: true, devices: [], raw });
    }

    res.json({ ok: true, devices, raw });
  } catch (err) {
    console.error("Errore /api/devices:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ====== API: accendi/spegni ======
app.post("/api/toggle", async (req, res) => {
  const { deviceId, state, outlet } = req.body || {}; // state: "on" | "off"

  if (!deviceId || !state) {
    return res
      .status(400)
      .json({ ok: false, error: "deviceId o state mancanti" });
  }

  try {
    const conn = await getConnection();
    let result;

    if (typeof outlet === "number") {
      // device multi-canale
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

// ====== AVVIO SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server Sonoff attivo sulla porta " + PORT);
});
