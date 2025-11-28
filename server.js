const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG presi da Render
const APP_ID = process.env.EWELINK_APP_ID;
const ACCESS_TOKEN = process.env.EWELINK_ACCESS_TOKEN;
const REGION = process.env.EWELINK_REGION || 'eu';

// Endpoint base per le API v2 in base alla regione
const REGION_BASE = {
  eu: 'https://eu-apia.coolkit.cc',
  us: 'https://us-apia.coolkit.cc',
  as: 'https://as-apia.coolkit.cc',
  cn: 'https://cn-apia.coolkit.cn'
};
const API_BASE = REGION_BASE[REGION] || REGION_BASE.eu;

// CORS: permetti solo il tuo sito e il localhost
const allowedOrigins = [
  'https://oratoriosluigi.altervista.org',
  'http://localhost:5500'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origine non consentita: ' + origin), false);
  }
}));

app.use(express.json());

// Semplice test
app.get('/', (req, res) => {
  res.send('Sonoff backend attivo');
});

// ---------------------------------------------------------------------
//  GET /api/devices  -> Elenco dispositivi eWeLink per il tuo account
// ---------------------------------------------------------------------
app.get('/api/devices', async (req, res) => {
  if (!APP_ID || !ACCESS_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'Configurazione server mancante (APP_ID o ACCESS_TOKEN)'
    });
  }

  try {
    const resp = await fetch(API_BASE + '/v2/device/thing', {
      method: 'GET',
      headers: {
        'X-CK-Appid': APP_ID,
        'Authorization': 'Bearer ' + ACCESS_TOKEN
      }
    });

    const json = await resp.json().catch(() => ({}));
    console.log('DEBUG /v2/device/thing:', json);

    if (!resp.ok || json.error) {
      return res.status(500).json({
        ok: false,
        error: json.msg || ('Errore API: ' + resp.status),
        raw: json
      });
    }

    const thingList = (json.data && json.data.thingList) || [];

    // Prendo solo i device (itemType 1 o 2) e restituisco direttamente itemData
    const devices = thingList
      .filter(t => t.itemType === 1 || t.itemType === 2)
      .map(t => t.itemData);

    return res.json({ ok: true, devices });
  } catch (e) {
    console.error('Errore /api/devices:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'Errore interno /api/devices'
    });
  }
});

// ---------------------------------------------------------------------
//  POST /api/toggle  -> Accende/spegne un singolo SONOFF
//  body: { deviceId: "xxxx", state: "on" | "off" }
// ---------------------------------------------------------------------
app.post('/api/toggle', async (req, res) => {
  const { deviceId, state } = req.body;

  if (!APP_ID || !ACCESS_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'Configurazione server mancante (APP_ID o ACCESS_TOKEN)'
    });
  }

  if (!deviceId || !['on', 'off'].includes(state)) {
    return res.status(400).json({
      ok: false,
      error: 'Parametri non validi per toggle'
    });
  }

  const body = {
    type: 1,          // 1 = device
    id: deviceId,     // deviceid Sonoff
    params: {
      switch: state   // "on" / "off"
    }
  };

  try {
    const resp = await fetch(API_BASE + '/v2/device/thing/status', {
      method: 'POST',
      headers: {
        'X-CK-Appid': APP_ID,
        'Authorization': 'Bearer ' + ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const json = await resp.json().catch(() => ({}));
    console.log('DEBUG /v2/device/thing/status:', json);

    if (!resp.ok || json.error) {
      return res.status(500).json({
        ok: false,
        error: json.msg || ('Errore API toggle: ' + resp.status),
        raw: json
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Errore /api/toggle:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'Errore interno /api/toggle'
    });
  }
});

app.listen(PORT, () => {
  console.log('Server Sonoff backend in ascolto sulla porta ' + PORT);
});
