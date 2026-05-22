// PIF Service Worker — Stage N3a foundation
// Purpose: register cleanly, prepare for push events in N3b/c, do no work in N3a.
// Reversibility: deleting this file + unregistering the SW removes all effects.

const SW_VERSION = 'pif-n3a-v1';

// --- Install: take over immediately on first install ---
self.addEventListener('install', function(event) {
  // No precaching in N3a. Future versions may add a cache.
  self.skipWaiting();
});

// --- Activate: claim all open tabs so the SW controls them right away ---
self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

// --- Fetch: NOT intercepted.
// N3a deliberately does NOT register a fetch listener.
// A buggy fetch handler can break the entire site silently. Caching is not in scope.

// --- Push: no-op placeholder for N3a.
// N3b ships the real notification display handler.
self.addEventListener('push', function(event) {
  // Intentionally empty. No subscriptions exist in N3a, so this should never fire.
});

// --- Notification click: no-op placeholder for N3a.
// N3d ships the real click → focus → postMessage routing.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
});

// --- Message: minimal channel so pages can verify SW version ---
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'GET_VERSION') {
    if (event.source && event.source.postMessage) {
      event.source.postMessage({ type: 'VERSION', version: SW_VERSION });
    }
  }
});
