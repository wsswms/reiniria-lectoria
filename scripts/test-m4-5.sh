#!/bin/sh
set -eu

: "${DOCKER_BIN:=docker}"
IMAGE=reiniria-lectoria-m4:local

"$DOCKER_BIN" build --platform linux/arm64 --tag "$IMAGE" .
"$DOCKER_BIN" run --rm \
  --platform linux/arm64 \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=768m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 1024m \
  --cpus 1 \
  "$IMAGE" npm run test:m4.5
