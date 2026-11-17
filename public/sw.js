// 서비스 워커: 앱 설치·오프라인 사용·다른 앱에서 공유받기를 맡는다.
const SHELL = 'fr-shell-v5';   // 화면 파일: 온라인이면 항상 최신, 오프라인이면 저장본
const STATIC = 'fr-static-v1'; // 성경 본문·라이브러리: 한 번 받으면 저장본 사용
const SHARE = 'fr-share';      // 공유로 받은 파일 임시 보관
const SHELL_FILES = ['./', 'style.css', 'js/app.js', 'js/tts.js', 'js/extract.js', 'js/office.js', 'js/bible.js', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => ![SHELL, STATIC, SHARE].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function receiveShare(request) {
  const form = await request.formData();
  const file = form.get('file');
  if (file && typeof file !== 'string' && file.size) {
    const cache = await caches.open(SHARE);
    await cache.put('shared-file', new Response(file, {
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name || 'file') },
    }));
    return Response.redirect('./?shared=1', 303);
  }
  const q = new URLSearchParams();
  for (const k of ['title', 'text', 'url']) if (form.get(k)) q.set(k, form.get(k));
  return Response.redirect('./?' + q, 303);
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' }) || (request.mode === 'navigate' && await cache.match('./'));
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) return e.respondWith(receiveShare(e.request));
  if (e.request.method !== 'GET' || url.pathname.includes('/api/') || url.pathname.endsWith('.apk')) return;
  e.respondWith(/\/(vendor|bible)\//.test(url.pathname) ? cacheFirst(e.request) : networkFirst(e.request));
});
