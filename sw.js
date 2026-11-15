const APP_SHELL_CACHE = 'bitehub-app-shell-v1';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('bitehub-app-shell-') && key !== APP_SHELL_CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(APP_SHELL_CACHE);
          await cache.put('/', response.clone());
        }
        return response;
      } catch (_) {
        return (await caches.match('/'))
          || (await caches.match('/index.html'))
          || new Response('BiteHub is offline. Reconnect to the internet and try again.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
      }
    })());
    return;
  }

  if (!['script', 'style', 'image', 'font'].includes(request.destination)) return;
  event.respondWith((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    } catch (_) {
      return (await cache.match(request)) || Response.error();
    }
  })());
});

function refreshInstalledAppBadge() {
  const appNavigator = self.navigator;
  if (!appNavigator || typeof appNavigator.setAppBadge !== 'function') return Promise.resolve();

  return fetch('/api/notifications/inbox', {
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  }).then(response => response.ok ? response.json() : null).then(inbox => {
    const unread = Number(inbox?.unread_count);
    if (!Number.isFinite(unread) || unread < 0) return;
    if (unread > 0) return appNavigator.setAppBadge(Math.min(unread, 99));
    if (typeof appNavigator.clearAppBadge === 'function') return appNavigator.clearAppBadge();
  }).catch(() => {});
}

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch (_) {}

  const tag = String(message.tag || `bitehub-order-${Date.now()}`);
  const notification = self.registration.showNotification(message.title || 'BiteHub update', {
    body: message.body || 'There is an update to your campus order.',
    icon: '/assets/bitehub-icon.png',
    badge: '/assets/bitehub-icon.png',
    tag,
    renotify: true,
    silent: false,
    vibrate: [120, 60, 120],
    data: { url: message.url || '/#buyer-orders' }
  });

  event.waitUntil(Promise.all([notification, refreshInstalledAppBadge()]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/#buyer-orders', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const app = windows.find(client => client.url.startsWith(self.location.origin));
    if (app) return app.navigate(target).then(client => client.focus());
    return self.clients.openWindow(target);
  }));
});
