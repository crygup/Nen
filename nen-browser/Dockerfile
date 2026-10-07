FROM node:24-alpine AS build
WORKDIR /build
COPY app/package*.json ./app/
COPY nen-browser/package*.json ./nen-browser/
RUN npm ci --ignore-scripts --prefix app && npm ci --ignore-scripts --prefix nen-browser
COPY app/src ./app/src
COPY app/electron ./app/electron
COPY app/tsconfig.json ./app/
COPY nen-browser ./nen-browser
ARG NEN_COMMIT
ENV NEN_BUILD_COMMIT=$NEN_COMMIT
RUN cd nen-browser && ../app/node_modules/.bin/tsc --noEmit -p tsconfig.json && npm run build && npm run build:server

FROM node:24-alpine
WORKDIR /app
COPY --from=build /build/nen-browser/server.cjs .
COPY --from=build /build/nen-browser/dist ./dist
COPY LICENSE .
RUN mkdir /app/downloads /app/cache && chown node:node /app/downloads /app/cache
ENV NEN_CACHE_DIR=/app/cache
USER node
CMD ["node", "server.cjs"]
