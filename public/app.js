"use strict";

const STATIONS = [
  ["C01", "代々木上原"], ["C02", "代々木公園"], ["C03", "明治神宮前〈原宿〉"],
  ["C04", "表参道"], ["C05", "乃木坂"], ["C06", "赤坂"],
  ["C07", "国会議事堂前"], ["C08", "霞ケ関"], ["C09", "日比谷"],
  ["C10", "二重橋前〈丸の内〉"], ["C11", "大手町"], ["C12", "新御茶ノ水"],
  ["C13", "湯島"], ["C14", "根津"], ["C15", "千駄木"],
  ["C16", "西日暮里"], ["C17", "町屋"], ["C18", "北千住"],
];
const DEFAULT_STATION = "C01"; // 初めて使うときは代々木上原
// foldedDests2：綾瀬・北綾瀬もチェックボックスで選べるようにしたときに、保存の形式が変わったので名前を変えた
const STORAGE_KEYS = { station: "station", foldedDests: "foldedDests2" };
const DAY_START_HOUR = 3; // 1日の区切りは午前3時
const SERVICE_LABELS = { weekday: "平日", holiday: "土休日" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 車両の所属（trip_idの末尾の英字）
const OPERATORS = {
  S: { name: "東京メトロ", icon: "icons/train-s.png" },
  K: { name: "JR東日本", icon: "icons/train-k.png" },
  E: { name: "小田急", icon: "icons/train-e.png" },
};

// チェックボックスで折りたためる行き先
const FOLDABLE_DESTS = ["松戸", "柏", "我孫子", "取手", "綾瀬", "北綾瀬"];
// 最初はチェックを入れておく行き先（常磐線へ直通しない便）
const DEFAULT_FOLDED_DESTS = ["綾瀬", "北綾瀬"];

// 運行情報のWorkerのアドレス。手元で確認するときは、wrangler devで動かしたWorkerを使う
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const TRAIN_INFO_URL = IS_LOCAL
  ? `http://${location.hostname}:8787/`
  : "https://chiyoda-train-info.train-management.workers.dev/";
const TRAIN_INFO_TIMEOUT_MS = 8000;

// JR東日本・東武鉄道のデータ（公共交通オープンデータチャレンジの限定ライセンス）は、この時刻からは表示しない。
// Worker側でも取得をやめるが、手元に残ったデータを表示しないよう、画面側でも確かめる
const CHALLENGE_END = Date.parse("2027-03-12T00:00:00+09:00");
function challengeAvailable() {
  return Date.now() < CHALLENGE_END;
}

// ---------- 計算だけをする関数（画面に触らない） ----------

// 「運行日」と「その運行日の0時から何分たったか」を返す。
// 0:00〜2:59は前日の運行日として扱い、分は24時を超えた値にする（0:30 → 24:30 = 1470分）。
// スマホの設定に関係なく、日本時間で計算する。
function getServiceDay(now) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // getUTC〜で日本時間が読める
  let minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  if (jst.getUTCHours() < DAY_START_HOUR) {
    jst.setUTCDate(jst.getUTCDate() - 1);
    minutes += 24 * 60;
  }
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return { date: `${y}-${m}-${d}`, weekday: jst.getUTCDay(), minutes };
}

// "24:12" → 1452（分）
function timeToMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// "24:12" → "0:12"、"05:19" → "5:19"
function displayTime(time) {
  const [h, m] = time.split(":");
  return `${Number(h) % 24}:${m}`;
}

// 現在時刻の直前の1本から表示する。その位置（配列の番号）を返す。
// 折りたたむ便は「直前の1本」に数えず、その前の、普通に表示する便までさかのぼる。
function findStartIndex(trains, minutes, isFolded) {
  let next = trains.findIndex((t) => timeToMinutes(t.time) >= minutes);
  if (next === -1) next = trains.length; // 終電後
  for (let i = next - 1; i >= 0; i--) {
    if (!isFolded(trains[i])) return i;
  }
  return Math.min(next, Math.max(0, trains.length - 1));
}

// ---------- localStorage（使えない環境でもエラーにしない） ----------

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    // プライベートモードなどで使えない場合は、何もしない
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    // 保存できなくても動作は続ける
  }
}

function loadStation() {
  const code = readStorage(STORAGE_KEYS.station);
  return STATIONS.some(([c]) => c === code) ? code : DEFAULT_STATION;
}

// 折りたたむ行き先は「綾瀬,北綾瀬,松戸」のようにカンマ区切りで保存する。
// まだ一度も保存していなければ、最初の設定（綾瀬・北綾瀬）にする
function loadFoldedDests() {
  const saved = readStorage(STORAGE_KEYS.foldedDests);
  if (saved === null) return new Set(DEFAULT_FOLDED_DESTS);
  return new Set(saved.split(",").filter((d) => FOLDABLE_DESTS.includes(d)));
}

// ---------- データの読み込み ----------

async function fetchJson(url) {
  // no-cache: 毎回サーバーに「新しくなっていないか」を確認する
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// Workerからデータを取得する。失敗したら例外を投げる
async function fetchWorker(path) {
  if (!TRAIN_INFO_URL) throw new Error("運行情報のアドレスが未設定");
  // 電波が弱いときに待ち続けないよう、一定時間で打ち切る
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRAIN_INFO_TIMEOUT_MS);
  try {
    const res = await fetch(new URL(path, TRAIN_INFO_URL), { signal: controller.signal });
    if (!res.ok) throw new Error(`Worker: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 列車ごとの詳細時刻（trips.json）。最初に列車を押したときに1回だけ読み込む
let tripsPromise = null;
function loadTrips() {
  if (!tripsPromise) {
    tripsPromise = fetchJson("data/trips.json").catch((e) => {
      tripsPromise = null; // 失敗したら、次に押したときにもう一度読み込む
      throw e;
    });
  }
  return tripsPromise;
}

// ---------- 画面 ----------

const state = {
  station: loadStation(),
  service: null, // "weekday" か "holiday"
  autoService: null, // calendar.jsonから決めた、今日のダイヤ
  calendarKnown: false,
  timetable: null,
  showAll: false, // 「前の時刻を表示」を押したか
  foldedDests: loadFoldedDests(), // チェックボックスで折りたたむ行き先
  expanded: new Set(), // 開いた折りたたみ（先頭の便のtrip_idで覚える）
};

const el = {
  trainInfo: document.getElementById("train-info"),
  station: document.getElementById("station"),
  serviceButtons: document.querySelectorAll(".service-switch button"),
  foldDests: document.getElementById("fold-dests"),
  status: document.getElementById("status"),
  showEarlier: document.getElementById("show-earlier"),
  timetable: document.getElementById("timetable"),
  transferDialog: document.getElementById("transfer-dialog"),
  trainDialog: document.getElementById("train-dialog"),
};

function isFolded(t) {
  return state.foldedDests.has(t.dest);
}

function render() {
  const day = getServiceDay(new Date());

  el.serviceButtons.forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.service === state.service));
  });

  const [, m, d] = day.date.split("-").map(Number);
  let status = `${m}月${d}日（${WEEKDAYS[day.weekday]}）は${SERVICE_LABELS[state.autoService]}ダイヤ`;
  if (!state.calendarKnown) status += "（曜日から判定）";
  if (state.service !== state.autoService) status += `　※${SERVICE_LABELS[state.service]}ダイヤを表示中`;
  el.status.textContent = status;

  el.timetable.textContent = "";
  if (!state.timetable) return;

  // 特急は表示しない
  const trains = state.timetable.services[state.service].filter((t) => !t.limited_express);
  const start = state.showAll ? 0 : findStartIndex(trains, day.minutes, isFolded);
  el.showEarlier.hidden = start === 0;

  let currentHour = null;
  let list = null;
  let fold = null; // 今まとめている折りたたみ（続けて並ぶ折りたたみ対象の便を1つにまとめる）
  for (const t of trains.slice(start)) {
    const hour = Number(t.time.split(":")[0]) % 24; // 24時台は「0時」の見出しに入れる
    if (hour !== currentHour) {
      currentHour = hour;
      fold = null;
      const h = document.createElement("h2");
      h.className = "hour";
      h.textContent = `${hour}時`;
      list = document.createElement("ul");
      list.className = "trains";
      el.timetable.append(h, list);
    }
    if (isFolded(t)) {
      if (!fold) {
        fold = foldGroup(t.trip_id);
        list.append(fold.li);
      }
      fold.add(t);
    } else {
      fold = null;
      list.append(trainRow(t));
    }
  }
}

// 1便の行
function trainRow(t) {
  const li = document.createElement("li");
  li.className = `train cat-${t.category} op-${t.operator}`;
  li.append(
    span("time", displayTime(t.time)),
    operatorIcon(t.operator),
    span("type", t.type),
    span("dest", `${t.dest} 行き`),
  );
  if (t.origin) li.append(span("origin", "当駅始発"));
  // 押すと、その列車の終点までの時刻を表示する
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.addEventListener("click", () => openTrainDialog(t));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openTrainDialog(t);
    }
  });
  return li;
}

function operatorIcon(code) {
  const op = OPERATORS[code];
  if (!op) return span("operator", ""); // 想定外の車両区分：場所だけ空けておく
  const img = document.createElement("img");
  img.className = "operator";
  img.src = op.icon;
  img.alt = `${op.name}の車両`;
  img.width = 20;
  img.height = 24;
  return img;
}

// 折りたたみ。普段は細い線と本数だけを表示し、タップすると中の便を表示する
function foldGroup(key) {
  const li = document.createElement("li");
  li.className = "fold";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fold-toggle";
  const inner = document.createElement("ul");
  inner.className = "trains";
  li.append(toggle, inner);

  let count = 0;
  const update = () => {
    const open = state.expanded.has(key);
    inner.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "たたむ" : `${count}本`;
    toggle.setAttribute("aria-label", open ? "折りたたむ" : `折りたたんだ列車${count}本を表示`);
  };
  toggle.addEventListener("click", () => {
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    update();
  });

  return {
    li,
    add(t) {
      count++;
      inner.append(trainRow(t));
      update();
    },
  };
}

// 行き先のチェックボックスを作る
function buildFoldCheckboxes() {
  for (const dest of FOLDABLE_DESTS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = dest;
    box.checked = state.foldedDests.has(dest);
    box.addEventListener("change", () => {
      if (box.checked) state.foldedDests.add(dest);
      else state.foldedDests.delete(dest);
      writeStorage(STORAGE_KEYS.foldedDests, [...state.foldedDests].join(","));
      render();
    });
    label.append(box, dest);
    el.foldDests.append(label);
  }
}

function span(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

// "2026-10-26T16:08:00+09:00" → "16:08 現在"
function infoDate(date) {
  const t = new Date(date);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${hh}:${mm} 現在`;
}

// 1路線分の運行情報。status は平常時にはなく、遅延や運転見合わせ、お知らせのときに入る
function infoBlock(info, label) {
  const div = document.createElement("div");
  div.className = `line ${info.error ? "unavailable" : info.status ? "alert" : "normal"}`;
  div.append(span("label", label));
  if (info.error) {
    div.append(span("text", "運行情報を取得できません"));
    return div;
  }
  if (info.status) div.append(span("status", info.status));
  if (info.range) div.append(span("range", info.range));
  div.append(span("text", info.text || ""));
  if (info.date) div.append(span("date", infoDate(info.date)));
  return div;
}

// 運行情報を表示する。取得できなくても、時刻表の表示には影響させない
async function loadTrainInfo() {
  const box = el.trainInfo;
  box.hidden = false;
  box.textContent = "";
  let info;
  try {
    info = await fetchWorker("./");
  } catch (e) {
    box.append(infoBlock({ error: true }, "運行情報"));
    return;
  }
  // 千代田線・常磐線各駅停車は常に表示する（千代田線以外はチャレンジの期間だけ）
  const lines = (info.lines || [info]).filter((l) => l.railway === "千代田線" || challengeAvailable());
  for (const line of lines) box.append(infoBlock(line, `運行情報（${line.railway}）`));

  // 乗換路線は、情報があるときだけ知らせる。押すとウインドウで内容を表示する
  const transfers = challengeAvailable() ? info.transfers || [] : [];
  if (transfers.length) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "transfer-alert";
    button.textContent = "乗換路線の運行情報があります";
    button.addEventListener("click", () => openTransferDialog(transfers));
    box.append(button);
  }
}

function openTransferDialog(transfers) {
  const body = el.transferDialog.querySelector(".dialog-body");
  body.textContent = "";
  for (const t of transfers) body.append(infoBlock(t, `${t.railway}（${t.station}）`));
  el.transferDialog.showModal();
}

// ---------- 列車の時刻（終点まで） ----------

let trainDialogKey = null; // 今開いている列車。読み込み中に別の列車を開いたときに、古い結果を表示しないため

// 1駅分の行。times は [["13:49", "着"], ["13:50", "発"]] のような形
function stopRow(name, times, className = "") {
  const li = document.createElement("li");
  li.className = `stop ${className}`;
  const timesSpan = span("stop-times", "");
  li.append(span("stop-name", name), timesSpan);
  li.setTimes = (list) => {
    timesSpan.textContent = "";
    for (const [time, kind] of list) {
      const s = span("stop-time", "");
      s.append(span("time", displayTime(time)), span("kind", kind));
      timesSpan.append(s);
    }
  };
  li.setTimes(times);
  return li;
}

function noteRow(text) {
  const li = document.createElement("li");
  li.className = "stop-note";
  li.textContent = text;
  return li;
}

async function openTrainDialog(t) {
  const key = `${state.service}:${t.trip_id}:${state.station}`;
  trainDialogKey = key;
  const service = state.service;
  const station = state.station;

  el.trainDialog.querySelector("h2").textContent = `${displayTime(t.time)}発 ${t.type} ${t.dest} 行き`;
  const body = el.trainDialog.querySelector(".dialog-body");
  body.textContent = "";
  const sub = document.createElement("p");
  sub.className = "train-sub";
  sub.textContent = `列車番号 ${t.train_number}`
    + (OPERATORS[t.operator] ? `・${OPERATORS[t.operator].name}の車両` : "");
  const list = document.createElement("ul");
  list.className = "stops";
  body.append(sub, list);
  el.trainDialog.showModal();

  // 千代田線内（綾瀬・北綾瀬まで）：東京メトロの時刻表データ
  let trips;
  try {
    trips = await loadTrips();
  } catch (e) {
    if (trainDialogKey === key) list.append(noteRow("時刻を読み込めませんでした。"));
    return;
  }
  if (trainDialogKey !== key) return;
  const stops = trips.trips[t.trip_id] || [];
  const from = Math.max(0, stops.findIndex(([code]) => code === station));
  let lastRow = null;
  stops.slice(from).forEach(([code, time], i, rest) => {
    const last = i === rest.length - 1;
    lastRow = stopRow(trips.stations[code] || code, [[time, last ? "着" : "発"]], i === 0 ? "current" : "");
    list.append(lastRow);
  });

  // 常磐線へ直通する列車は、JR常磐線内（亀有以遠）の時刻を続けて表示する
  if (t.category !== "joban" || !lastRow) return;
  if (!challengeAvailable()) {
    list.append(noteRow("綾瀬から先（JR常磐線内）の時刻は表示していません。"));
    return;
  }
  const loading = noteRow("JR常磐線内の時刻を読み込み中…");
  list.append(loading);
  const number = t.train_number.replace(/^[AB]/, ""); // B1305K → 1305K（JRの列車番号）
  let jr;
  try {
    jr = await fetchWorker(`jr-train?number=${encodeURIComponent(number)}&service=${service}`);
  } catch (e) {
    jr = null;
  }
  if (trainDialogKey !== key) return;
  loading.remove();
  if (!jr || !jr.stops.length) {
    list.append(noteRow("JR常磐線内の時刻を取得できません。"));
    return;
  }
  // 綾瀬：千代田線のデータの時刻（到着）と、JRのデータの時刻（発車）を並べる
  let jrStops = jr.stops;
  if (jrStops[0].station === "綾瀬") {
    const [ayase] = jrStops;
    lastRow.setTimes([[stops[stops.length - 1][1], "着"], [ayase.time, ayase.kind]]);
    jrStops = jrStops.slice(1);
  }
  list.append(noteRow("ここからJR常磐線（途中駅は発車時刻、終点は到着時刻）"));
  for (const s of jrStops) list.append(stopRow(s.station, [[s.time, s.kind]]));
}

async function loadStationTimetable() {
  state.timetable = null;
  state.showAll = false;
  state.expanded.clear();
  render();
  try {
    state.timetable = await fetchJson(`data/${state.station}.json`);
  } catch (e) {
    el.timetable.textContent = "時刻表を読み込めませんでした。";
    return;
  }
  render();
}

// ウインドウの「×」と、ウインドウの外側を押したときに閉じる
function setupDialogs() {
  for (const dialog of [el.transferDialog, el.trainDialog]) {
    dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close(); // 外側（背景）を押した
    });
  }
  el.trainDialog.addEventListener("close", () => {
    trainDialogKey = null;
  });
}

async function init() {
  for (const [code, name] of STATIONS) {
    el.station.append(new Option(name, code));
  }
  el.station.value = state.station;
  buildFoldCheckboxes();
  setupDialogs();
  if (!challengeAvailable()) document.getElementById("challenge-credit").hidden = true;

  // 今日が平日ダイヤか土休日ダイヤかを決める
  const day = getServiceDay(new Date());
  let calendar = {};
  try {
    calendar = await fetchJson("data/calendar.json");
  } catch (e) {
    // 読めなくても、曜日で判定して続ける
  }
  state.calendarKnown = day.date in calendar;
  state.autoService = calendar[day.date]
    || (day.weekday === 0 || day.weekday === 6 ? "holiday" : "weekday");
  state.service = state.autoService;

  el.station.addEventListener("change", () => {
    state.station = el.station.value;
    writeStorage(STORAGE_KEYS.station, state.station);
    loadStationTimetable();
  });
  el.serviceButtons.forEach((b) => b.addEventListener("click", () => {
    state.service = b.dataset.service;
    state.showAll = false;
    state.expanded.clear();
    render();
  }));
  el.showEarlier.addEventListener("click", () => {
    state.showAll = true;
    render();
  });
  // しばらく後にアプリへ戻ってきたとき、表示位置を今の時刻に合わせ直す
  // 運行情報も取り直す
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.showAll) render();
    loadTrainInfo();
  });

  loadTrainInfo();
  loadStationTimetable();
}

init();

// オフラインでも使えるように、Service Workerを登録する
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    // 登録できなくても、通常のWebページとして動く
  });
}
