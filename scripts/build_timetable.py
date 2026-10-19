"""東京メトロのGTFSから、千代田線（綾瀬方面）の駅別時刻表JSONを作る。

使い方（プロジェクトのフォルダで）:
    python3 scripts/build_timetable.py           # データが前回と同じなら駅のJSONは作り直さない
    python3 scripts/build_timetable.py --force   # 必ず作り直す

ODPTのトークンは環境変数 ODPT_TOKEN から読む。
手元で動かすときは、.env に書いておけば自動で読み込む。
"""

import argparse
import csv
import datetime
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "data"
DESTINATIONS_FILE = Path(__file__).resolve().parent / "destinations.json"

GTFS_URL = "https://api.odpt.org/api/v4/files/TokyoMetro/data/TokyoMetro-Train-GTFS.zip?acl:consumerKey={token}"

ROUTE_NAME = "千代田線"
DIRECTION_ID = "0"  # 綾瀬方面
STATION_CODES = [f"C{i:02d}" for i in range(1, 19)]  # C01（代々木上原）〜C18（北千住）
# 列車の詳細時刻（trips.json）には、終点の綾瀬・北綾瀬も含める
# （GTFSには綾瀬より先、JR常磐線内の時刻は入っていない）
TRIP_STOP_CODES = STATION_CODES + ["C19", "C20"]
SERVICE_NAMES = {"0": "weekday", "1": "holiday"}  # GTFSのservice_id → JSONでの呼び名
OPERATORS = {"S", "K", "E"}  # 東京メトロ、JR東日本、小田急
CALENDAR_DAYS = 90
FEED_END_WARNING_DAYS = 30

JST = datetime.timezone(datetime.timedelta(hours=9))


def warn(message):
    # "::warning::" で始めると、GitHub Actionsの画面で黄色い警告として表示される
    print(f"::warning::{message}")


def load_token():
    token = os.environ.get("ODPT_TOKEN")
    env_file = ROOT / ".env"
    if not token and env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == "ODPT_TOKEN":
                token = value.strip().strip('"').strip("'")
    if not token:
        sys.exit("ODPT_TOKEN が設定されていません（.env または環境変数で指定してください）")
    return token


def download_gtfs(token):
    # URLにトークンが含まれるので、URLそのものはログに出さない
    # （ODPTは別のURLへ転送するが、urllibは自動で転送先をたどる）
    with urllib.request.urlopen(GTFS_URL.format(token=token), timeout=120) as res:
        return res.read()


def read_csv(zf, name):
    # utf-8-sig: ファイル先頭にBOM（目に見えない印）があっても正しく読める
    with zf.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def parse_date(yyyymmdd):
    return datetime.datetime.strptime(yyyymmdd, "%Y%m%d").date()


def to_seconds(gtfs_time):
    """'24:48:00' → 89280（並べ替え用。24時を超える時刻もそのまま扱える）"""
    h, m, s = (int(x) for x in gtfs_time.split(":"))
    return h * 3600 + m * 60 + s


def parse_trip_id(trip_id):
    """'50B0607E00' → ('B607E', 'E')。列車番号と車両区分を取り出す。"""
    core = trip_id[2:8]  # 'B0607E'
    operator = core[-1]
    train_number = core[0] + str(int(core[1:5])) + operator
    return train_number, operator


def build_calendar(calendar_rows, calendar_date_rows, start, days):
    """日付ごとに「平日ダイヤ」「土休日ダイヤ」のどちらが走るかを決める。"""
    added = {}  # 日付 → その日に追加で走る service_id の集合
    removed = {}  # 日付 → その日は走らない service_id の集合
    for row in calendar_date_rows:
        d = parse_date(row["date"])
        target = added if row["exception_type"] == "1" else removed
        target.setdefault(d, set()).add(row["service_id"])

    weekday_columns = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    result = {}
    for i in range(days):
        d = start + datetime.timedelta(days=i)
        active = set()
        for row in calendar_rows:
            in_period = parse_date(row["start_date"]) <= d <= parse_date(row["end_date"])
            if in_period and row[weekday_columns[d.weekday()]] == "1":
                active.add(row["service_id"])
        active |= added.get(d, set())
        active -= removed.get(d, set())

        if not active:
            continue  # データの有効期間外。画面側で「データなし」と扱う
        if len(active) > 1:
            warn(f"{d} に複数のダイヤ（service_id={sorted(active)}）があります。先頭のものを使います")
        service_id = sorted(active)[0]
        if service_id not in SERVICE_NAMES:
            warn(f"{d} のservice_id={service_id} は想定外です")
            continue
        result[d.isoformat()] = SERVICE_NAMES[service_id]
    return result


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="データが前回と同じでも作り直す")
    args = parser.parse_args()

    # 1. ダウンロード
    zip_bytes = download_gtfs(load_token())
    zip_hash = hashlib.sha256(zip_bytes).hexdigest()
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))

    feed = read_csv(zf, "feed_info.txt")[0]
    print(f"GTFS feed_version={feed['feed_version']} 有効期間 {feed['feed_start_date']}〜{feed['feed_end_date']}")

    today = datetime.datetime.now(JST).date()
    days_left = (parse_date(feed["feed_end_date"]) - today).days
    if days_left < FEED_END_WARNING_DAYS:
        warn(f"GTFSの有効期限（{feed['feed_end_date']}）まであと{days_left}日です。ダイヤ改正のデータを確認してください")

    # 日付ごとのダイヤ対応表は、実行日から90日分を毎回作り直す
    # （データが変わらなくても、日付が進むので更新が必要）
    calendar = build_calendar(
        read_csv(zf, "calendar.txt"), read_csv(zf, "calendar_dates.txt"), today, CALENDAR_DAYS
    )
    write_json(OUT_DIR / "calendar.json", calendar)
    print(f"calendar.json: {len(calendar)}日分")

    # 2. 前回と同じデータなら、駅の時刻表は作り直さない
    meta_path = OUT_DIR / "meta.json"
    if meta_path.exists() and not args.force:
        old_meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if old_meta.get("zip_sha256") == zip_hash:
            print("GTFSは前回と同じです。駅の時刻表は更新しません")
            return

    # 3. 千代田線・綾瀬方面の便を探す
    route_ids = {r["route_id"] for r in read_csv(zf, "routes.txt") if r["route_long_name"] == ROUTE_NAME}
    if not route_ids:
        sys.exit(f"routes.txt に「{ROUTE_NAME}」が見つかりません")

    trips = {
        t["trip_id"]: t
        for t in read_csv(zf, "trips.txt")
        if t["route_id"] in route_ids and t["direction_id"] == DIRECTION_ID
    }
    stops = {s["stop_id"]: s for s in read_csv(zf, "stops.txt") if s["stop_code"] in TRIP_STOP_CODES}

    stop_times_by_trip = {}
    for st in read_csv(zf, "stop_times.txt"):
        if st["trip_id"] in trips:
            stop_times_by_trip.setdefault(st["trip_id"], []).append(st)

    destinations = json.loads(DESTINATIONS_FILE.read_text(encoding="utf-8"))
    warned = set()  # 同じ警告を何度も出さないための記録

    # 4. 駅ごとに、発車する便の情報を集める
    stations = {code: {"weekday": [], "holiday": []} for code in STATION_CODES}
    trip_details = {}  # trip_id → [[駅コード, 時刻], ...]（列車の詳細時刻）
    for trip_id, trip in trips.items():
        service = SERVICE_NAMES.get(trip["service_id"])
        if service is None:
            if ("service", trip["service_id"]) not in warned:
                warn(f"想定外のservice_id: {trip['service_id']}（この便は使いません）")
                warned.add(("service", trip["service_id"]))
            continue

        rows = stop_times_by_trip.get(trip_id, [])
        # 時刻が空欄の駅（通過駅）がある便を「特急」とする
        limited_express = any(not r["departure_time"] for r in rows)

        train_number, operator = parse_trip_id(trip_id)
        if operator not in OPERATORS and ("op", operator) not in warned:
            warn(f"想定外の車両区分: {operator}（例: {trip_id}）")
            warned.add(("op", operator))

        headsign = trip["trip_headsign"]
        dest = destinations.get(headsign)
        if dest is None:
            dest = {"name": headsign, "category": "unknown"}
            if ("dest", headsign) not in warned:
                warn(f"対応表にない行き先: {headsign}（scripts/destinations.json に追加してください）")
                warned.add(("dest", headsign))

        # 列車の詳細時刻：停車する駅を順に並べる（通過駅は除く）
        rows = sorted(rows, key=lambda r: int(r["stop_sequence"]))
        trip_details[trip_id] = [
            [stops[r["stop_id"]]["stop_code"], (r["departure_time"] or r["arrival_time"])[:5]]
            for r in rows
            if r["stop_id"] in stops and r["departure_time"]
        ]

        # 当駅始発：その便の最初の停車駅。ただし代々木上原は除く
        # （データ上は全便が代々木上原から始まるが、実際は小田急線から直通してくる便もあり、区別できないため）
        first_stop = stops.get(rows[0]["stop_id"]) if rows else None
        origin_code = first_stop["stop_code"] if first_stop and first_stop["stop_code"] != "C01" else None

        for r in rows:
            stop = stops.get(r["stop_id"])
            if stop is None or stop["stop_code"] not in STATION_CODES:
                continue  # 綾瀬・北綾瀬など、時刻表の対象外の駅
            if not r["departure_time"]:
                continue  # 通過
            if r["pickup_type"] == "1":
                continue  # 乗車できない（終点など）
            stations[stop["stop_code"]][service].append({
                "_sort": to_seconds(r["departure_time"]),
                "trip_id": trip_id,
                "time": r["departure_time"][:5],
                "dest": dest["name"],
                "category": dest["category"],
                "type": "特急" if limited_express else "各駅停車",
                "train_number": train_number,
                "operator": operator,
                "limited_express": limited_express,
                "origin": stop["stop_code"] == origin_code,
            })

    # 5. 駅ごとにJSONを書き出す
    for code in STATION_CODES:
        name = next(s["stop_name"] for s in stops.values() if s["stop_code"] == code)
        services = {}
        for service, items in stations[code].items():
            items.sort(key=lambda x: x["_sort"])
            services[service] = [{k: v for k, v in x.items() if k != "_sort"} for x in items]
        write_json(OUT_DIR / f"{code}.json", {
            "station": {"code": code, "name": name},
            "feed_version": feed["feed_version"],
            "services": services,
        })
        print(f"{code}.json {name}: 平日{len(services['weekday'])}本 土休日{len(services['holiday'])}本")

    # 6. 列車の詳細時刻（全便分を1つのファイルにまとめる）
    # 中身は大きくなるので、インデントなしで書き出す
    station_names = {s["stop_code"]: s["stop_name"] for s in stops.values()}
    with open(OUT_DIR / "trips.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump({
            "feed_version": feed["feed_version"],
            "stations": {code: station_names[code] for code in TRIP_STOP_CODES},
            "trips": dict(sorted(trip_details.items())),
        }, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"trips.json: {len(trip_details)}便")

    write_json(meta_path, {
        "feed_version": feed["feed_version"],
        "feed_start_date": feed["feed_start_date"],
        "feed_end_date": feed["feed_end_date"],
        "zip_sha256": zip_hash,
    })


if __name__ == "__main__":
    main()
