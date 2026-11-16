const CACHE = "zen-coin-shell-v9";
const shell = ["index.html", "style.css", "config.js", "game.js", "friends.js",
  "manifest.webmanifest", "cat-180.png", "cat-192.png", "cat-512.png", "cat.webp"];
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(shell.map(path => new Request(path, {cache: "reload"})));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("zen-coin-shell-") && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
  const path = new URL(request.url).pathname.slice(new URL(self.registration.scope).pathname.length);
  if (request.mode === "navigate" && ["", "index.html"].includes(path)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match("index.html")));
  } else if (shell.includes(path)) {
    event.respondWith(caches.open(CACHE).then(async cache => await cache.match(path) || fetch(request)));
  }
});
