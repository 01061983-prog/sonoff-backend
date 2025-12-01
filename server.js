// server.js — Backend Sonoff / eWeLink OAuth2.0 (redirect + cookie + scenari + logout)

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");

// fetch compatibile anche con Node < 18
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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

// ================== /api/devices — LISTA DISPOSITIVI ==================

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
    const famResp = await fetch(`${API_BASE}/v2/family`, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + accessToken,
        "X-CK-Appid": APPID
      }
    });
    const famData = await famResp.json();
    console.log("family response:", famData);

    if (famData.error !== 0 || !famData.data) {
      return res.json({
        ok: false,
        error: famData.error,
        msg: famData.msg || "Errore lettura family"
      });
    }

    const list = famData.data.familyList || [];
    if (!list.length) {
      return res.json({
        ok: true,
        devices: [],
        msg: "Nessuna family associata all'account"
      });
    }

    const familyId = list[0].id;

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
    console.log("device thing response:", devData);

    if (devData.error !== 0 || !devData.data) {
      return res.json({
        ok: false,
        error: devData.error,
        msg: devData.msg || "Errore lettura dispositivi"
      });
    }

    const devices =
      (devData.data.thingList || [])
        .filter((i) => i.itemType === 1 || i.itemType === 2)
        .map((i) => i.itemData) || [];

    return res.json({ ok: true, devices });
  } catch (e) {
    console.error("Eccezione /api/devices:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message
    });
  }
});

// ================== /api/toggle — ON/OFF 1 CANALE ==================

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
    // SPEC UFFICIALE: type + id + params nel BODY
    const bodyObj = {
      type: 1, // 1 = device
      id: deviceId,
      params: { switch: state }
    };
    const bodyStr = JSON.stringify(bodyObj);

    console.log("toggle request body:", bodyObj);

    const resp = await fetch(`${API_BASE}/v2/device/thing/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
        "X-CK-Appid": APPID
      },
      body: bodyStr
    });

    const data = await resp.json();
    console.log("toggle response:", data);

    if (data.error !== 0) {
      return res.json({
        ok: false,
        error: data.error,
        msg: data.msg || "Errore nel comando",
        raw: data
      });
    }

    return res.json({ ok: true, result: data });
  } catch (e) {
    console.error("Eccezione /api/toggle:", e);
    return res.json({
      ok: false,
      error: "internal_error",
      msg: e.message
    });
  }
});

// ================== /api/toggle-multi — SCENARI MULTI-CANALE ==================

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

  const switches = outlets.map((o) => ({
    outlet: o,
    switch: state
  }));

  try {
    // SPEC UFFICIALE anche per multi-canale:
    // type + id + params.switches nel BODY
    const bodyObj = {
      type: 1, // 1 = device (non gruppo)
      id: deviceId,
      params: { switches }
    };
    const bodyStr = JSON.stringify(bodyObj);

    console.log("toggle-multi request body:", bodyObj);

    const resp = await fetch(`${API_BASE}/v2/device/thing/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
        "X-CK-Appid": APPID
      },
      body: bodyStr
    });

    const data = await resp.json();
    console.log("toggle-multi response:", data);

    if (data.error !== 0) {
      return res.json({
        ok: false,
        error: data.error,
        msg: data.msg || "Errore nel comando",
        raw: data
      });
    }

    return res.json({ ok: true, result: data });
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
