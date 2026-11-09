/* Service Worker نسخهٔ اصلی (دسکتاپ) مدیریت تولید — مثل سامانه داخلی فقط برای اعلان پس‌زمینه
   (Web Push) است و هیچ کشی انجام نمی‌دهد. دامنه‌اش «/» است؛ نسخهٔ موبایل (/mobile/) سرویس‌ورکرِ
   جدای خودش را دارد و چون دامنهٔ آن دقیق‌تر است، صفحات /mobile/ همچنان زیر کنترل همان می‌مانند. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (event) {
  var d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) {
    d = { title: "مدیریت تولید", body: event.data ? event.data.text() : "" };
  }
  var opts = {
    body: d.body || "",
    icon: "/mobile/icons/icon-192.png",
    badge: "/mobile/icons/icon-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: true,      // مثل سامانه داخلی: اعلان تا وقتی کاربر نبندد یا کلیک نکند می‌ماند
    dir: "rtl",
    lang: "fa",
    data: { url: d.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(d.title || "مدیریت تولید", opts));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        var p = new URL(c.url).pathname;
        // پنجرهٔ باز نسخهٔ اصلی را جلو بیاور (نه پنجرهٔ نسخهٔ موبایل)
        if (c.url.indexOf(self.location.origin) === 0 && p.indexOf("/mobile/") !== 0 && "focus" in c) {
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
