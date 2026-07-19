/* Swathi CA Tracker — offline service worker.
   App shell is cached so the tracker opens with no network; hashed build
   assets are cached on demand; Supabase API is never cached. */
const CACHE = 'swathi-ca-v2'
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Never cache Supabase (or any cross-origin API) — always hit the network.
  if (url.hostname.endsWith('supabase.co')) return

  // Navigations: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')))
    return
  }

  // Same-origin static assets (hashed): cache-first, then network + cache.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
          return res
        }).catch(() => hit)
      )
    )
  }
})

// Best-effort background daily reminder (Chromium installed PWAs only; browser
// controls exact timing). Foreground reminders are handled in the app itself.
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'daily-reminder') {
    e.waitUntil(self.registration.showNotification('Study time, Swathi 📚', {
      body: 'A short session today keeps your streak alive. You’ve got this.',
      icon: './icon-192.png', badge: './icon-192.png', tag: 'daily-reminder',
    }))
  }
})

// Focus/open the app when a reminder is tapped.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus() }
      if (self.clients.openWindow) return self.clients.openWindow('./')
    })
  )
})
