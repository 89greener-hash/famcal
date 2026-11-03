// 앱 껍데기만 캐시한다. 일정·메모 데이터(Firebase)는 건드리지 않는다.
const CACHE = 'famcal-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

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

// 같은 주소의 파일은 인터넷이 되면 최신본, 안 되면 캐시본
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

// 나만 보기 일정의 제목은 이 폰에만 있는 키로 풀어서 보여 준다
const kvGet = k => new Promise((res, rej) => {
  const r = indexedDB.open('famcal-kv', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const q = r.result.transaction('kv').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  };
});
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// 푸시 알림 받기
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let d = {};
    try { d = e.data.json(); } catch (_) { d = { title: '가족 일정', body: e.data ? e.data.text() : '' }; }
    let title = d.title;
    if (d.ct) {   // 암호화된 제목(나만 보기 일정)
      try {
        const key = await kvGet('vaultKey');   // 나만 보기 비밀번호로 만든 열쇠 (이 폰에서 한 번 입력해 둔 것)
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(d.iv) }, key, b64d(d.ct));
        title = '🔔 ' + JSON.parse(new TextDecoder().decode(pt)).t;
      } catch (_) { title = '🔔 나만 보기 일정'; }
    }
    await self.registration.showNotification(title || '가족 일정', {
      body: d.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.tag,
      data: { url: d.url || './' }
    });
  })());
});

// 알림을 누르면 앱 열기
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow(url);
    })
  );
});
