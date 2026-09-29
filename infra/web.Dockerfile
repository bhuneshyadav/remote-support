FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

COPY apps/web apps/web
COPY packages/contracts packages/contracts

ARG VITE_API_BASE_URL=
ARG VITE_ICE_SERVERS=[]
ARG VITE_ALLOW_LOCAL_DEV_BYPASS=false
ARG VITE_OIDC_AUTHORITY
ARG VITE_OIDC_CLIENT_ID
ARG VITE_OIDC_API_AUDIENCE
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_ICE_SERVERS=$VITE_ICE_SERVERS
ENV VITE_ALLOW_LOCAL_DEV_BYPASS=$VITE_ALLOW_LOCAL_DEV_BYPASS
ENV VITE_OIDC_AUTHORITY=$VITE_OIDC_AUTHORITY
ENV VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID
ENV VITE_OIDC_API_AUDIENCE=$VITE_OIDC_API_AUDIENCE

RUN npm run build --workspace @remote-support/contracts \
    && npm run build --workspace @remote-support/web

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
