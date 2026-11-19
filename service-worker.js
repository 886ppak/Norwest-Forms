const CACHE_NAME = 'norwest-timesheet-v169';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'
];

// Cache the whole app shell (including the PDF library) the first time it's opened online,
// so the app keeps working with no signal after that. Each request is forced to bypass the
// browser's own HTTP cache (cache.addAll alone can silently reuse a stale disk-cached copy
// of index.html, since GitHub Pages serves everything with a 10-minute max-age) — otherwise
// a "new" service worker version can still end up caching old content.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(APP_SHELL.map(url =>
        // one file that fails (e.g. a CDN hiccup) must not stop the whole update
        fetch(url, {cache:'reload'}).then(response => {
          if (response && response.status === 200) return cache.put(url, response);
        }).catch(() => {})
      )))
      .then(() => self.skipWaiting())
  );
});

// Clear out any old cache versions when a new service worker takes over.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first: serve from cache instantly if we have it, otherwise fetch from the
// network and store a copy for next time. Falls back to the cached app shell if
// totally offline and the request isn't cached yet.
// The private admin dashboard (admin.html) is never cached: the page itself and
// everything it loads (Firebase SDK, live Firestore, job numbers) go straight to
// the network, so it can't be served stale. Workers' phones never open it.
const isAdminUrl = url => new URL(url).pathname.endsWith('/admin.html');
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Job-share server calls (Cloud Functions) always go to the network and are never cached.
  if (event.request.url.includes('cloudfunctions.net')) return;
  // the app's own 'is there a newer version?' check: always the network, never cached
  if (new URL(event.request.url).searchParams.has('nv')) return;
  if (isAdminUrl(event.request.url)) return;
  event.respondWith((async () => {
    const client = event.clientId && await self.clients.get(event.clientId);
    if (client && isAdminUrl(client.url)) return fetch(event.request);
    return appResponse(event);
  })());
});

function appResponse(event) {
  // A share into the app arrives as ./index.html?title=...&text=... Those URLs
  // carry the shared email text, so they are never cached: serve the app shell.
  if (event.request.mode === 'navigate' && new URL(event.request.url).search) {
    // Job alerts open ./?offer=ID or ./?offers=1: fetch the current page (fall back to the saved copy).
    const sp = new URL(event.request.url).searchParams;
    if (sp.has('offer') || sp.has('offers')) {
      return fetch(event.request).then(r => (r && r.status === 200) ? r : caches.match('./index.html')).catch(() => caches.match('./index.html'));
    }
    return caches.match('./index.html').then(cached => cached || fetch(event.request));
  }
  // Opening the app: try the network first, so a new release is picked up on the next
  // open without waiting for the service worker file to change. Offline: the cached copy.
  if (event.request.mode === 'navigate') {
    return fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('./index.html', clone));
        }
        return response;
      })
      .catch(() => caches.match('./index.html'));
  }
  return (
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
}

// Job-share alerts (Web Push). The server sends a short message with the offer id.
// Accept on the notification records the acceptance; the app adds the job to the calendar next time it opens.
const NCH_API_SW = 'https://australia-southeast1-norwest-forms.cloudfunctions.net';
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'Job numbers offered to you';
  const options = {
    body: data.body || 'Tap to see and accept the job numbers.',
    tag: 'job-offers-' + (data.offerId || 'x'),
    renotify: false,
    icon: 'icons/icon-192.png',
    requireInteraction: true,
    // A suggested job ('Is this you?') needs a visual check in the app, so no Accept button on the alert.
    actions: data.kind === 'suggest' ? [] : [{ action: 'accept', title: 'Accept' }],
    data: { url: data.url || './?offers=1', offerId: data.offerId || '', installId: data.installId || '', kind: data.kind || 'match', title, body: options_body(data) }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
function options_body(data){ return data.body || "Tap to see and accept the job numbers."; }
// After a tap on the alert body the platform removes it. If the job is still waiting, show it again.
function swShowAgainIfPending(d){
  return fetch(NCH_API_SW + '/nchOffersGet?installId=' + encodeURIComponent(d.installId))
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if(!j || !(j.offers || []).some(o => o.id === d.offerId)) return;
      return self.registration.showNotification(d.title || 'Job numbers offered to you', {
        body: d.body || 'Tap to see and accept the job numbers.', tag: 'job-offers-' + d.offerId,
        icon: 'icons/icon-192.png', requireInteraction: true,
        actions: d.kind === 'suggest' ? [] : [{ action: 'accept', title: 'Accept' }],
        data: d
      });
    })
    .catch(() => {});
}
function swSay(title, body){
  return self.registration.showNotification(title, { body, tag: 'job-offers-result', icon: 'icons/icon-192.png', data: { url: './?offers=1' } });
}
self.addEventListener('notificationclick', event => {
  const d = event.notification.data || {};
  event.notification.close();
  if (event.action === 'accept' && d.offerId && d.installId && d.kind !== 'suggest') {
    // Record the acceptance without opening the app. The app adds the job to the calendar when it next opens.
    event.waitUntil(
      fetch(NCH_API_SW + '/nchOfferAnswer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: d.installId, offerId: d.offerId, action: 'accept' })
      }).then(r => {
        if (r.ok) return undefined;   // accepted: no second notification; the job goes on the calendar when the app next opens
        if (r.status === 410) return swSay('Too late', 'That job is past its submission cut-off.');
        return swSay('Not accepted', 'Something went wrong. Open Norwest Forms and try again.');
      }).catch(() => swSay('Not accepted', 'No connection. Open Norwest Forms and try again.'))
    );
    return;
  }
  const path = d.offerId ? './?offer=' + encodeURIComponent(d.offerId) : (d.url || './');
  const target = new URL(path, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          c.postMessage(d.offerId ? { type: 'open-offer', id: d.offerId } : { type: 'open-offers' });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }).then(() => (d.offerId && d.installId) ? swShowAgainIfPending(d) : undefined)
  );
});
