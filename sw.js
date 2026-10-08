self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(self.registration.showNotification(message.title || 'BiteHub update', {
    body: message.body || 'There is an update to your campus order.',
    icon: '/bitehub-mark.svg',
    badge: '/bitehub-mark.svg',
    tag: message.tag || `bitehub-order-${Date.now()}`,
    data: { url: message.url || '/#buyer-orders' }
  }));
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
