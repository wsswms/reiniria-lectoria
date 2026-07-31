#!/bin/sh
set -eu

: "${DOCKER_BIN:=docker}"
IMAGE=reiniria-lectoria-m2:local

"$DOCKER_BIN" build --platform linux/arm64 --tag "$IMAGE" .
"$DOCKER_BIN" run --rm \
  --platform linux/arm64 \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 512m \
  --cpus 1 \
  "$IMAGE" sh -c 'npm test && npm run measure:m2.3'
