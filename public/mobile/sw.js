// سرویس‌ورکر نسخه موبایل — دامنه‌اش فقط /mobile/ است، پس هیچ اثری روی نسخه وب
// (public/index.html) ندارد. فقط پوسته اپ کش می‌شود؛ درخواست‌های /api/ هرگز کش نمی‌شوند.
const CACHE = 'warehouse-mobile-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', '../logo-transparent.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// نوتیفیکیشنِ واقعیِ گوشی (Web Push) - سرور با webpush.sendNotification یه پیامِ رمزنگاری‌شده
// می‌فرسته که مرورگر خودش قبل از رسیدن به اینجا بازش می‌کنه؛ اگه اپ کاملاً بسته باشه هم این
// event بیدار می‌شه (به همین خاطر نوتیفیکیشنِ واقعی‌ست، نه فقط badge داخلِ اپِ بازِ فعلی).
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || 'مدیریت تولید';
  const options = {
    body: data.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: true, // مثل سامانه داخلی: تا وقتی کاربر نبندد یا لمس نکند می‌ماند
    dir: 'rtl',
    lang: 'fa',
    data: { url: data.url || './' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // همیشه از شبکه
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
