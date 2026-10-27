// Solo interfaccia statica. Le API, il login e i comandi non entrano nella cache.
const CACHE_PREFIX = "san-luigi-plancia-";
const CACHE_NAME = CACHE_PREFIX + "2026-10-27-scenes-v3";
const ROOT = new URL("./", self.location.href);
const ASSETS = ["index.html", "app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable.png", "icons/apple-touch-icon.png"].map(path => new URL(path, ROOT).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== ROOT.origin) return;
  const assetUrl = url.origin + url.pathname;
  const isHome = request.mode === "navigate" && [new URL("index.html", ROOT).pathname, ROOT.pathname, new URL("sonoff.html.html", ROOT).pathname].includes(url.pathname);
  if (!isHome && !ASSETS.includes(assetUrl)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const key = isHome ? new URL("index.html", ROOT).href : assetUrl;
    try {
      const response = await fetch(request, {cache:"no-cache"});
      if (response.ok && response.type !== "opaque" && !response.redirected) {
        await cache.put(key, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
