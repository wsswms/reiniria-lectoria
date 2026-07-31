FROM node@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ENV NODE_ENV=test \
    PI_OFFLINE=1 \
    HOME=/tmp/runner-home

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
# pi-coding-agent 0.83.0 ships an npm shrinkwrap that pins vulnerable brace-expansion 5.0.7.
# Overlay the audited 5.0.8 patch because root npm overrides do not replace nested shrinkwrap content.
RUN npm pack --silent brace-expansion@5.0.8 --pack-destination /tmp \
    && tar -xzf /tmp/brace-expansion-5.0.8.tgz \
      -C node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion \
      --strip-components=1 \
    && node -e 'const p=require("./node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json"); if(p.version!=="5.0.8") process.exit(1)'

COPY src ./src
COPY tests ./tests
COPY scripts ./scripts

USER 65532:65532

CMD ["npm", "test"]
