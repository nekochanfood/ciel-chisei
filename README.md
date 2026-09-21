# ciel-chisei

Ciel（[bettaworx/ciel](https://github.com/bettaworx/ciel)）向けの、知性bot 風おしゃべりボットです。

生成AIや外部LLMは使いません。全体タイムラインから語彙と話し方の特徴を覚え、正常な手書きテンプレートと小型ニューラル評価器で話します。`@ボット名` でメンションされると元投稿へのリプライとして返事します。

参考: [知性bot](https://chisei.xemono.life/)

## できること

- Ciel の OpenAPI（`packages/api/openapi.yml`）から TypeScript 型を自動生成し、そのクライアントで REST を叩く
- `/ws/events` で `post_created` を購読（失敗時は `/timeline` ポーリングで継続）
- 設定は `config.yaml` のみ（`.env` は使わない）
- タイムラインの投稿本文に加え、自分の過去・手動・自動投稿も学習
- `@ボット名 学習禁止` / `@ボット名 学習許可` でオプトアウト管理。処理後に👍リアクション
- mfm-js で MFM をパースしてから学習（メンション・URL・コード・絵文字を除外）
- kuromoji で日本語を形態素＋品詞に分割し、文単位で語彙と特徴を学習
- 100種類以上の手書きテンプレートへ学習語彙を充当し、文法とくだけたネット口調を維持
- 小型ニューラル評価器が入力文・長さ・品詞・装飾に合う候補を選択
- `！` / `？` / `！？` / `…` / `〜` / 括弧 / `www` / `草` を装飾として認識・生成
- プロフィールの自己紹介に `覚えた言葉: N` を自動反映
- 定期的な独り言（分単位で調整可、`0` で無効化）
- 学習語彙・文特徴・評価器の重み・返信履歴を PostgreSQL に保存し、Prisma で管理
- Docker Compose でデプロイ（設定ファイルは read-only マウント、イメージにバンドルしない）

## 必要環境

- Node.js 22+
- Docker（本番・まとめて起動する場合）
- Ciel 上のボット用アカウントと **アクセストークン**

アクセストークンは Ciel のログイン後に発行される JWT です。`Authorization: Bearer` と、WebSocket 用の `ciel_auth` Cookie の両方に載せます。パスワードログイン（SCRAM）は実装していません。

## セットアップ

```bash
cp config.yaml.example config.yaml
# config.yaml を編集 (ciel.accessToken / database.url など)
npm install
npm run gen:openapi
npm test
npm run dev
# 別パスの設定を読む場合: npm run dev -- --config /path/to/config.yaml
```

`ciel.wsOrigin` は Ciel 側の `ALLOWED_ORIGINS`（または `PUBLIC_BASE_URL`）に含まれる Origin にしてください。Ciel の WebSocket は Origin ヘッダ必須です。

`config.yaml` はアクセストークンを含むため git にコミットしないでください（`.gitignore` 済み）。

## config.yaml リファレンス

| キー | 必須 | 既定 | 説明 |
| --- | --- | --- | --- |
| `ciel.apiBaseUrl` | yes | – | Ciel バックエンド origin。`http://localhost:6137` または `.../api/v1` |
| `ciel.accessToken` | yes | – | ボットアカウントのアクセストークン（JWT）。コミット厳禁 |
| `ciel.wsOrigin` | no | `http://localhost:3000` | WebSocket の `Origin` ヘッダ |
| `ciel.wsUrl` | no | `{origin}/ws/events` | 上書き用 |
| `database.url` | yes | – | PostgreSQL 接続文字列 |
| `bot.wakeWords` | no | `[]` | メンション以外でも反応する語。空ならメンションのみ |
| `bot.pollIntervalMs` | no | `15000` | WS 切断時の `/timeline` ポーリング間隔 |
| `bot.timelineBackfillPages` | no | `5` | 起動時に遡って学習するページ数（1ページ=30件） |
| `bot.soloPostIntervalMinutes` | no | `120` | 独り言の間隔（分）。`0` で無効化 |
| `bot.replyRate` | no | `1` | メンション・合言葉への返信確率（0..1）。学習は確率に関わらず行う |
| `bot.soloPostRate` | no | `1` | 独り言タイマー tick ごとの投稿確率（0..1） |
| `bot.replyLengthFactor` | no | `1` | 返信の長さ＝相手の文のトークン数×係数。min/max で丸める |
| `bot.replyMinTokens` | no | `2` | 返信の最小トークン数 |
| `bot.replyMaxTokens` | no | `24` | 返信の最大トークン数 |
| `server.port` | no | `8080` | ヘルスチェック HTTP ポート。Docker では `8080` のままにすること |
| `logLevel` | no | `info` | `debug` / `info` / `warn` / `error` |

設定ファイルのパス解決: `--config <path>` → `CONFIG_PATH` 環境変数 → `./config.yaml` → `./config.yml`。

## データベース管理

起動時に未適用の Prisma migration が自動適用されます。手動で管理する場合も、接続先は `.env` ではなく同じ YAML を使います。

```bash
npm run db:migrate   # schema変更から開発用migrationを作成・適用
npm run db:deploy    # 作成済みmigrationを適用
npm run db:studio    # Prisma Studioを開く
npm run db:validate  # Prisma schemaを検証
```

別の設定ファイルを使うDBコマンドでは `CONFIG_PATH=/path/to/config.yaml` を指定します。

## Docker

```bash
cp config.yaml.example config.yaml                       # ローカル開発用
cp docker-compose.yml.example docker-compose.yml         # Docker 用 compose 定義
cp config.docker.yaml.example config.docker.yaml         # Docker 用設定 (トークン記入)
docker compose up --build
```

`config.yaml` / `config.docker.yaml` / `docker-compose.yml` の実ファイルは git 管理外です（example をコピーして使う運用）。ローカル開発は `config.yaml`（`localhost` 参照）、Docker 内は `config.docker.yaml`（Ciel 本体=`host.docker.internal`、DB=`db` 参照）を使います。コンテナ内から `localhost` は自分自身を指すため、この使い分けが必要です。

- ホストの `./config.yaml` をコンテナの `/app/config.yaml` に read-only マウントして読みます。
- イメージに `config.yaml` は含めません（`.dockerignore` で除外、`Dockerfile` で `COPY` しない）。
- ボットは `:8080/healthz` で生存確認できます。Compose 内の PostgreSQL に語彙を保存します。Ciel 本体はこのリポジトリには含まれません。
- 起動時は必ず `migrate deploy` が走るため、ローカル・Docker どちらのデプロイでも未適用 migration（kuromoji 移行時の学習データ全消去を含む）が自動適用されます。`--build` 付きで起動すること。
- 消去が取り残された場合は手動で消去できます（再起動後に学び直します）:
  ```bash
  npm run db:reset-learning -- --config ./config.yaml
  docker compose exec bot npm run db:reset-learning -- --config /app/config.yaml
  ```

## OpenAPI 型生成

```bash
npm run gen:openapi
```

GitHub の `bettaworx/ciel`（既定ブランチ `main`）から `packages/api` を取得し、`openapi-typescript` で `src/generated/api.d.ts` を作ります。

上書きする場合:

- `CIEL_OPENAPI_REF` … git ref（既定 `main`）
- `CIEL_OPENAPI_TARBALL` … tarball URL の直接指定

## 振る舞い

1. 起動時に `GET /me` で自分のユーザーを確認する
2. 自分の投稿履歴を全ページ、タイムラインを設定ページ数だけ遡って学習する
3. 以降、全体タイムラインの新規投稿本文を覚える（自分の投稿も人格として学習し、ブラックリスト登録者は除外）
4. `@ボット名 学習禁止` でブラックリスト登録、`@ボット名 学習許可` で除外し、いずれも👍リアクションで周知する
5. `mentions` に自分が含まれる、または本文に `@username` がある投稿へ、自分の言い回しを優先してリプライする
6. `bot.soloPostIntervalMinutes` 分おきに独り言を投稿する（`0` で無効化）
7. プロフィールの自己紹介を定期的に `覚えた言葉: N`＋`(最終更新: YYYY/MM/DD HH:mm:ss)` で更新する
8. 語彙が足りないうちは「……」「なにそれ」などの短い返事になる

投稿上限は Ciel と同じ 300 文字です。
