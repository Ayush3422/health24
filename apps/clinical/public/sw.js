/* global self, caches, Response */
/*
 * Health24 service worker: the application shell only.
 *
 * A reload during an outage then shows the app and its offline notice rather
 * than the browser's error page. It never handles /api or /health: clinical
 * data is held only in the session's encrypted cache, which a service worker
 * cannot read and must never duplicate in the clear.
 */

const SHELL_CACHE = 'health24-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add('/'))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

const remember = (request, response) => {
  if (!response.ok) return;
  const copy = response.clone();
  void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  // Every route of the single-page app is the same document: network first,
  // the last copy when the network fails.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          remember('/', response);
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Built assets carry a content hash, so a cached copy is never stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            remember(request, response);
            return response;
          }),
      ),
    );
  }
});
