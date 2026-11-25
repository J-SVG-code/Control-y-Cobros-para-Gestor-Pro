const CACHE_COBROS = "gestorpro-cobros-v1";
const ARCHIVOS_COBROS = [
  "./admin-cobros.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "./icono-192.png",
  "./icono-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_COBROS).then((cache) => cache.addAll(ARCHIVOS_COBROS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_COBROS).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
