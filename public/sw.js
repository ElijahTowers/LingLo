const CACHE_NAME = 'linglo-v1';
const ASSETS = [
    '/',
    '/style.css',
    '/reader.js',
    '/favicon.svg'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (e) => {
    // Try network first, fall back to cache for offline capabilities
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});
