// PIF Service Worker — Stage N3d.1 (push click routing activated)
// N3a left push as no-op. N3b activates real notification display.
// N3d.1 adds type-aware notification click routing.

const SW_VERSION = 'pif-n3d-v1';

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
// Push payload shape:
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

// --- Notification click: N3d.1 — type-aware routing ---
// Two paths converge in the client:
//   (a) PIF tab open  → focus + postMessage with routing data
//   (b) PIF tab closed → openWindow with pif_* URL params; client reads on load
// Either path ends up calling pifRouteFromNotification(data) in index.html.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var data = event.notification.data || {};

  // Build URL params for the closed-app fallback path
  function buildUrlWithParams(baseUrl) {
    try {
      var url = new URL(baseUrl);
      if (data.notification_id) url.searchParams.set('pif_notif_id', String(data.notification_id));
      if (data.type) url.searchParams.set('pif_type', String(data.type));
      if (data.target_type) url.searchParams.set('pif_target_type', String(data.target_type));
      if (data.target_id) url.searchParams.set('pif_target_id', String(data.target_id));
      if (data.actor_handle) url.searchParams.set('pif_actor', String(data.actor_handle));
      return url.href;
    } catch (e) {
      return baseUrl;
    }
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Path (a): existing PIF tab → focus + postMessage routing intent
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if (c.url.indexOf(self.location.host) !== -1) {
          var focusPromise = c.focus();

          try {
            c.postMessage({ type: 'pif-notif-click', data: data });
          } catch (e) {
            // postMessage should not fail, but never let SW crash on it
          }

          return focusPromise;
        }
      }

      // Path (b): no open tab → open new window with routing params
      var scopeUrl = self.registration && self.registration.scope ? self.registration.scope : '/';
      var targetUrl = buildUrlWithParams(scopeUrl);
      return clients.openWindow(targetUrl);
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
