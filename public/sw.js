// ホーム画面に追加して開くための Service Worker。
// 画面のファイル(アプリシェル)は端末の控えからすぐ返し、後ろでサーバーと見比べて新しければ差し替える。
// 差し替えた版は次に開いたとき(画面に戻ったとき)から使う。
// 数字は控えから出さない。API の GET はネットワーク優先で、つながらないときだけ前に読んだ控えを返す。
// 控えを先に描いて後から描き直すのは画面(app.js)側で行う。
// Cloudflare Access の認証が切れたら、控えを返さずに 401 を返し、画面がログインし直す。
const CACHE = "kakeibo-v17";
const API_CACHE = "kakeibo-api-v1";
const KEEP = new Set([CACHE, API_CACHE]);
const SHELL = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon.svg", "/icon-180.png"];
// ログインし直すときの印。これが付いた画面の読み込みは Service Worker を通さず、Access の画面へ進める
const REAUTH = "reauth";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)))));
  self.clients.claim();
});

/** Access のログイン画面へ飛ばされた返事か。アプリ自身のエラーは JSON で返るので区別できる */
function authExpired(res) {
  if (res.type === "opaqueredirect" || res.redirected) return true;
  if (res.status !== 401 && res.status !== 403) return false;
  return !(res.headers.get("content-type") ?? "").includes("application/json");
}

function authResponse() {
  return new Response(JSON.stringify({ error: "ログインし直してください", reauth: true }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function apiRequest(event) {
  const request = event.request;
  const cache = await caches.open(API_CACHE);
  let res;
  try {
    res = await fetch(new Request(request, { redirect: "manual" }));
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "オフラインです" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (authExpired(res)) return authResponse();
  const type = res.headers.get("content-type") ?? "";
  if (res.ok && type.includes("application/json")) {
    const copy = res.clone();
    event.waitUntil((async () => {
      try {
        await cache.put(request, copy);
        // 際限なく貯めない
        const keys = await cache.keys();
        for (const key of keys.slice(0, Math.max(0, keys.length - 80))) await cache.delete(key);
      } catch { /* 容量不足などは無視 */ }
    })());
  }
  return res;
}

// 後ろでシェルをサーバーと見比べる。開くたびに何度も走らないよう、走っている間は重ねない
let refreshing = null;
function refreshShell() {
  refreshing ??= (async () => {
    const cache = await caches.open(CACHE);
    // 全部そろってから差し替え、画面と app.js の版が食い違わないようにする
    const fresh = [];
    let expired = false;
    try {
      for (const path of SHELL) {
        const res = await fetch(path, { cache: "no-cache", redirect: "manual" });
        if (authExpired(res)) { expired = true; break; }
        if (!res.ok) return;
        fresh.push([path, res]);
      }
    } catch { return; /* つながらないときは控えのまま */ }
    let changed = false;
    if (!expired) {
      for (const [path, res] of fresh) {
        const old = await cache.match(path);
        if (old && sameBytes(await res.clone().arrayBuffer(), await old.arrayBuffer())) continue;
        await cache.put(path, res);
        changed = true;
      }
    }
    if (changed || expired) {
      for (const client of await self.clients.matchAll({ type: "window" })) {
        client.postMessage({ type: expired ? "reauth" : "updated" });
      }
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

async function shellRequest(event, path) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(path);
  if (cached) {
    // 開いたときに一度だけ見比べる。app.js などの読み込みのたびには見ない
    if (event.request.mode === "navigate") event.waitUntil(refreshShell());
    return cached;
  }
  // 控えがまだないときはネットワークから読み、控えに残す
  const res = await fetch(event.request);
  if (res.ok && !res.redirected) {
    const copy = res.clone();
    event.waitUntil(cache.put(path, copy).catch(() => {}));
  }
  return res;
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
  if (e.request.mode === "navigate") {
    // ログインし直すときと、画面以外の道(/cdn-cgi/ など)はそのままサーバーへ
    if (url.searchParams.has(REAUTH) || url.pathname !== "/") return;
    e.respondWith(shellRequest(e, "/").catch(() => caches.match("/")));
    return;
  }
  if (SHELL.includes(url.pathname) && !url.search) {
    e.respondWith(shellRequest(e, url.pathname).catch(() => caches.match(url.pathname)));
  }
});
