// ホーム画面に追加して開けるようにするための最小限のService Worker。
// 画面のファイルはネットワーク優先。APIのGETは、控えをすぐ返して裏で最新に取り替える(SWR)。
const CACHE = "kakeibo-v8";
const API_CACHE = "kakeibo-api-v1";
const KEEP = new Set([CACHE, API_CACHE]);
const SHELL = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon.svg", "/icon-180.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)))));
  self.clients.claim();
});

async function apiRequest(event) {
  const request = event.request;
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(async (res) => {
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("application/json")) {
      try {
        await cache.put(request, res.clone());
        // 際限なく貯めない
        const keys = await cache.keys();
        for (const key of keys.slice(0, Math.max(0, keys.length - 80))) await cache.delete(key);
      } catch { /* 容量不足などは無視 */ }
    }
    return res;
  });
  if (cached) {
    // まず控えを返し、裏で最新に取り替える
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network.catch(() => new Response(JSON.stringify({ error: "オフラインです" }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== "GET") {
    // 書き込みのあとは、次の読み出しで最新を取る
    if (url.pathname.startsWith("/api/")) e.waitUntil(caches.delete(API_CACHE));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(apiRequest(e));
    return;
  }
  // 画面のファイルはネットワークを先に見て、つながらないときだけ控えを使う
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r ?? caches.match("/"))));
});
