#!/bin/sh
# Trusted pre-entrypoint gate. Docker launches this through the pinned musl
# loader and BusyBox copied from the toolchain runtime, independent of the task
# image's shell and dynamic loader.
set -eu

BUSYBOX=/opt/bench/node-musl-runtime/busybox
GATE=${HOME:?runtime home is required}/.model-transport-attested
NONCE=${BENCH_RUNTIME_NONCE:-}

case "$NONCE" in
  *[!a-f0-9]*|'') exit 70 ;;
esac
[ "${#NONCE}" -eq 64 ] || exit 70

attempt=0
while [ ! -f "$GATE" ] && [ "$attempt" -lt 120 ]; do
  "$BUSYBOX" sleep 1
  attempt=$((attempt + 1))
done
IFS= read -r observed < "$GATE" 2>/dev/null || observed=
[ "$observed" = "$NONCE" ] || exit 70
"$BUSYBOX" rm -f "$GATE"
exec "$@"
