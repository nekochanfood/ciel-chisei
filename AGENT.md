# AGENT.md

This repository is **ciel-chisei**, a TypeScript bot for [bettaworx/ciel](https://github.com/bettaworx/ciel). It behaves like [知性bot](https://chisei.xemono.life/): no generative LLM, learn tokens from the public timeline, reply when mentioned.

## Non-negotiables

- Do **not** add ChatGPT / Claude / other LLM calls for speech.
- Auth is an **access token** (JWT) from `config.yaml` (`ciel.accessToken`). There is no `.env`; never implement password/SCRAM login unless the user asks.
- Talk to Ciel only through the generated OpenAPI client for REST. Regenerate types with `npm run gen:openapi` when the Ciel spec changes.
- Keep replies as Ciel posts with `parentId` set to the mention. Max content length is 300.
- Never commit `config.yaml` (it holds the access token). Only `config.yaml.example` is committed.

## Layout

```
ciel-chisei/
├── config.yaml.example      # copy to config.yaml and edit; config.yaml is gitignored
├── scripts/sync-openapi.mjs # fetch packages/api from GitHub, run openapi-typescript
├── prisma/                  # Prisma schema + committed migrations
├── src/
│   ├── index.ts             # entry: db, backfill, bio sync, ws + poll + solo timers
│   ├── config.ts            # YAML-only config (zod). --config flag > CONFIG_PATH > ./config.yaml
│   ├── config.test.ts       # YAML loading, defaults, missing-file error, --config parsing
│   ├── db.ts                # Prisma Client + PostgreSQL adapter
│   ├── health.ts            # GET /healthz
│   ├── generated/api.d.ts   # generated; do not hand-edit
│   ├── ciel/client.ts       # openapi-fetch wrapper (GET /me, /timeline, POST /posts, reactions, PATCH /me/profile)
│   ├── ciel/websocket.ts    # ws(s)://.../ws/events with Origin + ciel_auth cookie
│   └── bot/
│       ├── chisei.ts        # learn + opt-out/in + mention reply + solo post + bio sync
│       ├── language.ts      # curated templates + vocabulary + neural candidate ranker
│       ├── tokenizer.ts     # mfm-js parsing + kuromoji morphemes w/ POS (Intl.Segmenter fallback)
│       └── text.ts          # mention detection, opt commands, reply formatting, formatBio
├── Dockerfile               # never COPY config.yaml; runtime reads the mounted file
└── docker-compose.yml.example # copy to docker-compose.yml (gitignored); bot + PostgreSQL
```

## Ciel API facts agents must not rediscover the hard way

- REST base: `{ciel.apiBaseUrl}/api/v1` (OpenAPI `servers[0].url` is `http://localhost:6137/api/v1`).
- Auth header: `Authorization: Bearer <access token>` (+ `ciel_auth` cookie for WS).
- WebSocket: `{origin}/ws/events`. Ciel **rejects** handshakes without a matching `Origin` (`ciel.wsOrigin` must be in Ciel `ALLOWED_ORIGINS`). Authenticate with the `Authorization: Bearer` header (query-string tokens are not supported). Do **not** send the `ciel_auth` cookie: with opaque tokens (`ciel_at_...`) a present-but-invalid cookie fails closed with 401 even when Bearer is valid. Same rule applies to REST.
- Timeline events: JSON `{ "type": "post_created", "post": { ... } }` and `{ "type": "post_deleted", "postId": "..." }`.
- `Post.mentions[]` lists `@username` targets. `CreatePostRequest.parentId` creates a reply.
- `GET /timeline` is public/paginated (`limit`, `cursor`). Use it for backfill and as a WS fallback.
- `GET /users/{username}/posts` is paginated and backfills the bot's own speech history at startup.
- Reactions: `POST /posts/{postId}/reactions` with `{ "emoji": "👍" }`; `409` means already reacted (treated as success).
- Bio: `PATCH /me/profile` with `{ "bio": "..." }`.

OpenAPI lives in the Ciel repo at `packages/api/openapi.yml` with `$ref`s under `packages/api/paths` and `packages/api/schemas`. This project vendors that tree into `vendor/ciel-api/` at generate time (gitignored).

## Commands

```bash
cp config.yaml.example config.yaml             # then edit ciel.accessToken / database.url
cp docker-compose.yml.example docker-compose.yml # real compose file is gitignored
npm install
npm run gen:openapi    # network: GitHub tarball + openapi-typescript
npm run db:migrate     # create/apply a development migration
npm run db:studio      # inspect the YAML-configured database
npm test               # vitest
npm run typecheck
npm run lint
npm run dev            # tsx watch (reads ./config.yaml)
npx tsx src/index.ts --config /path/to/config.yaml
npm run build && npm start -- --config ./config.yaml
docker compose up --build
```

## Database

PostgreSQL, managed by the committed Prisma migrations and applied before boot:

- `learned_posts(post_id, author_id, learned_at)` — skip duplicate learning
- `replied_posts(post_id, reply_id, replied_at)` — skip duplicate replies
- `lexemes(surface, pos, detail, basic_form, conjugation, count)` — vocabulary used to fill curated slots
- `sentence_features(post_id, sentence_index, author_id, features)` — interpretable training features
- `neural_models(id, version, example_count, state)` — persisted weights for the candidate ranker
- `learning_blacklist(user_id, created_at)` — opt-out list (`学習禁止` / `学習許可`)

Do not introduce a second data store. Change tables through `prisma/schema.prisma` and a committed Prisma migration.

## Changing speech behavior

- Tokenization: `src/bot/tokenizer.ts` (mfm-js strips mentions/URLs/code/decorators; unicode emoji + `:custom_emoji:` are dropped; terminal `www` / `草` are removed from lexical tokens and learned as style features). kuromoji supplies POS/basic forms, with `Intl.Segmenter` fallback.
- Generation: `src/bot/language.ts`. More than 100 curated casual-Japanese templates own all grammar and particles. Learned nouns, base-form verbs/adjectives, and adverbs only fill declared slots. A dependency-free 54→16→1 ReLU network ranks 24 candidates from context, length, POS, seed overlap, family, and decoration. Before 20 examples it uses the deterministic heuristic portion. The source corpus never supplies templates.
- Mention rules: `src/bot/text.ts` `isMentionForBot`. Default is mention-only. `bot.wakeWords` (YAML array) adds extra substrings.
- Opt commands: `parseOptCommand` requires a mention of the bot plus exactly `学習禁止|学習拒否|オプトアウト` (opt-out) or `学習許可|学習再開|オプトイン` (opt-in). Handled in `ChiseiBot.handlePost` before learning, acknowledged with a 👍 reaction.
- Bio: `formatBio(vocabularySize, lastLearnedAt)` in `src/bot/text.ts`; `ChiseiBot.syncBio()` PATCHes only when the count or timestamp changes.
- Solo posts and replies use the same template generator. Reply length follows `replyLengthFactor` / min / max; longer targets compose up to three template sentences. Every final reply, including its mention, is clipped to Ciel's 300-character limit.
- Fallback phrases live in `src/bot/text.ts`. They are recorded in `learned_posts` but never added to vocabulary or training features.

When you change templates/features/reply formatting, update `src/bot/language.test.ts` / `src/bot.test.ts`. When you change config keys, update `src/config.test.ts`, both example configs, and the README reference table.

## Docker / GitHub deploy notes

- Compose `bot` runs `npm start -- --config /app/config.yaml`, applies Prisma migrations, and mounts `./config.docker.yaml:/app/config.yaml:ro`. Every boot runs `migrate deploy`; reset speech learning with `npm run db:reset-learning` (`db:reset-markov` remains an alias).
- Local dev uses `config.yaml` (`localhost` URLs). Docker uses `config.docker.yaml`: Ciel at `host.docker.internal:6137`, DB at `postgres://ciel_chisei:ciel_chisei@db:5432/ciel_chisei`. Never use `localhost` inside the container (it points at the container itself).
- Keep `server.port` at `8080` under Docker (matches `ports: "8080:8080"`).
- Image build runs `npm run gen:openapi` if the network can reach GitHub; otherwise committed `src/generated/api.d.ts` is used. After a Ciel API change, regenerate and commit the types.
- Health check path: `GET /healthz`.

## Typical follow-up tasks

1. Ciel OpenAPI changed → `npm run gen:openapi`, fix `src/ciel/client.ts` compile errors, commit `src/generated/api.d.ts`.
2. Tone selection looks wrong → inspect `sentence_features` and the `neural_models.example_count`; the heuristic is intentionally used for the first 20 examples.
3. P2021 table does not exist at boot → migrations never applied: check `migrate status`, redeploy (`up --build`), and make sure the compose `command` still goes through `npm start`. `assertSchemaReady()` in `src/db.ts` reports the missing tables explicitly.
4. P3005 (database is not empty) on `migrate deploy` → pre-Prisma tables exist: baseline with `migrate resolve --applied "20260921120000_adopt_existing_schema"` (one-off `compose run --rm bot ...`), then redeploy. Never `down -v` (loses `replied_posts`/`learning_blacklist`). The markov_sequences migration is baseline-safe: it backfills missing tables/columns and guards its DELETEs.
3. WS never connects → check Ciel `ALLOWED_ORIGINS` vs `ciel.wsOrigin`; polling should still learn/reply.
4. Token rejected → user must paste a fresh **access** JWT into `ciel.accessToken` in `config.yaml`. Refresh-cookie flow is not implemented.
5. `Config file not found` at boot → copy `config.yaml.example` to the resolved path (`--config`, `CONFIG_PATH`, or `./config.yaml`).
6. Solo posts too chatty/quiet → adjust `bot.soloPostIntervalMinutes` (`0` disables) and `bot.soloPostRate`. Mention replies too chatty → lower `bot.replyRate`. Reply length off → tune `bot.replyLengthFactor` / `bot.replyMinTokens` / `bot.replyMaxTokens`.
