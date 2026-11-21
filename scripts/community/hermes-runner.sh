#!/usr/bin/env bash
out=$(mktemp)
/opt/hermes/bin/hermes "$@" >"$out"
result=$?
cat "$out"
if [ "$result" -ne 0 ]; then
  tail -c 1800 "$out" >&2
fi
rm -f "$out"
exit "$result"
