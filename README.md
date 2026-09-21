# ciel-chisei

Ciel（[bettaworx/ciel](https://github.com/bettaworx/ciel)）向けの、知性bot 風おしゃべりボットです。

生成AIは使いません。全体タイムラインの文章を覚えてマルコフ連鎖で話し、`@ボット名` でメンションされると返事します。会話は元投稿へのリプライとして投稿します。

参考: [知性bot](https://chisei.xemono.life/)

## できること

- Ciel の OpenAPI（`packages/api/openapi.yml`）から TypeScript 型を自動生成し、そのクライアントで REST を叩く
- `/ws/events` で `post_created` を購読（失敗時は `/timeline` ポーリングで継続）
- 設定は `config.yaml` のみ（`.env` は使わない）
- タイムラインの投稿本文を学習（自分の投稿・ブラックリスト登録者は除外）
- `@ボット名 学習禁止` / `@ボット名 学習許可` でオプトアウト管理。処理後に👍リアクション
- mfm-js で MFM をパースしてから学習（装飾・メンション・URL・コードを除外、絵文字/カスタム絵文字 `:name:` は保持）
- BudouX で日本語を文節寄りに分割
- 学習元ユーザーを記憶し、その相手と話すときはその人の言葉を優先するパーソナライズ
- プロフィールの自己紹介に `覚えた言葉: N` を自動反映
- 定期的な独り言（分単位で調整可、`0` で無効化）
- 学習語彙と返信履歴を PostgreSQL に保存
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
# 別パスの設定を読む場合: npx tsx src/index.ts --config /path/to/config.yaml
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
| `server.port` | no | `8080` | ヘルスチェック HTTP ポート。Docker では `8080` のままにすること |
| `logLevel` | no | `info` | `debug` / `info` / `warn` / `error` |

設定ファイルのパス解決: `--config <path>` → `CONFIG_PATH` 環境変数 → `./config.yaml` → `./config.yml`。

## Docker

```bash
cp config.yaml.example config.yaml
# database.url を postgres://ciel_chisei:ciel_chisei@db:5432/ciel_chisei にする
docker compose up --build
```

- ホストの `./config.yaml` をコンテナの `/app/config.yaml` に read-only マウントして読みます。
- イメージに `config.yaml` は含めません（`.dockerignore` で除外、`Dockerfile` で `COPY` しない）。
- ボットは `:8080/healthz` で生存確認できます。Compose 内の PostgreSQL に語彙を保存します。Ciel 本体はこのリポジトリには含まれません。

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
2. タイムラインを数ページ遡って学習する
3. 以降、全体タイムラインの新規投稿本文を覚える（自分の投稿・ブラックリスト登録者は除外）
4. `@ボット名 学習禁止` でブラックリスト登録、`@ボット名 学習許可` で除外し、いずれも👍リアクションで周知する
5. `mentions` に自分が含まれる、または本文に `@username` がある投稿へリプライする（相手の言葉を優先）
6. `bot.soloPostIntervalMinutes` 分おきに独り言を投稿する（`0` で無効化）
7. プロフィールの自己紹介を定期的に `覚えた言葉: N` で更新する
8. 語彙が足りないうちは「……」「なにそれ」などの短い返事になる

投稿上限は Ciel と同じ 300 文字です。
