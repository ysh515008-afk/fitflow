/* FitFlow Service Worker
 * ------------------------------------------------------------
 * 这个应用的特殊点：**所有数据都存在 localStorage，不出本机**。
 * Service Worker 在这里只做一件事——把应用自己的静态资源缓存下来，
 * 让你在没网 / 弱网时也能打开使用。
 *
 * 策略说明（为什么不是全部 cache-first）：
 *   - 应用壳（HTML/CSS/JS/图标）几乎不变 → cache-first，命中直接回
 *   - 出站 API 请求（AI 模型接口、红狐、本地代理）**绝不缓存**
 *     这些是用户主动触发的数据交换，缓存会带来"看到旧数据"的误导
 *   - 跨域请求 SW 本来就管不到响应体细节，这里显式 passthrough 最安全
 *
 * 版本号升级 = 换 CACHE 名 → 旧缓存自动清掉。
 */

const CACHE = 'fitflow-v1';
const APP_SHELL = [
  './try.html',
  './styles.css',
  './manifest.webmanifest',
  './favicon.ico',
  './icons/pwa/icon-192.png',
  './icons/pwa/icon-512.png',
  './icons/pwa/icon-1024.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // 写操作不拦

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 跨域出站请求一律 passthrough

  // 应用壳：cache-first，未命中才回源
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // 只缓存同源的成功响应，避免把 404/500 也存进去
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./try.html'));          // 离线兜底回首页
    })
  );
});
