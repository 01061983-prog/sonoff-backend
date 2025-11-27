const express = require('express');
const cors = require('cors');
const ewelink = require('ewelink-api');

const app = express();

// Leggo le variabili d'ambiente per l'app developer
const APP_ID = process.env.EWELINK_APPID;
const APP_SECRET = process.env.EWELINK_APPSECRET;

// Domini frontend permessi (aggiungi/varia se necessario)
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

// Connessione globale (dopo login)
let conn = null;

// Funzione di utilità per estrarre i dispositivi
function estraiDispositivi(devicesResp) {
  // Caso 1: direttamente un array
  if (Array.isArray(devicesResp)) return devicesResp;

  // Caso 2: { data: [...] }
  if (devicesResp && Array.isArray(devicesResp.data)) {
    return devicesResp.data;
  }

  // Caso 3: { devicelist: [...] }
  if (devicesResp && Array.isArray(devicesResp.devicelist)) {
    return devicesResp.devicelist;
  }

  // Caso 4: nuovo formato "thingList"
  if (
    devicesResp &&
    devicesResp.data &&
    Array.isArray(devicesResp.data.thingList)
  ) {
    return devicesResp.data.thingList.map(t => t.itemData || t);
  }

  // Nessun formato riconosciuto
  return [];
}

// LOGIN + GET DEVICES
app.post('/api/login', async (req, res) => {
  const { email, password, region } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email o password mancanti' });
  }

  if (!APP_ID || !APP_SECRET) {
    console.error('APP_ID o APP_SECRET mancanti nelle variabili di ambiente');
    return res.status(500).json({ ok: false, error: 'Configurazione server mancante (APP_ID/APP_SECRET)' });
  }

  try {
    // Connessione diretta con email/password/region + APPID/APPSECRET
    conn = new ewelink({
      email,
      password,
      region: region || process.env.EWELINK_REGION || 'eu',
      appId: APP_ID,
      appSecret: APP_SECRET
    });

    const credentials = await conn.getCredentials();
    console.log('DEBUG credentials:', credentials);

    const devicesResp = await conn.getDevices();
    console.log('DEBUG devicesResp:', devicesResp);

    if (!devicesResp) {
      return res.status(500).json({ ok: false, error: 'Risposta vuota da getDevices' });
    }

    // Se la libreria usa formato { error, msg, data }
    if (typeof devicesResp.error !== 'undefined' && devicesResp.error !== 0) {
      console.error('Errore getDevices:', devicesResp);
      return res.status(500).json({
        ok: false,
        error: devicesResp.msg || ('Errore getDevices: ' + devicesResp.error)
      });
    }

    const devices = estraiDispositivi(devicesResp);

    if (!devices || devices.length === 0) {
      console.warn('Nessun dispositivo estratto, devicesResp formato sconosciuto');
      return res.json({
        ok: true,
        devices: [],
        raw: devicesResp   // per debug eventuale
      });
    }

    return res.json({ ok: true, devices });

  } catch (e) {
    console.error('Errore login/getDevices:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Errore interno' });
  }
});

// TOGGLE ON/OFF
app.post('/api/toggle', async (req, res) => {
  const { deviceId, state } = req.body;

  if (!conn) {
    return res.status(401).json({ ok: false, error: 'Non sei loggato (connessione mancante)' });
  }
  if (!deviceId || !['on', 'off'].includes(state)) {
    return res.status(400).json({ ok: false, error: 'Parametri non validi per toggle' });
  }

  try {
    const resp = await conn.setDevicePowerState(deviceId, state);
    console.log('DEBUG toggleResp:', resp);

    if (resp && typeof resp.error !== 'undefined' && resp.error !== 0) {
      return res.status(500).json({
        ok: false,
        error: resp.msg || ('Errore setDevicePowerState: ' + resp.error)
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Errore toggle:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Errore interno toggle' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server eWeLink attivo sulla porta ' + PORT));
