// server.js — Backend Sonoff / eWeLink OAuth2.0 (redirect + cookie + scenari + logout)

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");

const app = express();
app.use(express.json());
app.use(cookieParser());

// ================== CONFIG ==================

const APPID = process.env.EWELINK_APP_ID;
const APPSECRET = process.env.EWELINK_APP_SECRET;

const REDIRECT_URL =
  process.env.EWELINK_REDIRECT_URL ||
  "https://sonoff-backend-k8sh.onrender.com/oauth/callback";

const API_BASE =
  process.env.EWELINK_API_BASE || "https://eu-apia.coolkit.cc";

if (!APPID || !APPSECRET) {
  console.error("ERRORE: EWELINK_APP_ID o EWELINK_APP_SECRET non impostati!");
}

// ID del G2 "Luci esterne"
const G2_ID = "1000965dd3";

// (usato per il G2, così nel frontend lo vedi ON/OFF come ultimo comando inviato)
const virtualStates = {
  [G2_ID]: "off"
};

// ================== UTILITY FIRMA ==================

function hmacSign(message) {
  return crypto
    .createHmac("sha256", APPSECRET)
    .update(message, "utf8")
    .digest("base64");
}

// ================== CORS ==================

app.use(
  cors({
    origin: [
      "https://oratoriosluigi.altervista.org",
      "http://localhost:5500"
    ],
    credentials: true
  })
);

// ================== ROUTE BASE ==================

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Backend Sonoff OAuth attivo" });
});

// ================== /login — REDIRECT A PAGINA OAUTH ==================

app.get("/login", (req, res) => {
  const returnUrl =
    req.query.returnUrl ||
    "https://oratoriosluigi.altervista.org/sonoff.html.html";

  const state = returnUrl;
  const encodedState = encodeURIComponent(state);

  const seq = Date.now().toString();
  const nonce = "abc12345";

  const message = `${APPID}_${seq}`;
  const sign = hmacSign(message);

  const url =
    "https://c2ccdn.coolkit.cc/oauth/index.html" +
    `?state=${encodedState}` +
    `&clientId=${encodeURIComponent(APPID)}` +
    `&authorization=${encodeURIComponent(sign)}` +
    `&seq=${encodeURIComponent(seq)}` +
    `&redirectUrl=${encodeURIComponent(REDIRECT_URL)}` +
    `&nonce=${encodeURIComponent(nonce)}` +
    `&grantType=authorization_code` +
    `&showQRCode=false`;

  console.log("OAuth URL:", url);
  res.redirect(url);
});

// ================== /oauth/callback — CODE -> TOKEN + REDIRECT ==================

app.get("/oauth/callback", async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error("Errore riportato da OAuth callback:", error);
    return res.status(400).send("OAuth error from provider: " + error);
  }

  if (!code) {
    console.error("Manca il code in callback, query:", req.query);
    return res
      .status(400)
      .send("Missing 'code' in OAuth callback, query=" + JSON.stringify(req.query));
  }

  let returnUrl = "https://oratoriosluigi.altervista.org/sonoff.html.html";
  if (state) {
    try {
      returnUrl = decodeURIComponent(state);
    } catch (e) {
      console.warn("Impossibile decodificare state, uso default:", e);
    }
  }

  try {
    const bodyObj = {
      code,
      redirectUrl: REDIRECT_URL,
      grantType: "authorization_code"
    };
    const bodyStr = JSON.stringify(bodyObj);

    const sign = hmacSign(bodyStr);

    console.log("POST /v2/user/oauth/token body:", bodyObj);
    console.log("Authorization Sign:", sign);

    const resp = await fetch(`${API_BASE}/v2/user/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CK-Appid": APPID,
        Authorization: `Sign ${sign}`
      },
      body: bodyStr
    });

    const data = await resp.json();
    console.log("oauth token response:", data);

    if (data.error !== 0 || !data.data) {
      return res
        .status(400)
        .send("Errore nello scambio code/token: " + JSON.stringify(data));
    }

    res.cookie("ewelink_access", data.data.accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None"
    });
    res.cookie("ewelink_refresh", data.data.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None"
    });

    return res.redirect(returnUrl);
  } catch (e) {
    console.error("Eccezione /oauth/callback:", e);
    return res
      .status(500)
      .send("Eccezione nello scambio token: " + e.message);
  }
});

// ================== /logout — CANCELLA COOKIE ==================

app.post("/logout", (req, res) => {
  res.clearCookie("ewelink_access", {
    httpOnly: true,
    secure: true,
    sameSite: "None"
  });
  res.clearCookie("ewelink_refresh", {
    httpOnly: true,
    secure: true,
    sameSite: "None"
  });

  return res.json({ ok: true });
});

// ================== /api/devices — LISTA DISPOSITIVI (TUTTE LE FAMILY) ==================

app.get("/api/devices", async (req, res) => {
  const accessToken = req.cookies.ewelink_access;

  if (!accessToken) {
    return res.json({
      ok: false,
      error: "not_authenticated",
      msg: "Non autenticato su eWeLink. Vai prima su /login."
    });
  }

  try {
    // 1) elenco family
    const famResp = await fetch(`${API_BASE}/v2/family`, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + accessToken,
        "X-CK-Appid": APPID
      }
    });
    const famData = await famResp.json();
    console.log("family response:", JSON.stringify(famData, null, 2));

    if (famData.error !== 0 || !famData.data) {
      return res.json({
        ok: false,
        error: famData.error,
        msg: famData.msg || "Errore lettura family"
      });
    }

    const familyList = famData.data.familyList || [];
    if (!familyList.length) {
      return res.json({
        ok: true,
        devices: [],
        msg: "Nessuna family associata all'account"
      });
    }

    const allDevices = [];

    // 2) per ogni family prendo i device
    for (const fam of familyList) {
      const familyId = fam.id;

      const devResp = await fetch(
        `${API_BASE}/v2/device/thing?num=0&familyid=${encodeURIComponent(
          familyId
        )}`,
        {
          method: "GET",
          headers: {
            Authorization: "Bearer " + accessToken,
            "X-CK-Appid": APPID
          }
        }
      );

      const devData = await devResp.json();
      console.log(
        `device thing response for family ${familyId}:`,
        JSON.stringify(devData, null, 2)
      );

      if (devData.error !== 0 || !devData.data) {
        continue;
      }

      const list = devData.data.thingList || [];

      list.forEach((i) => {
        if (!i.itemData || !i.itemData.deviceid) return;

        allDevices.push({
          ...i.itemData,
          deviceType: i.itemType, // tipo interno eWeLink
          itemType: i.itemType,
          familyId
        });
      });
    }

    // === GESTIONE SPECIALE G2: se non esiste lo aggiungo, altrimenti imposto lo stato virtuale ===
let g2 = allDevices.find(d => d.deviceid === G2_ID);

if (g2) {
  // Se esiste già, forzo lo stato in base al virtualStates
  if (!g2.params) g2.params = {};
  g2.params.switch = virtualStates[G2_ID] || "off";
} else {
  // Se le API non lo restituiscono, lo aggiungo manualmente
  allDevices.push({
    deviceid: G2_ID,
    name: "Luci esterne (G2)",
    online: true, // non sappiamo lo stato reale, ma lo segniamo online
    params: { switch: virtualStates[G2_ID] || "off" },
    familyId: familyList[0]?.id || null,
    deviceType: 3,   // <<< QUI: tipo GPRS/G2
    itemType: 3      // idem
  });
}

    return res.json({ ok: true, devices: allDevices });
  } catch (e) {
    console.error("Eccezione /api/devices:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message
    });
  }
});

// ================== /api/toggle — SINGOLO CANALE (MINIR4, CANCELLO, G2) ==================
app.post("/api/toggle", async (req, res) => {
  const { deviceId, state } = req.body;
  const accessToken = req.cookies.ewelink_access;

  if (!accessToken) {
    return res.json({
      ok: false,
      error: "not_authenticated",
      msg: "Non autenticato su eWeLink. Vai prima su /login."
    });
  }

  if (!deviceId || (state !== "on" && state !== "off")) {
    return res.json({
      ok: false,
      error: "invalid_params",
      msg: "deviceId o state non validi"
    });
  }

  try {
    console.log("TOGGLE richiesto per deviceId:", deviceId, "state:", state);

    const isGate = deviceId === "1000ac81a0";  // cancello
    const isG2   = deviceId === G2_ID;         // luci esterne (G2)

    let type;
    let params;

    if (isGate) {
      // CANCELLO: group (type 2) con impulso sul CH0
      type = 2;
      params = {
        switches: [
          { outlet: 0, switch: "on" }   // impulso, gestito dal pulse del device
        ]
      };
    } else if (isG2) {
      // G2: funziona con type=1 (device normale)
      // Per ora ON/OFF globale (tutti i canali insieme)
      type = 1;
      params = {
        switch: state
      };
    } else {
      // MINIR4 del portico + altri interruttori classici
      type = 1;
      params = {
        switch: state
      };
    }

    const bodyObj = {
      type,
      id: deviceId,
      params
    };

    console.log("=== TOGGLE REQUEST SENT TO EWELINK ===");
    console.log(JSON.stringify(bodyObj, null, 2));

    const resp = await fetch(`${API_BASE}/v2/device/thing/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
        "X-CK-Appid": APPID
      },
      body: JSON.stringify(bodyObj)
    });

    const data = await resp.json();

    console.log("=== TOGGLE RESPONSE FROM EWELINK ===");
    console.log(JSON.stringify(data, null, 2));

    const ok = data.error === 0;

    return res.json({
      ok,
      sent: bodyObj,
      raw: data
    });
  } catch (e) {
    console.error("Eccezione /api/toggle:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message
    });
  }
});
  
// ================== /api/toggle-multi — SCENARI / TUTTI ON-OFF ==================

app.post("/api/toggle-multi", async (req, res) => {
  const { deviceId, outlets, state } = req.body;
  const accessToken = req.cookies.ewelink_access;

  if (!accessToken) {
    return res.json({
      ok: false,
      error: "not_authenticated",
      msg: "Non autenticato su eWeLink. Vai prima su /login."
    });
  }

  if (
    !deviceId ||
    !Array.isArray(outlets) ||
    outlets.length === 0 ||
    (state !== "on" && state !== "off")
  ) {
    return res.json({
      ok: false,
      error: "invalid_params",
      msg: "deviceId, outlets o state non validi"
    });
  }

  try {
    const switches = outlets.map((o) => ({
      outlet: o,
      switch: state
    }));

    const bodyObj = {
      type: 1, // fisso: funziona con i 4CH del portico
      id: deviceId,
      params: { switches }
    };

    console.log("=== TOGGLE-MULTI REQUEST ===");
    console.log(JSON.stringify(bodyObj, null, 2));

    const resp = await fetch(`${API_BASE}/v2/device/thing/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
        "X-CK-Appid": APPID
      },
      body: JSON.stringify(bodyObj)
    });

    const data = await resp.json();

    console.log("=== TOGGLE-MULTI RESPONSE ===");
    console.log(JSON.stringify(data, null, 2));

    if (data.error !== 0) {
      return res.json({
        ok: false,
        error: data.error,
        msg: data.msg || "Errore nel comando",
        raw: data
      });
    }

    return res.json({ ok: true, raw: data, sent: bodyObj });
  } catch (e) {
    console.error("Eccezione /api/toggle-multi:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message
    });
  }
});

// ================== AVVIO SERVER ==================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server avviato sulla porta", PORT);
});
