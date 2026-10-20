"""デバッグ用：東京メトロのGTFSから、選んだ路線・ダイヤ・方向の行をそのままJSONに書き出す。

使い方（プロジェクトのフォルダで）:
    python3 debug/export_gtfs.py

起動するとGTFSを1回ダウンロードし、ブラウザ用の画面を http://localhost:8765/ で開く。
（VS Codeのコンテナで動かしている場合、ポート8765は自動でWindows側に転送される）
画面で条件を選んで「保存」を押すと、debug/output/ にJSONを書き出し、ブラウザでもダウンロードできる。

GTFSの各行は、列名も値（文字列）もCSVのまま入れる。加工はしない。
"""

import datetime
import io
import json
import sys
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
# トークンの読み込み・ダウンロード・CSVの読み込みは、アプリ用のスクリプトと同じものを使う
from build_timetable import JST, download_gtfs, load_token, read_csv  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "output"
PORT = 8765

SERVICES = {"0": "平日", "1": "土休日"}
# trip_id の3文字目が A線・B線（例: 50B0607E00 → B線）
# 路線によって A線＝direction_id 0 のこともあれば 1 のこともあるので、direction_idではなくこちらで選ぶ
LINES = ["A", "B"]


def load_gtfs():
    print("GTFSをダウンロードしています…")
    zf = zipfile.ZipFile(io.BytesIO(download_gtfs(load_token())))
    gtfs = {name: read_csv(zf, name) for name in [
        "feed_info.txt", "routes.txt", "trips.txt", "stop_times.txt", "stops.txt",
        "calendar.txt", "calendar_dates.txt",
    ]}
    feed = gtfs["feed_info.txt"][0]
    print(f"GTFS feed_version={feed['feed_version']} 有効期間 {feed['feed_start_date']}〜{feed['feed_end_date']}")

    others = {t["trip_id"][2] for t in gtfs["trips.txt"]} - set(LINES)
    if others:
        print(f"注意: trip_id の3文字目に A・B 以外の値があります: {sorted(others)}（その便は選べません）")
    return gtfs


def build_options(gtfs):
    """画面に出す選択肢：路線ごとに、A線・B線の direction_id と主な行き先を調べる。"""
    summary = {}  # (route_id, 線) → {"direction_ids": set, "headsigns": {行き先: 本数}}
    for t in gtfs["trips.txt"]:
        s = summary.setdefault((t["route_id"], t["trip_id"][2]), {"direction_ids": set(), "headsigns": {}})
        s["direction_ids"].add(t["direction_id"])
        s["headsigns"][t["trip_headsign"]] = s["headsigns"].get(t["trip_headsign"], 0) + 1

    routes = []
    for r in gtfs["routes.txt"]:
        lines = {}
        for line in LINES:
            s = summary.get((r["route_id"], line))
            if s is None:
                continue
            # 本数の多い順に、上位3つの行き先を表示する
            top = sorted(s["headsigns"].items(), key=lambda x: -x[1])[:3]
            lines[line] = {
                "direction_ids": sorted(s["direction_ids"]),
                "headsigns": [name for name, _ in top],
            }
        routes.append({"route_id": r["route_id"], "name": r["route_long_name"], "color": r["route_color"], "lines": lines})
    return {"feed_info": gtfs["feed_info.txt"][0], "routes": routes, "services": SERVICES}


def extract(gtfs, route_ids, service_ids, lines):
    """条件に合う便（trips）と、その便に関係する行を、GTFSのまま取り出す。"""
    trips = [
        t for t in gtfs["trips.txt"]
        if t["route_id"] in route_ids and t["service_id"] in service_ids and t["trip_id"][2] in lines
    ]
    trip_ids = {t["trip_id"] for t in trips}
    # stop_times.txt はファイルに書かれている順のまま（便ごと・stop_sequence順に並んでいる）
    stop_times = [st for st in gtfs["stop_times.txt"] if st["trip_id"] in trip_ids]
    stop_ids = {st["stop_id"] for st in stop_times}

    return {
        "conditions": {
            "route_ids": sorted(route_ids, key=int),
            "service_ids": sorted(service_ids),
            "lines": sorted(lines),
            "exported_at": datetime.datetime.now(JST).isoformat(timespec="seconds"),
        },
        "counts": {"trips": len(trips), "stop_times": len(stop_times)},
        "feed_info": gtfs["feed_info.txt"],
        "routes": [r for r in gtfs["routes.txt"] if r["route_id"] in route_ids],
        "calendar": [c for c in gtfs["calendar.txt"] if c["service_id"] in service_ids],
        "calendar_dates": [c for c in gtfs["calendar_dates.txt"] if c["service_id"] in service_ids],
        "stops": [s for s in gtfs["stops.txt"] if s["stop_id"] in stop_ids],
        "trips": trips,
        "stop_times": stop_times,
    }


def to_json_text(data):
    """見やすさと容量のバランスのため、表（リスト）の1行をJSONの1行にして書く。"""
    parts = []
    for key, value in data.items():
        if isinstance(value, list):
            rows = ",\n".join("    " + json.dumps(row, ensure_ascii=False) for row in value)
            body = f"[\n{rows}\n  ]" if value else "[]"
        else:
            body = json.dumps(value, ensure_ascii=False, indent=2).replace("\n", "\n  ")
        parts.append(f"  {json.dumps(key)}: {body}")
    return "{\n" + ",\n".join(parts) + "\n}\n"


def make_filename(gtfs, data):
    c = data["conditions"]
    all_routes = len(c["route_ids"]) == len(gtfs["routes.txt"])
    route = "all" if all_routes else "-".join(c["route_ids"])
    service = "both" if len(c["service_ids"]) == 2 else {"0": "weekday", "1": "holiday"}[c["service_ids"][0]]
    line = "AB" if len(c["lines"]) == 2 else c["lines"][0]
    version = gtfs["feed_info.txt"][0]["feed_version"]
    return f"gtfs_{version}_route-{route}_{service}_{line}.json"


class Handler(BaseHTTPRequestHandler):
    gtfs = None  # 起動時に読み込んだGTFS（全リクエストで使い回す）

    def send(self, status, body, content_type, extra_headers=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/":
            self.send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif url.path == "/api/options":
            self.send(200, json.dumps(build_options(self.gtfs), ensure_ascii=False), "application/json; charset=utf-8")
        elif url.path == "/api/export":
            self.export(parse_qs(url.query))
        else:
            self.send(404, "not found", "text/plain; charset=utf-8")

    def export(self, query):
        # 画面からは ?route=1&route=5&service=0&line=A のように届く
        route_ids = set(query.get("route", [])) & {r["route_id"] for r in self.gtfs["routes.txt"]}
        service_ids = set(query.get("service", [])) & set(SERVICES)
        lines = set(query.get("line", [])) & set(LINES)
        if not (route_ids and service_ids and lines):
            self.send(400, "路線・ダイヤ・方向を1つ以上選んでください", "text/plain; charset=utf-8")
            return

        data = extract(self.gtfs, route_ids, service_ids, lines)
        filename = make_filename(self.gtfs, data)
        text = to_json_text(data)
        OUT_DIR.mkdir(exist_ok=True)
        (OUT_DIR / filename).write_text(text, encoding="utf-8", newline="\n")
        print(f"保存: debug/output/{filename}（便 {data['counts']['trips']}、stop_times {data['counts']['stop_times']}行）")

        self.send(200, text, "application/json; charset=utf-8", {
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Saved-Path": f"debug/output/{filename}",
        })

    def log_message(self, format, *args):
        pass  # アクセスのたびにログを出さない（保存したときだけ表示する）


def main():
    Handler.gtfs = load_gtfs()
    # 127.0.0.1: このコンピューター（コンテナ）の中からだけ接続できる
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"ブラウザで http://localhost:{PORT}/ を開いてください（終了は Ctrl+C）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました")


if __name__ == "__main__":
    main()
