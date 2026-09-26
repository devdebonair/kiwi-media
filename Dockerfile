FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/scanner/package.json apps/scanner/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/downloads/package.json packages/downloads/package.json
COPY packages/stash-box/package.json packages/stash-box/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ARG TARGETARCH=amd64
ARG WIREPROXY_VERSION=v1.1.3
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libimage-exiftool-perl ca-certificates curl && rm -rf /var/lib/apt/lists/*
# yt-dlp powers the default downloader; wireproxy runs WireGuard VPN profiles in userspace (no kernel VPN or root needed).
RUN curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$([ "$TARGETARCH" = arm64 ] && echo _aarch64)" \
  && chmod +x /usr/local/bin/yt-dlp \
  && curl -fsSL "https://github.com/windtf/wireproxy/releases/download/${WIREPROXY_VERSION}/wireproxy_linux_${TARGETARCH}.tar.gz" | tar -xz -C /usr/local/bin wireproxy
WORKDIR /app
ENV NODE_ENV=production KIWI_HOST=0.0.0.0 KIWI_API_PORT=3333 KIWI_DATA_DIR=/data
COPY --from=build /app /app
EXPOSE 3333
CMD ["npm", "run", "start", "-w", "@kiwi/server"]
