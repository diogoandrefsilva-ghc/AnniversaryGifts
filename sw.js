/* SOBE ISTO sempre que mexeres em app.js, style.css ou index.html.
   Os três são network-first de propósito: sem isto, um deploy dá ao
   browser o index.html novo com o app.js velho da cache — botões novos a
   chamar funções que ainda não existem, sem erro visível. Já aconteceu nas
   apps irmãs. */
const CACHE_NAME = 'pg-cache-v23';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) =>
        Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))));
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.hostname !== self.location.hostname) return;
    if (url.pathname.endsWith('.html') || url.pathname.endsWith('/')
        || url.pathname.endsWith('/app.js') || url.pathname.endsWith('/style.css')) {
        e.respondWith(
            fetch(e.request.url, { cache: 'no-store' })
                .then((res) => {
                    if (res && res.status === 200) {
                        const c = res.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, c));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }
    // Cache-first para o resto (ícones, manifest)
    e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
        if (res && res.status === 200) {
            const c = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, c));
        }
        return res;
    })));
});

// Notificações: a Edge Function prendas-notificar manda {title, body, url}.
self.addEventListener('push', (e) => {
    let data = { title: 'Prendas de Anos', body: 'Há novidades na app.', url: '/AnniversaryGifts/' };
    try { Object.assign(data, e.data.json()); } catch (err) { /* payload vazio */ }
    e.waitUntil(self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/AnniversaryGifts/apple-touch-icon.png',
        badge: '/AnniversaryGifts/apple-touch-icon.png',
        data: { url: data.url || '/AnniversaryGifts/' }
    }));
});
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const url = (e.notification.data && e.notification.data.url) || '/AnniversaryGifts/';
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
        for (const c of cs) if (c.url.includes('/AnniversaryGifts/') && 'focus' in c) return c.focus();
        return self.clients.openWindow(url);
    }));
});
