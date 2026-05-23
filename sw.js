// PIF Service Worker — Stage N3b (push handler activated)
// N3a left push as no-op. N3b activates real notification display.
// N3d will add full click routing. Click currently focuses/opens PIF.

const SW_VERSION = 'pif-n3b-v1';

// --- Install: take over immediately on first install ---
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

// --- Activate: claim all open tabs so the SW controls them right away ---
self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

// --- Fetch: NOT intercepted. Pure pass-through. ---
// Important: no fetch listener, no caching, no page interception.

// --- Push: display notification.
// N3c will later send pushes with JSON payload:
// { title, body, icon?, badge?, data? }
self.addEventListener('push', function(event) {
  var payload = {
    title: 'Pass It Forward',
    body: 'You have a new update.'
  };

  try {
    if (event.data) {
      var parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = parsed;
      }
    }
  } catch (e) {
    try {
      payload.body = event.data ? event.data.text() : payload.body;
    } catch (e2) {}
  }

  var scopeUrl = self.registration && self.registration.scope ? self.registration.scope : self.location.origin + '/';
  var iconUrl = payload.icon || new URL('icon-192.png', scopeUrl).href;
  var badgeUrl = payload.badge || new URL('icon-192.png', scopeUrl).href;

  var title = payload.title || 'Pass It Forward';

  var options = {
    body: payload.body || '',
    icon: iconUrl,
    badge: badgeUrl,
    data: payload.data || {},
    tag: payload.data && payload.data.notification_id ? String(payload.data.notification_id) : undefined
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// --- Notification click: minimal N3b behaviour.
// N3d will add type-aware routing later.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if (c.url.indexOf(self.location.host) !== -1) {
          return c.focus();
        }
      }

      var scopeUrl = self.registration && self.registration.scope ? self.registration.scope : '/';
      return clients.openWindow(scopeUrl);
    })
  );
});

// --- Message: lets the page verify SW version ---
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'GET_VERSION') {
    var response = { type: 'VERSION', version: SW_VERSION };

    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(response);
      return;
    }

    if (event.source && event.source.postMessage) {
      event.source.postMessage(response);
    }
  }
});
