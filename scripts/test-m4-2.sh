#!/bin/sh
set -eu

: "${DOCKER_BIN:=docker}"
APP_IMAGE=reiniria-lectoria-m4:local
RUNNER_IMAGE=reiniria-lectoria-runner-m4:local

"$DOCKER_BIN" build --platform linux/arm64 --tag "$APP_IMAGE" .
"$DOCKER_BIN" build --platform linux/arm64 --file Dockerfile.runner --tag "$RUNNER_IMAGE" .

"$DOCKER_BIN" run --rm \
  --platform linux/arm64 \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=768m \
  --cap-drop ALL \
  --cap-add SETUID \
  --cap-add SETGID \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 1024m \
  --cpus 1 \
  "$APP_IMAGE" npm run test:m4.2

"$DOCKER_BIN" run --rm --platform linux/arm64 --network none "$APP_IMAGE" node scripts/m4-2-runner-task-fixture.mjs | \
"$DOCKER_BIN" run --rm --interactive \
  --platform linux/arm64 \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 \
  --memory 256m \
  --cpus 0.5 \
  "$RUNNER_IMAGE"

"$DOCKER_BIN" run --rm \
  --platform linux/arm64 \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 \
  --memory 256m \
  --cpus 0.5 \
  "$RUNNER_IMAGE" src/runner/boundary-probe.mjs
