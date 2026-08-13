FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libimage-exiftool-perl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production KIWI_HOST=0.0.0.0 KIWI_API_PORT=3333 KIWI_DATA_DIR=/data
COPY --from=build /app /app
EXPOSE 3333
CMD ["npm", "run", "start", "-w", "@kiwi/server"]
