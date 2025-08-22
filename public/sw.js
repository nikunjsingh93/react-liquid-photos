/* Liquid Photos PWA Service Worker */
const APP_VERSION = 'v1';
const SHELL_CACHE = `lp-shell-${APP_VERSION}`;
const THUMBS_CACHE = `lp-thumbs-${APP_VERSION}`;
const API_CACHE = `lp-api-${APP_VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/offline.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, THUMBS_CACHE, API_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => keep.has(k) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}
function isThumbOrView(url) {
  return url.pathname.startsWith('/thumb/') || url.pathname.startsWith('/view/');
}
function isApi(url) {
  // Cache GET API calls lightly; POST/DELETE bypass caching
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/s/')) return false;
  // Avoid caching auth endpoints
  if (/\/auth\//.test(url.pathname)) return false;
  return true;
}
function isHls(url) {
  return url.pathname.startsWith('/hls/');
}

// Basic strategies
async function cacheFirst(req, cacheName, maxEntries = 350) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) {
    await cache.put(req, res.clone());
    trimCache(cacheName, maxEntries).catch(() => {});
  }
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hitPromise = cache.match(req);
  const fetchPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  const hit = await hitPromise;
  return hit || fetchPromise || fetch(req);
}

async function networkFirst(req, cacheName, timeoutMs = 5000) {
  const cache = await caches.open(cacheName);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(req, { signal: ctrl.signal });
    clearTimeout(t);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.length - maxEntries;
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Do not interfere with HLS/video streaming or non-HTTP
  if (!/^https?:/.test(url.protocol) || isHls(url)) return;

  // Navigation fallback
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res && res.ok) return res;
        throw new Error('Network error');
      } catch (e) {
        const cache = await caches.open(SHELL_CACHE);
        const offline = await cache.match('/offline.html');
        return offline || Response.error();
      }
    })());
    return;
  }

  // Runtime routes
  if (isThumbOrView(url)) {
    event.respondWith(cacheFirst(request, THUMBS_CACHE, 500));
    return;
  }

  if (isApi(url)) {
    event.respondWith(networkFirst(request, API_CACHE, 5000));
    return;
  }

  if (isSameOrigin(url)) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }
});

// Listen for a skipWaiting message to update SW immediately
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
