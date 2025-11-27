const express = require('express');
const cors = require('cors');
const eWeLink = require('ewelink-api-next').default;

const app = express();

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

// Leggo le variabili d'ambiente per l'app developer
// Supporta sia EWELINK_APP_ID che EWELINK_APPID, e sia EWELINK_APP_SECRET che EWELINK_APPSECRET
const APP_ID = process.env.EWELINK_APP_ID || process.env.EWELINK_APPID;
const APP_SECRET = process.env.EWELINK_APP_SECRET || process.env.EWELINK_APPSECRET;
const REGION = process.env.EWELINK_REGION || 'eu';

// Controllo di base
if (!APP_ID || !APP_SECRET) {
  console.warn('ATTENZIONE: APP_ID o APP_SECRET non trovati nelle variabili di ambiente');
}

// Client globale verso eWeLink v2
const client = new eWeLink.WebAPI({
  appId: APP_ID,
  appSecret: APP_SECRET,
  region: REGION,
  logObj: eWeLink.createLogger(REGION) // oppure console
});

// LOGIN + GET DEVICES
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email o password mancanti' });
  }

  if (!APP_ID || !APP_SECRET) {
    return res.status(500).json({ ok: false, error: 'Configurazione APP_ID/APP_SECRET mancante sul server' });
  }

  try {
    // 1) Login con account e prefisso Italia (+39)
    const loginResp = await client.user.login({
      account: email,
      password,
      areaCode: '+39'
    });

    console.log('DEBUG loginResp:', JSON.stringify(loginResp));

    if (!loginResp || loginResp.error !== 0) {
      return res.status(401).json({
        ok: false,
        error: (loginResp && loginResp.msg) ? loginResp.msg : 'Errore login',
        raw: loginResp
      });
    }

    // 2) Lista dispositivi (thingList)
    const devicesResp = await client.device.getThingList({});
    console.log('DEBUG devicesResp:', JSON.stringify(devicesResp));

    if (!devicesResp || devicesResp.error !== 0) {
      return res.status(500).json({
        ok: false,
        error: (devicesResp && devicesResp.msg) ? devicesResp.msg : 'Errore getThingList',
        raw: devicesResp
      });
    }

    const things = (devicesResp.data && Array.isArray(devicesResp.data.thingList))
      ? devicesResp.data.thingList
      : [];

    // Adattiamo al formato che il tuo frontend si aspetta:
    // name, deviceid, online, params.switch
    const devices = things.map(t => {
      const device = t.itemData || t; // dipende dal formato
      const params = device.params || device.itemParams || {};
      const online = device.online || device.onlineStatus === 1;

      return {
        name: device.name || 'Senza nome',
        deviceid: device.deviceid || device.id,
        online,
        params
      };
    });

    return res.json({ ok: true, devices });

  } catch (e) {
    console.error('Errore login/getDevices:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'Errore interno'
    });
  }
});

// TOGGLE ON/OFF
app.post('/api/toggle', async (req, res) => {
  const { deviceId, state } = req.body;

  if (!deviceId || !['on', 'off'].includes(state)) {
    return res.status(400).json({ ok: false, error: 'Parametri non validi per toggle' });
  }

  try {
    const resp = await client.device.setThingStatus({
      type: 1,           // dispositivo singolo
      id: deviceId,
      params: {
        switch: state    // "on" oppure "off"
      }
    });

    console.log('DEBUG toggleResp:', JSON.stringify(resp));

    if (!resp || resp.error !== 0) {
      return res.status(500).json({
        ok: false,
        error: (resp && resp.msg) ? resp.msg : 'Errore setThingStatus',
        raw: resp
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Errore toggle:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'Errore interno toggle'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server eWeLink v2 attivo sulla porta ' + PORT));
