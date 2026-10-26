// 運行情報の中継Worker
//
// 画面（ブラウザ）から直接ODPTのAPIを呼ぶと、アクセストークンが誰にでも見えてしまう。
// そこで、このWorkerがトークンを持ってODPTを呼び、必要な分だけを整形して返す。
//
//   GET /                              … 運行情報（千代田線・常磐線各駅停車・乗換路線）
//   GET /jr-train?number=1305K&service=weekday … JR常磐線内の列車の時刻
//
// JR東日本・東武鉄道のデータは「公共交通オープンデータチャレンジ」の限定ライセンスで使っている。
// チャレンジ用のトークン（ODPT_CHALLENGE_TOKEN）とアドレス（api-challenge.odpt.org）は、通常のものとは別。
// ライセンスは2027-03-12で終了するので、それ以降はJR・東武のデータを取りに行かない。

const METRO_API = "https://api.odpt.org/api/v4";
const CHALLENGE_API = "https://api-challenge.odpt.org/api/v4";
const CHALLENGE_END = Date.parse("2027-03-12T00:00:00+09:00"); // この時刻からは使わない

const CACHE_SECONDS = 60; // 運行情報
const TRAIN_CACHE_SECONDS = 6 * 60 * 60; // 列車の時刻（時刻表なので、めったに変わらない）

// 常に表示する路線（千代田線は東京メトロのAPI、常磐線各駅停車はチャレンジ用のAPIから取る）
const CHIYODA = "odpt.Railway:TokyoMetro.Chiyoda";
const JOBAN_LOCAL = { id: "odpt.Railway:JR-East.JobanLocal", name: "常磐線各駅停車" };

// 乗換路線：情報があるときだけ画面に出す
const TRANSFER_LINES = [
  { id: "odpt.Railway:JR-East.JobanRapid", name: "JR常磐快速線", station: "北千住・松戸・柏ほか" },
  { id: "odpt.Railway:JR-East.Musashino", name: "JR武蔵野線", station: "新松戸" },
  { id: "odpt.Railway:JR-East.NaritaAbikoBranch", name: "JR成田線", station: "我孫子" },
  { id: "odpt.Railway:Tobu.TobuUrbanPark", name: "東武アーバンパークライン＜野田線＞", station: "柏" },
];

// 平常時の文言。trainInformationStatus（運行状況）がなくても、本文がこれ以外なら「情報あり」とする
const NORMAL_TEXTS = ["平常運転", "平常どおり運転しています。", "現在、平常どおり運転しています。"];

// 常磐線各駅停車の駅名（APIの駅IDの最後の部分 → 駅名）
const JOBAN_STATIONS = {
  Ayase: "綾瀬", Kameari: "亀有", Kanamachi: "金町", Matsudo: "松戸", KitaMatsudo: "北松戸",
  Mabashi: "馬橋", ShimMatsudo: "新松戸", KitaKogane: "北小金", MinamiKashiwa: "南柏",
  Kashiwa: "柏", KitaKashiwa: "北柏", Abiko: "我孫子", Tennodai: "天王台", Toride: "取手",
};
const CALENDARS = { weekday: "odpt.Calendar:Weekday", holiday: "odpt.Calendar:SaturdayHoliday" };

// キャッシュ。Workerが動いている間、変数に結果を覚えておく。
// （workers.devのアドレスではCache APIが使えないため、この方式にしている）
let cachedInfo = null; // { body, expires }
const cachedTrains = new Map(); // "weekday:1305K" → { body, expires }

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/jr-train") return await handleJrTrain(url, env, cors);

      if (!cachedInfo || Date.now() >= cachedInfo.expires) {
        cachedInfo = { body: await fetchTrainInfo(env), expires: Date.now() + CACHE_SECONDS * 1000 };
      }
      return json(cachedInfo.body, 200, { ...cors, "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
    } catch (e) {
      // エラー内容にURL（トークン入り）が含まれないよう、メッセージだけを記録する
      console.error("取得に失敗:", e.message);
      return json({ error: "運行情報を取得できません" }, 502, { ...cors, "Cache-Control": "no-store" });
    }
  },
};

function challengeAvailable() {
  return Date.now() < CHALLENGE_END;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ODPT API: HTTP ${res.status}`);
  return res.json();
}

const ja = (v) => (v && typeof v === "object" ? v.ja : v) ?? null;

// ODPTの運行情報1件を、画面で使う形にする
function formatInfo(info, name, extra = {}) {
  return {
    railway: name,
    ...extra,
    text: ja(info["odpt:trainInformationText"]), // 例：現在、平常どおり運転しています。
    status: ja(info["odpt:trainInformationStatus"]), // 平常時はない。例：運転見合わせ、遅延、お知らせ
    cause: ja(info["odpt:trainInformationCause"]), // 例：台風、集中工事
    range: ja(info["odpt:trainInformationRange"]), // 例：姉ケ崎〜長浦駅間
    date: info["dc:date"] ?? null, // データの作成時刻（数分おきに更新される。画面では「◯◯現在」と表示）
  };
}

function hasNotice(item) {
  return Boolean(item.status) || !NORMAL_TEXTS.includes(item.text);
}

async function fetchTrainInfo(env) {
  // 千代田線とチャレンジ用（JR・東武）は別々に取り、片方が失敗しても、もう片方は返す
  const [metro, challenge] = await Promise.allSettled([
    getJson(`${METRO_API}/odpt:TrainInformation?odpt:operator=odpt.Operator:TokyoMetro`
      + `&odpt:railway=${CHIYODA}&acl:consumerKey=${env.ODPT_TOKEN}`),
    challengeAvailable()
      ? getJson(`${CHALLENGE_API}/odpt:TrainInformation`
        + `?odpt:railway=${[JOBAN_LOCAL, ...TRANSFER_LINES].map((l) => l.id).join(",")}`
        + `&acl:consumerKey=${env.ODPT_CHALLENGE_TOKEN}`)
      : Promise.resolve(null),
  ]);
  if (metro.status === "rejected") console.error("千代田線の運行情報:", metro.reason.message);
  if (challenge.status === "rejected") console.error("JR・東武の運行情報:", challenge.reason.message);

  const chiyodaInfo = metro.status === "fulfilled" ? metro.value.find((x) => x["odpt:railway"] === CHIYODA) : null;
  const chiyoda = chiyodaInfo ? formatInfo(chiyodaInfo, "千代田線") : { railway: "千代田線", error: true };

  const lines = [chiyoda];
  let transfers = [];
  if (challenge.status === "rejected") {
    lines.push({ railway: JOBAN_LOCAL.name, error: true });
  } else if (challenge.value) {
    const find = (id) => challenge.value.find((x) => x["odpt:railway"] === id);
    const joban = find(JOBAN_LOCAL.id);
    lines.push(joban ? formatInfo(joban, JOBAN_LOCAL.name) : { railway: JOBAN_LOCAL.name, error: true });
    transfers = TRANSFER_LINES
      .map((l) => (find(l.id) ? formatInfo(find(l.id), l.name, { station: l.station }) : null))
      .filter((item) => item && hasNotice(item));
  }

  if (!chiyodaInfo && challenge.status !== "fulfilled") throw new Error("運行情報をどれも取得できません");

  return {
    // 千代田線（以前の形。更新前の画面が読めるように残しておく）
    ...(chiyodaInfo ? chiyoda : {}),
    lines, // 常に表示する路線
    transfers, // 乗換路線のうち、情報のあるものだけ
  };
}

// JR常磐線内の列車の時刻を返す。途中駅は発車時刻、終点は到着時刻（データにそれしかないため）
async function handleJrTrain(url, env, cors) {
  const number = url.searchParams.get("number") || "";
  const service = url.searchParams.get("service") || "";
  // 決まった形以外は受け付けない（ODPTへのアドレスに余計な文字を入れないため）
  if (!/^\d{3,4}[A-Z]$/.test(number) || !CALENDARS[service]) {
    return json({ error: "パラメータが正しくありません" }, 400, { ...cors, "Cache-Control": "no-store" });
  }
  if (!challengeAvailable()) {
    return json({ error: "JR線内の時刻は提供を終了しました" }, 410, { ...cors, "Cache-Control": "no-store" });
  }

  const key = `${service}:${number}`;
  let entry = cachedTrains.get(key);
  if (!entry || Date.now() >= entry.expires) {
    const data = await getJson(`${CHALLENGE_API}/odpt:TrainTimetable?odpt:railway=${JOBAN_LOCAL.id}`
      + `&odpt:trainNumber=${number}&odpt:calendar=${CALENDARS[service]}`
      + `&acl:consumerKey=${env.ODPT_CHALLENGE_TOKEN}`);
    const tt = data[0];
    const body = tt
      ? {
        number,
        stops: tt["odpt:trainTimetableObject"].map((o) => {
          const arrival = Boolean(o["odpt:arrivalTime"]);
          const station = (arrival ? o["odpt:arrivalStation"] : o["odpt:departureStation"]) || "";
          const id = station.split(".").pop();
          return {
            station: JOBAN_STATIONS[id] || id,
            time: arrival ? o["odpt:arrivalTime"] : o["odpt:departureTime"],
            kind: arrival ? "着" : "発",
          };
        }),
      }
      : { number, stops: [] }; // 該当する列車がない
    entry = { body, expires: Date.now() + TRAIN_CACHE_SECONDS * 1000 };
    cachedTrains.set(key, entry);
  }
  return json(entry.body, 200, { ...cors, "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
}

// CORS：決められた公開先からの呼び出しだけを許可する
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const headers = { Vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  }
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
