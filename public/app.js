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
const STORAGE_KEYS = { station: "station", foldedDests: "foldedDests" };
const DAY_START_HOUR = 3; // 1日の区切りは午前3時
const SERVICE_LABELS = { weekday: "平日", holiday: "土休日" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 車両の所属（trip_idの末尾の英字）
const OPERATORS = {
  S: { name: "東京メトロ", icon: "icons/train-s.png" },
  K: { name: "JR東日本", icon: "icons/train-k.png" },
  E: { name: "小田急", icon: "icons/train-e.png" },
};

// 常磐線へ直通しない便は、いつも折りたたむ
const ALWAYS_FOLDED_CATEGORIES = ["ayase", "kitaayase"];
// チェックボックスで折りたためる行き先（常磐線直通）
const FOLDABLE_DESTS = ["松戸", "柏", "我孫子", "取手"];

// 運行情報のWorkerのアドレス。手元で確認するときは、wrangler devで動かしたWorkerを使う
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const TRAIN_INFO_URL = IS_LOCAL
  ? `http://${location.hostname}:8787/`
  : "https://chiyoda-train-info.train-management.workers.dev/";
const TRAIN_INFO_TIMEOUT_MS = 8000;

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

// 折りたたむ行き先は「松戸,柏」のようにカンマ区切りで保存する
function loadFoldedDests() {
  const saved = (readStorage(STORAGE_KEYS.foldedDests) || "").split(",");
  return new Set(saved.filter((d) => FOLDABLE_DESTS.includes(d)));
}

// ---------- データの読み込み ----------

async function fetchJson(url) {
  // no-cache: 毎回サーバーに「新しくなっていないか」を確認する
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// 運行情報を取得する。失敗したら例外を投げる
async function fetchTrainInfo() {
  if (!TRAIN_INFO_URL) throw new Error("運行情報のアドレスが未設定");
  // 電波が弱いときに待ち続けないよう、一定時間で打ち切る
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRAIN_INFO_TIMEOUT_MS);
  try {
    const res = await fetch(TRAIN_INFO_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`運行情報: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
};

function isFolded(t) {
  return ALWAYS_FOLDED_CATEGORIES.includes(t.category) || state.foldedDests.has(t.dest);
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

// 運行情報を表示する。取得できなくても、時刻表の表示には影響させない
async function loadTrainInfo() {
  const box = el.trainInfo;
  box.hidden = false;
  box.className = "";
  box.textContent = "";
  let info;
  try {
    info = await fetchTrainInfo();
  } catch (e) {
    box.className = "unavailable";
    box.append(span("label", "運行情報"), span("text", "運行情報を取得できません"));
    return;
  }
  // status は平常時にはなく、遅延や運転見合わせのときに入る
  box.className = info.status ? "alert" : "normal";
  box.append(span("label", `運行情報（${info.railway}）`));
  if (info.status) box.append(span("status", info.status));
  box.append(span("text", info.text || ""));
  if (info.date) {
    const t = new Date(info.date);
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    box.append(span("date", `${hh}:${mm} 発表`));
  }
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

async function init() {
  for (const [code, name] of STATIONS) {
    el.station.append(new Option(name, code));
  }
  el.station.value = state.station;
  buildFoldCheckboxes();

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
