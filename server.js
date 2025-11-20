const express = require('express');
const cors = require('cors');
const ewelink = require('ewelink-api');

const app = express();

// DOMINI PERMESSI (metti il tuo dominio di Altervista)
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

// Connessione globale
let conn = null;

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password, region } = req.body;

  try {
    conn = new ewelink({ email, password, region });
    await conn.getCredentials();
    const devices = await conn.getDevices();

    res.json({ ok: true, devices });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ACCENSIONE / SPEGNIMENTO
app.post('/api/toggle', async (req, res) => {
  const { deviceId, state } = req.body;

  if (!conn) return res.status(400).json({ ok: false, error: 'Non loggato' });

  try {
    await conn.setDevicePowerState(deviceId, state);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server attivo su porta ' + PORT));
