// Solo interfaccia statica. Le API, il login e i comandi non entrano nella cache.
const CACHE_PREFIX = "san-luigi-plancia-";
const CACHE_NAME = CACHE_PREFIX + "2026-11-14-customer-header-v67";
const ROOT = new URL("./", self.location.href);
const ASSETS = ["index.html", "app.css", "text-size.js", "scene-pages.js", "room-map.js", "room-map.css", "account-auth.js", "account-auth.css", "menu-bar.js", "menu-bar.css", "push-settings.js", "climate.js", "climate.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable.png", "icons/apple-touch-icon.png"].map(path => new URL(path, ROOT).href);

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

// Notifiche push: avvisi sulle programmazioni eseguite.
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "PACE", {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: new URL("icons/icon-192.png", ROOT).href,
    badge: new URL("icons/icon-192.png", ROOT).href,
    data: { url: new URL(data.url || "index.html", ROOT).href }
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || ROOT.href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => client.url.startsWith(ROOT.href));
    if (open) return open.focus();
    return self.clients.openWindow(target);
  })());
});
