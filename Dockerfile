FROM node@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9 AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
    && rm -rf node_modules/better-sqlite3/prebuilds \
    && cd node_modules/better-sqlite3 \
    && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release --nodedir=/usr/local \
    && cd /app \
    && npm cache clean --force

FROM node@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./

COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY schemas ./schemas

CMD ["npm", "test"]
