FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

COPY apps/api apps/api
COPY packages/contracts packages/contracts
RUN npm run db:generate --workspace @remote-support/api \
    && npm run build --workspace @remote-support/contracts \
    && npm run build --workspace @remote-support/api

ENV NODE_ENV=production
EXPOSE 3001

USER node
CMD ["sh", "-c", "npm run db:deploy --workspace @remote-support/api && node apps/api/dist/server.js"]
