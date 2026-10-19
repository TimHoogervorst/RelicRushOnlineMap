FROM node:22.15.0-bookworm-slim AS build

ENV NODE_ENV=development \
    PORT=3000 \
    DATA_DIR=/data \
    MINECRAFT_CLIENT_JAR=/seed-assets/minecraft-client.jar
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY public ./public
COPY schematics ./schematics
COPY tsconfig.json ./tsconfig.json
RUN npm run typecheck && npm test

FROM node:22.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MINECRAFT_CLIENT_JAR=/seed-assets/minecraft-client.jar
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/schematics ./schematics

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "src/server.js"]
