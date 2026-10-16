"use strict";

const STATIONS = [
  ["C01", "代々木上原"], ["C02", "代々木公園"], ["C03", "明治神宮前〈原宿〉"],
  ["C04", "表参道"], ["C05", "乃木坂"], ["C06", "赤坂"],
  ["C07", "国会議事堂前"], ["C08", "霞ケ関"], ["C09", "日比谷"],
  ["C10", "二重橋前〈丸の内〉"], ["C11", "大手町"], ["C12", "新御茶ノ水"],
  ["C13", "湯島"], ["C14", "根津"], ["C15", "千駄木"],
  ["C16", "西日暮里"], ["C17", "町屋"], ["C18", "北千住"],
];
const DEFAULT_STATION = "C11";
const STORAGE_KEY = "station";
const DAY_START_HOUR = 3; // 1日の区切りは午前3時
const SERVICE_LABELS = { weekday: "平日", holiday: "土休日" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

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
function findStartIndex(trains, minutes) {
  const next = trains.findIndex((t) => timeToMinutes(t.time) >= minutes);
  if (next === -1) return Math.max(0, trains.length - 1); // 終電後は最後の1本だけ
  return Math.max(0, next - 1);
}

// ---------- localStorage（使えない環境でもエラーにしない） ----------

function loadStation() {
  try {
    const code = localStorage.getItem(STORAGE_KEY);
    if (STATIONS.some(([c]) => c === code)) return code;
  } catch (e) {
    // プライベートモードなどで使えない場合は、何もしない
  }
  return DEFAULT_STATION;
}

function saveStation(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch (e) {
    // 保存できなくても動作は続ける
  }
}

// ---------- データの読み込み ----------

async function fetchJson(url) {
  // no-cache: 毎回サーバーに「新しくなっていないか」を確認する
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// ---------- 画面 ----------

const state = {
  station: loadStation(),
  service: null, // "weekday" か "holiday"
  autoService: null, // calendar.jsonから決めた、今日のダイヤ
  calendarKnown: false,
  timetable: null,
  showAll: false, // 「前の時刻を表示」を押したか
};

const el = {
  station: document.getElementById("station"),
  serviceButtons: document.querySelectorAll(".service-switch button"),
  status: document.getElementById("status"),
  showEarlier: document.getElementById("show-earlier"),
  timetable: document.getElementById("timetable"),
};

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
  const start = state.showAll ? 0 : findStartIndex(trains, day.minutes);
  el.showEarlier.hidden = start === 0;

  let currentHour = null;
  let list = null;
  for (const t of trains.slice(start)) {
    const hour = Number(t.time.split(":")[0]) % 24; // 24時台は「0時」の見出しに入れる
    if (hour !== currentHour) {
      currentHour = hour;
      const h = document.createElement("h2");
      h.className = "hour";
      h.textContent = `${hour}時`;
      list = document.createElement("ul");
      list.className = "trains";
      el.timetable.append(h, list);
    }
    list.append(trainRow(t));
  }
}

function trainRow(t) {
  const li = document.createElement("li");
  li.className = `train cat-${t.category} op-${t.operator}`;
  li.append(
    span("time", displayTime(t.time)),
    span("type", t.type),
    span("dest", `${t.dest} 行き`),
    span("operator", ""), // 車両区分のアイコン用（今は空）
  );
  li.lastChild.dataset.operator = t.operator;
  return li;
}

function span(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

async function loadStationTimetable() {
  state.timetable = null;
  state.showAll = false;
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
    saveStation(state.station);
    loadStationTimetable();
  });
  el.serviceButtons.forEach((b) => b.addEventListener("click", () => {
    state.service = b.dataset.service;
    state.showAll = false;
    render();
  }));
  el.showEarlier.addEventListener("click", () => {
    state.showAll = true;
    render();
  });
  // しばらく後にアプリへ戻ってきたとき、表示位置を今の時刻に合わせ直す
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.showAll) render();
  });

  loadStationTimetable();
}

init();

// オフラインでも使えるように、Service Workerを登録する
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    // 登録できなくても、通常のWebページとして動く
  });
}
