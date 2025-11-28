// server.js – Backend Sonoff per OAuth2.0 (eWeLink)

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const APPID = process.env.EWELINK_APP_ID;
const APPSECRET = process.env.EWELINK_APP_SECRET;

const REDIRECT_URI = "https://sonoff-backend-k8sh.onrender.com/oauth/callback";
const API_BASE = "https://eu-apia.coolkit.cc"; // Regione EU

let oauth = {
    access_token: null,
    refresh_token: null,
    at_expires: null
};

// CORS (front-end Altervista)
app.use(cors({
    origin: [
        "https://oratoriosluigi.altervista.org",
        "http://localhost:5500"
    ],
    credentials: true
}));

// 1) LOGIN OAUTH2 – reindirizza alla pagina di autorizzazione eWeLink
app.get("/oauth/login", (req, res) => {
    const url =
        `https://oauth.coolkit.cc/authorize` +
        `?client_id=${APPID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&state=oratorio`;

    res.redirect(url);
});

// 2) CALLBACK – scambio “code” → accessToken
app.get("/oauth/callback", async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send("Manca il code!");
    }

    const tokenUrl = `${API_BASE}/v2/user/oauth/token`;

    const body = JSON.stringify({
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI
    });

    const sign = crypto
        .createHmac("sha256", APPSECRET)
        .update(body)
        .digest("base64");

    const resp = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Sign " + sign,
            "X-CK-Appid": APPID
        },
        body
    });

    const data = await resp.json();

    if (data.error !== 0) {
        return res.status(500).send("Login fallito: " + data.msg);
    }

    oauth.access_token = data.data.access_token;
    oauth.refresh_token = data.data.refresh_token;
    oauth.at_expires = Date.now() + data.data.expires_in * 1000;

    // Ritorno al frontend
    res.redirect("https://oratoriosluigi.altervista.org/sonoff.html");
});

// 3) LISTA DISPOSITIVI
app.get("/api/devices", async (req, res) => {
    if (!oauth.access_token) {
        return res.status(401).json({ ok: false, error: "Non autenticato" });
    }

    const url = `${API_BASE}/v2/device/thing?num=0`;

    const resp = await fetch(url, {
        headers: {
            "Authorization": "Bearer " + oauth.access_token,
            "X-CK-Appid": APPID
        }
    });

    const data = await resp.json();

    if (data.error !== 0) {
        return res.status(500).json({ ok: false, error: data.msg });
    }

    const devices = (data.data.thingList || [])
        .map(i => i.itemData);

    res.json({ ok: true, devices });
});

// 4) TOGGLE – accendi/spegni
app.post("/api/toggle", async (req, res) => {
    const { deviceId, state } = req.body;

    if (!oauth.access_token) {
        return res.status(401).json({ ok: false, error: "Non autenticato" });
    }

    const url = `${API_BASE}/v2/device/thing/status`;

    const body = JSON.stringify({
        type: 1,
        id: deviceId,
        params: { switch: state }
    });

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + oauth.access_token,
            "X-CK-Appid": APPID
        },
        body
    });

    const data = await resp.json();

    if (data.error !== 0) {
        return res.status(500).json({ ok: false, error: data.msg });
    }

    res.json({ ok: true });
});

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server OAuth attivo su porta " + PORT));
