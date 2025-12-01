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

// ID del G2
const G2_ID = "1000965dd3";

// Stato virtuale (eWeLink non restituisce lo stato reale per G2)
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

// ================== LOGIN ==================

app.get("/login", (req, res) => {
  const returnUrl =
    req.query.returnUrl ||
    "https://oratoriosluigi.altervista.org/sonoff.html.html";

  const encodedState = encodeURIComponent(returnUrl);

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

  res.redirect(url);
});

// ================== OAUTH CALLBACK ==================

app.get("/oauth/callback", async (req, res) => {
  const { code, error, state } = req.query;

  if (error) return res.status(400).send("OAuth error: " + error);
  if (!code) return res.status(400).send("Missing OAuth code");

  let returnUrl = "https://oratoriosluigi.altervista.org/sonoff.html.html";
  try {
    returnUrl = decodeURIComponent(state);
  } catch {}

  try {
    const bodyObj = {
      code,
      redirectUrl: REDIRECT_URL,
      grantType: "authorization_code"
    };

    const sign = hmacSign(JSON.stringify(bodyObj));

    const resp = await fetch(`${API_BASE}/v2/user/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CK-Appid": APPID,
        Authorization: `Sign ${sign}`
      },
      body: JSON.stringify(bodyObj)
    });

    const data = await resp.json();

    if (data.error !== 0) {
      return res.status(400).send("Errore token: " + JSON.stringify(data));
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
    return res.status(500).send("Callback error: " + e.message);
  }
});

// ================== LOGOUT ==================

app.post("/logout", (req, res) => {
  res.clearCookie("ewelink_access", { httpOnly: true, secure: true, sameSite: "None" });
  res.clearCookie("ewelink_refresh", { httpOnly: true, secure: true, sameSite: "None" });

  res.json({ ok: true });
});

// ================== DEVICES ==================

app.get("/api/devices", async (req, res) => {
  const accessToken = req.cookies.ewelink_access;
  if (!accessToken) return res.json({ ok: false, error: "not_authenticated" });

  try {
    // 1) Leggo le family
    const famResp = await fetch(`${API_BASE}/v2/family`, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + accessToken,
        "X-CK-Appid": APPID
      }
    });

    const famData = await famResp.json();

    const allDevices = [];

    if (famData.error === 0) {
      for (const fam of famData.data.familyList) {
        const devResp = await fetch(
          `${API_BASE}/v2/device/thing?num=0&familyid=${fam.id}`,
          {
            method: "GET",
            headers: {
              Authorization: "Bearer " + accessToken,
              "X-CK-Appid": APPID
            }
          }
        );

        const devData = await devResp.json();
        if (devData.error === 0) {
          (devData.data.thingList || []).forEach((i) => {
            if (i.itemData && i.itemData.deviceid) {
              allDevices.push({
                ...i.itemData,
                deviceType: i.itemType,
                itemType: i.itemType,
                familyId: fam.id
              });
            }
          });
        }
      }
    }

    // === G2 SISTEMATO ===
    let g2 = allDevices.find((d) => d.deviceid === G2_ID);

    if (g2) {
      if (!g2.params) g2.params = {};
      g2.params.switch = virtualStates[G2_ID];
      g2.deviceType = 2;
      g2.itemType = 2;
    } else {
      allDevices.push({
        deviceid: G2_ID,
        name: "Luci esterne (G2)",
        online: true,
        params: { switch: virtualStates[G2_ID] },
        deviceType: 2,
        itemType: 2
      });
    }

    res.json({ ok: true, devices: allDevices });

  } catch (err) {
    return res.json({ ok: false, error: "internal_error", msg: err.message });
  }
});

// ================== TOGGLE ==================

app.post("/api/toggle", async (req, res) => {
  const { deviceId, state } = req.body;
  const accessToken = req.cookies.ewelink_access;

  if (!accessToken)
    return res.json({ ok: false, error: "not_authenticated" });

  try {
    let type, params;

    const isGate = deviceId === "1000ac81a0";
    const isG2 = deviceId === G2_ID;

    if (isGate) {
      type = 2;
      params = { switches: [{ outlet: 0, switch: "on" }] };

    } else if (isG2) {
      type = 2;
      params = { switch: state };
      virtualStates[G2_ID] = state;

    } else {
      type = 1;
      params = { switch: state };
    }

    const bodyObj = { type, id: deviceId, params };

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

    res.json({ ok: data.error === 0, sent: bodyObj, raw: data });

  } catch (err) {
    res.json({ ok: false, error: "internal_error", msg: err.message });
  }
});

// ================== TOGGLE-MULTI ==================

app.post("/api/toggle-multi", async (req, res) => {
  const { deviceId, outlets, state } = req.body;
  const accessToken = req.cookies.ewelink_access;

  if (!accessToken)
    return res.json({ ok: false, error: "not_authenticated" });

  try {
    const switches = outlets.map((o) => ({ outlet: o, switch: state }));

    const bodyObj = {
      type: 1,
      id: deviceId,
      params: { switches }
    };

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

    res.json({ ok: data.error === 0, sent: bodyObj, raw: data });

  } catch (err) {
    res.json({ ok: false, error: "internal_error", msg: err.message });
  }
});

// ================== START ==================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server avviato sulla porta", PORT));
