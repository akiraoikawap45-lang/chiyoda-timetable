// 運行情報の中継Worker
//
// 画面（ブラウザ）から直接ODPTのAPIを呼ぶと、アクセストークンが誰にでも見えてしまう。
// そこで、このWorkerがトークンを持ってODPTを呼び、千代田線の分だけを整形して返す。

const API_URL = "https://api.odpt.org/api/v4/odpt:TrainInformation"
  + "?odpt:operator=odpt.Operator:TokyoMetro"
  + "&odpt:railway=odpt.Railway:TokyoMetro.Chiyoda";
const CACHE_SECONDS = 60;

// 60秒キャッシュ。Workerが動いている間、変数に結果を覚えておく。
// （workers.devのアドレスではCache APIが使えないため、この方式にしている）
let cached = null; // { body, expires }

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    try {
      if (!cached || Date.now() >= cached.expires) {
        cached = { body: await fetchTrainInfo(env), expires: Date.now() + CACHE_SECONDS * 1000 };
      }
      return json(cached.body, 200, { ...cors, "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
    } catch (e) {
      // エラー内容にURL（トークン入り）が含まれないよう、メッセージだけを記録する
      console.error("運行情報の取得に失敗:", e.message);
      return json({ error: "運行情報を取得できません" }, 502, { ...cors, "Cache-Control": "no-store" });
    }
  },
};

async function fetchTrainInfo(env) {
  const res = await fetch(`${API_URL}&acl:consumerKey=${env.ODPT_TOKEN}`);
  if (!res.ok) throw new Error(`ODPT API: HTTP ${res.status}`);
  const data = await res.json();
  const info = data.find((x) => x["odpt:railway"] === "odpt.Railway:TokyoMetro.Chiyoda");
  if (!info) throw new Error("千代田線の運行情報が見つかりません");

  const ja = (v) => (v && typeof v === "object" ? v.ja : v) ?? null;
  return {
    railway: "千代田線",
    text: ja(info["odpt:trainInformationText"]), // 例：現在、平常どおり運転しています。
    status: ja(info["odpt:trainInformationStatus"]), // 平常時はない。例：運転見合わせ、遅延
    date: info["dc:date"] ?? null, // データの作成時刻（数分おきに更新される。画面では「◯◯現在」と表示）
  };
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
