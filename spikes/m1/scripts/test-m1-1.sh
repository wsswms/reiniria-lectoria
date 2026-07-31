#!/bin/sh
set -eu

: "${DOCKER_BIN:=docker}"
IMAGE=reiniria-lectoria-m1-spike:local

"$DOCKER_BIN" build --platform linux/arm64 --tag "$IMAGE" .
"$DOCKER_BIN" run --rm \
  --platform linux/arm64 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 512m \
  --cpus 1 \
  "$IMAGE" npm run test:m1.1
