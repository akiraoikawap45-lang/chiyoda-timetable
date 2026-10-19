# 千代田線 常磐線方面 時刻表アプリ

## このプロジェクトについて

公共交通オープンデータチャレンジ2026（応募締切：2027-01-11 23:59 JST）への応募を目指す、Webアプリ（PWA）。

**趣旨**：東京メトロ千代田線の各駅から常磐線方面へ行く利用者向けに、発駅の「綾瀬方面」時刻表を表示する。常磐線へ直通しない綾瀬行き・北綾瀬行きは折りたたんで表示する（消さずに、タップで開ける）。

- 対象：東京メトロ千代田線、綾瀬方面のみ
- 対象駅：代々木上原（C01）〜北千住（C18）の18駅。綾瀬（C19）・北綾瀬（C20）は対象外
- 表示言語：日本語のみ

開発者はコーディングを勉強中。変更の意図や仕組みは、わかりやすく説明しながら進めること。

## 全体構成

| 役割 | 担当 | 備考 |
|---|---|---|
| 時刻表データの取得・加工 | GitHub Actions + Python | 毎日1回、自動実行 |
| 画面と時刻表JSONの配信 | Cloudflare Pages（`○○.pages.dev`） | 独自ドメインは使わない |
| 運行情報の中継 | Cloudflare Workers | ODPTトークンを隠す。60秒キャッシュ |

開発者はCloudflareを使ったことがない。Cloudflare関連の設定は、手順を一つずつ説明しながら進めること。

## 開発環境

- Windows PC。Claude CodeはDockerコンテナ内で動かしている
- 改行コードは`.gitattributes`でLFに統一する（`* text=auto eol=lf`）
- `wrangler login`（ブラウザでの認証）はコンテナ内で使えない場合がある。Cloudflareは**APIトークンを環境変数**（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）で渡す方式にする
- ODPTのアクセストークンは`.env`に置き、Gitに含めない（`.gitignore`に追加）。コードやログに出力しない

## データソース

すべてODPT（公共交通オープンデータセンター）。ライセンス：公共交通オープンデータ基本ライセンス（https://developer.odpt.org/terms ）。画面に出典を表記すること。

### 時刻表：東京メトロ GTFS（これだけを使う）

```
https://api.odpt.org/api/v4/files/TokyoMetro/data/TokyoMetro-Train-GTFS.zip?acl:consumerKey=<ODPT_TOKEN>
```

駅時刻表JSON（`odpt:StationTimetable`）は使わない（データが古く、行き先がID表記のため）。

#### 確認済みのデータの特徴（2026-10-08版で確認）

- 有効期間：`feed_info.txt`の`feed_start_date`〜`feed_end_date`（確認時は20260919〜20270312）
- 千代田線は`routes.txt`で`route_long_name == "千代田線"`（確認時は`route_id = 5`）。IDは固定せず名前で探すこと
- 綾瀬方面は`direction_id == 0`
- 駅は`stops.txt`の`stop_code`（`C01`〜`C18`）で特定する（確認時は`stop_id` 501〜518）
- `service_id`：`0`＝平日、`1`＝土休日。祝日は`calendar_dates.txt`に例外日として登録済み（平日ダイヤを止めて土休日ダイヤを走らせる形）
- 行き先は`trips.txt`の`trip_headsign`（日本語の最終行き先）。綾瀬方面の値：我孫子・取手・柏・松戸・綾瀬・北綾瀬・北千住
- 時刻は24時を超えて書かれる（例：`24:48:00`）

#### 特急（小田急ロマンスカー、北千住行き）

- 平日3本、土休日4本。**時刻表には表示しない**が、データとしては保持する（通過情報は将来使う）
- 判定方法：その便の`stop_times`に、時刻が空欄の行（通過駅）がある便を「特急」とする
- 通過駅の行は`arrival_time`・`departure_time`が空欄、`pickup_type = 1`、`drop_off_type = 1`
- **車両区分の`E`（小田急）では判定しないこと**。小田急の車両は各駅停車にも使われている

#### 列車番号と車両区分

- `trip_id`の形式：`[路線1桁][ダイヤ1桁][A|B][数字4桁][S|K|E][2桁]`（例：`50B0607E00`）
- 中央部分が列車番号。ゼロを除くと公式の列車番号になる（`B0535S` → `B535S`。駅時刻表JSONの`trainNumber`と259件すべて一致を確認済み）
- 末尾の英字が車両の所属：`S`＝東京メトロ、`K`＝JR東日本、`E`＝小田急。この3種類のみのはず
- 将来アイコン表示に使うので、各便に車両区分を持たせる。想定外の値の場合はActionsのログに警告を出す

### 運行情報：東京メトロ 運行情報API

```
https://api.odpt.org/api/v4/odpt:TrainInformation?odpt:operator=odpt.Operator:TokyoMetro&acl:consumerKey=<ODPT_TOKEN>
```

千代田線（`odpt.Railway:TokyoMetro.Chiyoda`）の分だけを取り出して返す。路線での絞り込みパラメータが使えるかは実データで確認すること。

## データ加工の仕様（`scripts/build_timetable.py`）

1. GTFSのzipをダウンロードする（トークンは環境変数`ODPT_TOKEN`から読む）
2. 前回と内容が同じなら終了する（zipのハッシュ、または`feed_version`で比較）
3. 千代田線・`direction_id == 0`・C01〜C18の発車時刻を抽出する
   - 時刻が空欄の行（通過）は、その駅の時刻表に含めない
   - `pickup_type == 1`（乗車不可）の行は含めない（北千住止まりの便の北千住など）
4. 各便に次の情報を付ける：時刻、行き先、行き先の分類、車両区分、列車番号、特急かどうか
5. 駅ごとにJSONを出力する（`public/data/C11.json`など）
6. 日付ごとのダイヤ対応表を出力する（`public/data/calendar.json`）。`calendar.txt`と`calendar_dates.txt`を合成し、実行日から90日分
7. 列車ごとの詳細時刻を出力する（`public/data/trips.json`）。C01〜C20（綾瀬・北綾瀬を含む）の停車駅と時刻。**GTFSには綾瀬より先（JR常磐線内）の時刻は含まれない**。現在は画面で使っていない（将来の拡張用）

`feed_end_date`まで30日を切ったら、Actionsのログに警告を出す（3月のダイヤ改正前の確認用）。

### 行き先の表示名と分類

設定ファイル（`scripts/destinations.json`など）で管理する。県名は付けない。

| `trip_headsign` | 表示名 | 分類（`category`） |
|---|---|---|
| 我孫子 | 我孫子 | `joban`（常磐線直通） |
| 取手 | 取手 | `joban` |
| 柏 | 柏 | `joban` |
| 松戸 | 松戸 | `joban` |
| 綾瀬 | 綾瀬 | `ayase` |
| 北綾瀬 | 北綾瀬 | `kitaayase` |
| 北千住 | 北千住 | `kitasenju`（特急のみ） |

対応表にない行き先が出てきたら、地名をそのまま表示名にし、分類を`unknown`として、ログに警告を出す。

### 出力JSONの例

`public/data/C11.json`

```json
{
  "station": { "code": "C11", "name": "大手町" },
  "feed_version": "20261008",
  "services": {
    "weekday": [
      {
        "time": "13:09",
        "dest": "我孫子",
        "category": "joban",
        "type": "各駅停車",
        "trip_id": "50B1309K00",
        "train_number": "B1309K",
        "operator": "K",
        "limited_express": false,
        "origin": false
      }
    ],
    "holiday": []
  }
}
```

- `time`はGTFSの時刻をそのまま`HH:MM`にする（`24:12`のまま）
- 特急も`limited_express: true`として出力する（画面側で除外する）
- `type`は特急なら`"特急"`、それ以外は`"各駅停車"`
- `trip_id`は`trips.json`の詳細時刻を引くためのキー
- `origin`は当駅始発かどうか（その便の最初の停車駅）。**代々木上原では常に`false`**：データ上は全便が代々木上原から始まるが、小田急線からの直通便を区別できないため

`public/data/trips.json`（容量を抑えるため、インデントなしで出力）

```json
{ "feed_version": "20261008", "stations": { "C01": "代々木上原" }, "trips": { "50B0547S00": [["C01", "05:00"], ["C19", "05:39"]] } }
```

`public/data/calendar.json`

```json
{ "2026-10-16": "weekday", "2026-11-03": "holiday" }
```

## 画面の仕様

### 時刻表の表示（リスト形式）

```
13時
13:04　各駅停車　北綾瀬 行き
13:09　各駅停車　我孫子 行き
13:14　各駅停車　綾瀬 行き
```

- 時ごとの見出しの下に、1便1行で並べる。行き先は略さない
- 行き先のチェックボックス（見出しは「表示しない行き先」。松戸・柏・我孫子・取手・綾瀬・北綾瀬）で、チェックした行き先を**折りたたむ**。続けて並ぶ便は1つにまとめ、普段は点線と「◯本」だけを表示し、タップで開く
- 初期状態は綾瀬・北綾瀬にチェック。選択は`localStorage`に保存する
- 当駅始発の便は、行き先の後ろに「当駅始発」と表示する
- 各行に分類と車両区分のクラスを付ける（例：`class="train cat-joban op-K"`）
- 時刻の数字はBarlow（`public/fonts/`、SIL OFL）で大きく表示する
- 色などのデザインは後で調整する。最初はシンプルでよい
- 特急（`limited_express: true`）は表示しない
- 車両区分のアイコンを、時刻と「各駅停車」の間に表示する（`public/icons/train-s.png`・`train-k.png`・`train-e.png`）

### 表示開始位置

- 初電からではなく、**現在時刻に近い列車から表示する**（Yahoo!乗換案内アプリのような形）
- 現在時刻の直前の1本程度から表示し、それより前は「前の時刻を表示」で見られるようにする
- 「次の直通電車 あと◯分」のような表示は不要

### 24時以降の扱い

- 1日の区切りは**午前3時**。0:00〜2:59は前日の運行日として扱う
- 例：10/17の0:30に開いた場合は、10/16のダイヤの24:30以降を表示する
- 24時台の便は「0時」の見出しに入れ、`24:12`は`0:12`と表示する

### その他

- 駅は選択式（C01〜C18）。前回選んだ駅を`localStorage`に保存する（使えない環境でも動くようにする）。初回は代々木上原（C01）
- 平日・土休日は`calendar.json`で自動判定し、手動でも切り替えられる
- 運行情報（千代田線）を時刻表の上に表示する。時刻は「13:58 現在」の形で表示する（ODPTのデータ作成時刻）。取得できない場合は「運行情報を取得できません」と出し、時刻表は表示を続ける
- 出典（公共交通オープンデータセンター）を表記する

### PWA

- `manifest.json`とService Workerを用意する
- 時刻表JSONと画面のファイルをキャッシュし、オフラインでも時刻表を見られるようにする
- 運行情報はキャッシュしない（オフライン時は取得できない旨を表示）

## Workerの仕様（`worker/`）

- ODPTのトークンは`wrangler secret put ODPT_TOKEN`で登録する（コードに書かない）
- 運行情報APIを呼び、千代田線の分だけを整形して返す
- 60秒キャッシュする
- CORSは公開先（Pagesのドメイン）と開発用のlocalhostのみ許可する

## GitHub Actions（`.github/workflows/`）

- 毎日1回（深夜）実行する。手動実行（`workflow_dispatch`）もできるようにする
- `ODPT_TOKEN`はGitHubのSecretsに登録する
- データに変更があれば、`public/data/`をコミットしてpushする（Cloudflare Pagesが自動で再公開）

## ディレクトリ構成（案）

```
.
├── CLAUDE.md
├── .gitattributes
├── .gitignore
├── .env.example          # ODPT_TOKEN=（値は空）
├── scripts/
│   ├── build_timetable.py
│   ├── destinations.json
│   └── requirements.txt
├── public/               # Cloudflare Pagesで公開
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── manifest.json
│   ├── sw.js
│   └── data/             # Actionsが生成
├── worker/               # Cloudflare Workers
│   ├── src/index.js
│   └── wrangler.toml
└── .github/workflows/update-timetable.yml
```

## 進める順番

1. リポジトリの初期設定（`.gitattributes`、`.gitignore`、`.env.example`）
2. `build_timetable.py`を作り、手元で実行してJSONを確認する
3. 画面（リスト表示、駅選択、平日/土休日、現在時刻からの表示）
4. PWA化（manifest、Service Worker）
5. Workerで運行情報の中継を作り、画面に表示する
6. Cloudflare Pagesで公開する（開発者と一緒に設定）
7. GitHub Actionsで毎日自動更新する

各ステップで動作を確認してから次に進むこと。

**1〜7はすべて完了（2026-10-19）**。現在は画面の細かい修正を随時行っている段階。

## 公開先と運用

| 対象 | アドレス・場所 |
|---|---|
| アプリ（Cloudflare Pages） | https://chiyoda-timetable.pages.dev/ |
| 運行情報の中継（Worker `chiyoda-train-info`） | https://chiyoda-train-info.train-management.workers.dev/ |
| GitHub | https://github.com/akiraoikawap45-lang/chiyoda-timetable （Public） |

- **画面（`public/`）の変更**：GitHubにpushすると、Pagesが自動で公開し直す（GitHub連携）
- **Worker（`worker/`）の変更**：pushでは反映されない。`worker/`で`npx wrangler deploy`を実行する
  - Cloudflareの認証情報は`worker/.env`（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）。手元のWorker用のODPTトークンは`worker/.dev.vars`。どちらもGitに含めない
  - Workerを公開し直すときに`ALLOWED_ORIGINS`（`wrangler.toml`）を確認する
- **GitHub Actions**が毎日 午前4時（JST）にデータを更新してmainにコミットする。**作業の前とpushの前に`git pull`する**
- GitHubへのpushは`gh`（GitHub CLI）のログインを使う。コンテナを作り直すと`gh`とログインが消えるので、`sudo apt-get install gh`のあと、`gh auth login --web`（デバイス認証。`workflow`の権限が必要）でログインし直し、`gh auth setup-git`を実行する
- コミットの作者メールは非公開用（`344570276+akiraoikawap45-lang@users.noreply.github.com`、リポジトリの`git config`に設定済み）
- 画面のファイル構成を変えたら、`public/sw.js`の`CACHE_NAME`の番号を上げ、`PRECACHE_FILES`を見直す
- 開発者はスマホで動作確認する。Service Workerの仕組みで、反映には2回の開き直しが必要なことがある

## 将来の拡張候補（今は作らない）

- JR常磐線の運行状況の表示（JR東日本はGTFS-RTのみ提供で、常磐線は羽鳥以南が対象。「公共交通オープンデータチャレンジ限定ライセンス」の条件確認が必要）
- 特急の通過情報の活用
- 列車をタップして、終点までの各駅の時刻を表示する（`trips.json`を使う。JR常磐線内の時刻がないため一旦見送り）
