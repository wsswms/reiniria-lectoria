#!/bin/sh
set -eu

: "${DOCKER_BIN:=docker}"
: "${GIT_BIN:=git}"
IMAGE=reiniria-lectoria-m2:local
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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
  "$IMAGE" npm test

"$DOCKER_BIN" run --rm --platform linux/arm64 --network none -v "$TMP:/fixture" "$IMAGE" node scripts/prepare-m2-4-git-fixture.mjs /fixture
"$GIT_BIN" -C "$TMP" init -q
"$GIT_BIN" -C "$TMP" add -A
TRACKED="$($GIT_BIN -C "$TMP" ls-files)"
printf '%s\n' "$TRACKED" | grep -q '^documents/track/content/document.md$'
printf '%s\n' "$TRACKED" | grep -q '^documents/metadata/metadata.json$'
if printf '%s\n' "$TRACKED" | grep -Eq '^(private|state|derived|staging)/|^documents/(never/|metadata/content/)'; then
  echo "forbidden Git path was tracked" >&2
  exit 1
fi
if "$GIT_BIN" -C "$TMP" grep --cached -n 'M2-GIT-SECRET-CANARY'; then
  echo "secret canary entered Git" >&2
  exit 1
fi
if rg -n 'child_process|spawn\(|execFile\(' src; then
  echo "application source invokes a subprocess" >&2
  exit 1
fi
printf '%s\n' '{"git_policy_fixtures":3,"forbidden_tracked_paths":0,"secret_canary_leaks":0,"application_git_subprocesses":0}'
