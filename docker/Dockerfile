# syntax=docker/dockerfile:1

# --- etapa de build: compila TypeScript con todas las dependencias ---
FROM node:24-alpine AS build
WORKDIR /build

COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/tsconfig.json ./
COPY app/src ./src
RUN npm run build

# Reinstala sólo dependencias de producción para copiarlas a la imagen final.
RUN npm ci --omit=dev

# --- etapa final: sólo lo necesario para correr ---
FROM node:24-alpine AS runtime
WORKDIR /srv

ARG GIT_SHA=dev
ARG APP_VERSION=1.0.0
ENV NODE_ENV=production \
    PORT=3000 \
    GIT_SHA=$GIT_SHA \
    APP_VERSION=$APP_VERSION

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY app/public ./public
COPY app/package.json ./package.json

# node:alpine ya trae el usuario 'node' sin privilegios.
USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
