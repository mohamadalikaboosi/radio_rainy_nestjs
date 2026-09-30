# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
RUN pnpm build
# production dependencies only
RUN pnpm --filter @radio_rainy/api --prod --legacy deploy /out/api

FROM node:22-bookworm-slim
# ffmpeg: format conversion, Whisper audio (mono FLAC) and the Telegram live stream (RTMPS)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 TMP_DIR=/tmp/radio_rainy ADMIN_UI_DIR=/app/admin
WORKDIR /app/api
COPY --from=build /out/api/ ./
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/admin/dist /app/admin
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/radio/stations" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
