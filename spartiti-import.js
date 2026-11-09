// spartiti-import.js — scarica una pagina web per l'app "Spartiti & Accordi"
// (oratoriosluigi.altervista.org/spartiti). Altervista gratuito non può fare
// richieste verso l'esterno, quindi il download passa da qui.
// GET /api/spartiti/fetch?url=https://...  ->  { ok, url, html }
const dns = require("dns").promises;
const net = require("net");

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Limite semplice: 30 richieste al minuto per IP
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 30;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Link non valido."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Sono ammessi solo link http/https.");
  if (url.username || url.password) throw new Error("Link non valido.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Indirizzo non consentito.");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Indirizzo non consentito.");
  return url;
}

function decode(buffer, contentType) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType || "");
  const head = buffer.subarray(0, 4096).toString("latin1");
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  let charset = (fromHeader?.[1] || fromMeta?.[1] || "utf-8").toLowerCase();
  if (charset === "iso-8859-1" || charset === "latin1") charset = "windows-1252";
  try { return new TextDecoder(charset).decode(buffer); } catch { return new TextDecoder("utf-8").decode(buffer); }
}

async function download(raw) {
  let url = await assertPublicUrl(raw);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "it-IT,it;q=0.9,en;q=0.8" },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === "AbortError" ? "Il sito non ha risposto in tempo." : "Impossibile raggiungere il sito.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      url = await assertPublicUrl(new URL(res.headers.get("location"), url).href);
      continue;
    }
    if (!res.ok) { clearTimeout(timer); throw new Error(`Il sito ha risposto con errore ${res.status}.`); }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_BYTES) break;
        chunks.push(chunk);
      }
    } finally { clearTimeout(timer); }
    return { url: url.href, html: decode(Buffer.concat(chunks), res.headers.get("content-type")) };
  }
  throw new Error("Troppi reindirizzamenti.");
}

module.exports = function mountSpartitiImport(app) {
  app.get("/api/spartiti/fetch", async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ ok: false, error: "Troppe richieste, riprova tra un minuto." });
    const target = String(req.query.url || "").trim();
    if (!target) return res.status(400).json({ ok: false, error: "Manca il link." });
    try {
      const page = await download(target);
      res.json({ ok: true, ...page });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || "Errore durante il download." });
    }
  });
};
