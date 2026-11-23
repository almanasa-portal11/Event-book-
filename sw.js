/* ورّاق — Service Worker
 * يخزّن ملفات الموقع والمكتبات بعد أول تحميل ليعمل بدون إنترنت.
 * عند تعديل الموقع ورفع نسخة جديدة، غيّر رقم VERSION ليتحدّث عند المستخدمين.
 */
var VERSION = 'waraq-v4';

var CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION)
      .then(function (cache) {
        // نخزّن كل ملف على حدة حتى لا يفشل التثبيت كله بسبب ملف واحد
        return Promise.all(CORE.map(function (url) {
          return cache.add(url).catch(function () {});
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== VERSION) return caches.delete(k);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isCacheable(res) {
  return res && (res.status === 200 || res.type === 'opaque');
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;

  var url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  var sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // ملفات الموقع: نعرض المخزّن فورًا ونحدّثه في الخلفية
    event.respondWith(
      caches.open(VERSION).then(function (cache) {
        return cache.match(req, { ignoreSearch: true }).then(function (cached) {
          var network = fetch(req)
            .then(function (res) {
              if (isCacheable(res)) cache.put(req, res.clone());
              return res;
            })
            .catch(function () {
              if (cached) return cached;
              if (req.mode === 'navigate') return cache.match('index.html');
              return Response.error();
            });
          return cached || network;
        });
      })
    );
    return;
  }

  // المكتبات والخطوط من CDN: نستخدم المخزّن أولًا (روابطها مثبّتة بالإصدار)
  var host = url.hostname;
  var allowed = host === 'cdn.jsdelivr.net' ||
    host === 'fonts.googleapis.com' ||
    host === 'fonts.gstatic.com';
  if (!allowed) return;

  event.respondWith(
    caches.open(VERSION).then(function (cache) {
      return cache.match(req).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (isCacheable(res)) cache.put(req, res.clone());
          return res;
        });
      });
    })
  );
});
