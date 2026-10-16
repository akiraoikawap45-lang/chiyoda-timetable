// Service Worker：画面と時刻表のファイルを端末に保存（キャッシュ）し、オフラインでも見られるようにする。
//
// 方式は「キャッシュを先に返し、裏で最新版を取りに行く」（stale-while-revalidate）。
// 地下鉄の駅など電波が弱い場所でも、待たずにすぐ表示できる。
// 新しいデータは、次に開いたときに反映される。

// 画面のファイルの構成を変えたら、この番号を上げる（古いキャッシュが消える）
const CACHE_NAME = "timetable-v1";

const STATION_FILES = Array.from({ length: 18 }, (_, i) => `data/C${String(i + 1).padStart(2, "0")}.json`);
const PRECACHE_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "data/calendar.json",
  "data/meta.json",
  ...STATION_FILES,
];

// インストール時：全駅の時刻表を含め、必要なファイルを先にまとめて保存する
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_FILES))
      .then(() => self.skipWaiting()), // 新しい版をすぐ使い始める
  );
});

// 有効化時：古い版のキャッシュを消す
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // 自分のサイトのファイルだけを扱う。運行情報（Worker）など外部への通信はキャッシュしない
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request, { ignoreSearch: true });

    const fromNetwork = fetch(event.request)
      .then((res) => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      });

    if (cached) {
      // 裏での更新が失敗しても（オフラインなど）エラーにしない
      event.waitUntil(fromNetwork.catch(() => {}));
      return cached;
    }
    return fromNetwork;
  })());
});
