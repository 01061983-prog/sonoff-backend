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

// ====== CONNESSIONE UNICA A EWeLink ======
let connection = null;

async function getConnection() {
  if (!connection) {
    connection = new Ewelink({
      email: EWELINK_USERNAME,
      password: EWELINK_PASSWORD,
      region: EWELINK_REGION,
      APP_ID: EWELINK_APP_ID,
      APP_SECRET: EWELINK_APP_SECRET
    });
    console.log("Connessione eWeLink creata per", EWELINK_USERNAME);
  }
  return connection;
}

// 3) LISTA DISPOSITIVI
app.get("/api/devices", async (req, res) => {
  if (!oauth.access_token) {
    return res.status(401).json({ ok: false, error: "Non autenticato" });
  }

  try {
    // 3.1 – recupero la family (casa) principale
    const familyResp = await fetch(`${API_BASE}/v2/family`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + oauth.access_token,
        "X-CK-Appid": APPID,
      },
    });

    const familyData = await familyResp.json();

    if (familyData.error !== 0) {
      throw new Error(
        `getFamily error=${familyData.error}, msg=${familyData.msg || "unknown"}`
      );
    }

    const familyList = familyData.data?.familyList || [];
    const familyId = familyList[0]?.id || null;

    // 3.2 – chiamo /v2/device/thing con i parametri richiesti
    const query = familyId
      ? `?num=0&familyid=${encodeURIComponent(familyId)}`
      : `?num=0`;

    const devicesResp = await fetch(`${API_BASE}/v2/device/thing${query}`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + oauth.access_token,
        "X-CK-Appid": APPID,
      },
    });

    const devicesData = await devicesResp.json();

    if (devicesData.error !== 0) {
      throw new Error(
        `getDevices error=${devicesData.error}, msg=${devicesData.msg || "unknown"}`
      );
    }

    const devices = (devicesData.data?.thingList || [])
      .filter((i) => i.itemType === 1 || i.itemType === 2) // solo dispositivi, no gruppi
      .map((i) => i.itemData);

    return res.json({ ok: true, devices });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
