// オフライン対応。アプリ本体はネットワーク優先（更新がすぐ届く）、つながらないときは保存分を使う。
const CACHE = 'reading-dojo-v16';
const STATE = 'reading-dojo-state'; // アプリが書く今日の進み具合（お知らせ用）。更新で消さない
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== STATE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) {
    // フォントは保存分を優先
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return c.match('index.html');
      throw err;
    }
  }));
});

/* ---------- お知らせ（設定で「アプリの通知」を選んだとき） ---------- */
// アプリと同じ「朝4時で日付が変わる」日番号
const DAY = 864e5;
function today() { const n = new Date(); return Math.floor((n.getTime() - n.getTimezoneOffset() * 6e4 - 4 * 36e5) / DAY); }

async function readState() {
  try { const r = await (await caches.open(STATE)).match('state.json'); return r ? await r.json() : null; } catch (e) { return null; }
}
async function writeState(s) {
  try { await (await caches.open(STATE)).put('state.json', new Response(JSON.stringify(s), { headers: { 'Content-Type': 'application/json' } })); } catch (e) {}
}

// Android の Chrome などで、ブラウザが数時間おきに起こしてくれる（Periodic Background Sync）
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'dojo-remind') return;
  e.waitUntil((async () => {
    const s = await readState();
    if (!s || s.mode !== 'app' || s.free) return;
    const t = today();
    const left = s.key === t ? Math.max(0, s.quota - s.done) : s.quota; // 日付が変わっていたら今日はまだ0本
    if (self.navigator.setAppBadge) { try { left ? await self.navigator.setAppBadge(left) : await self.navigator.clearAppBadge(); } catch (x) {} }
    const [hh, mm] = (s.time || '20:00').split(':').map(Number), now = new Date();
    if (left === 0 || now.getHours() * 60 + now.getMinutes() < hh * 60 + mm || s.notified === t) return;
    await self.registration.showNotification('リーディング道場', {
      body: `今日の1本がまだです（残り${left}本）。` + (s.trigger ? s.trigger + '、1本。' : ''),
      tag: 'dojo-remind', icon: 'icon-192.png', badge: 'icon-192.png'
    });
    s.notified = t; await writeState(s); // 同じ日に何度も鳴らさない
  })());
});

// 通知を押したら、開いているアプリに切り替える（なければ開く）
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  })());
});
