const CACHE_NAME = 'sales-analysis-cn-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './favicon.png',
  './assets/vendor/xlsx.full.min.js',
  './assets/vendor/chart.umd.js',
  './assets/vendor/chartjs-plugin-datalabels.min.js',
  './assets/vendor/exceljs.min.js',
  './assets/vendor/three.r128.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request))
  );
});
