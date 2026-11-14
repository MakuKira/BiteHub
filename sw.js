self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
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
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const app = windows.find(client => client.url.startsWith(self.location.origin));
    if (app) return app.navigate(target).then(client => client.focus());
    return clients.openWindow(target);
  }));
});
