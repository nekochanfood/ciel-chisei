FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl tar \
  && rm -rf /var/lib/apt/lists/*

# config.yaml は絶対に COPY しない (アクセストークンを含むため)。
# 実行時は --config /app/config.yaml で、compose の volumes から
# read-only マウントした実ファイルを読む。イメージに設定はバンドルしない。
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
# migration.test.ts がデプロイ経路を検証するために参照する (テスト専用、runtime には含めない)
COPY Dockerfile docker-compose.yml.example ./

RUN npm ci
# Refresh types from Ciel OpenAPI when the network is available.
# The committed src/generated/api.d.ts is used if this step fails.
RUN npm run gen:openapi || echo "openapi refresh skipped; using committed types"
RUN npm test
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/generated ./src/generated

USER node
EXPOSE 8080
CMD ["npm", "start"]
