FROM node@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS build
WORKDIR /app
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian13@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY preview.mjs ./preview.mjs
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "preview.mjs"]
