#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 5 ]]; then
  printf 'Usage: %s <evidence-root> <commit> <hosts-json> <witness-sha256> <loader-sha256>\n' "$0" >&2
  exit 2
fi

evidence_root="$1"
pin="$2"
host_file="$3"
digest="$4"
loader_digest="$5"
witness="$evidence_root/follow-witness.ts"
loader_file="$evidence_root/witness-loader.ts"

test "$(git rev-parse HEAD)" = "$pin"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test "$(jq -cr '.hosts | map(.name)' "$host_file")" = '["c"]'
test "$(sha256sum < "$witness" | cut -d ' ' -f 1)" = "$digest"
test "$(sha256sum < "$loader_file" | cut -d ' ' -f 1)" = "$loader_digest"
test -n "${REZICS_NATIVE_UNIT_CONTEXT:?}"
test -n "${REZICS_NATIVE_UNIT_RUN_ID:?}"

envfile="$(mktemp "$evidence_root/check-environment.XXXXXXXX.json")"
trap 'rm -f -- "$envfile"' EXIT
jq -n '{
  REZICS_NATIVE_UNIT_CONTEXT: env.REZICS_NATIVE_UNIT_CONTEXT,
  REZICS_NATIVE_UNIT_RUN_ID: env.REZICS_NATIVE_UNIT_RUN_ID,
  REZICS_WALK_DEFER_FRONTENDS: "0"
}' > "$envfile"

export REZICS_CHECK_LEDGER_DIR="$evidence_root/check-runs"
export REZICS_CHECK_RUN_STATE_DIR="$evidence_root/settlements"
payload="$(gzip -cn "$witness" | base64 -w 0)"
mapfile -t parts < <(printf '%s\n' "$payload" | fold -w 3000)
loader="$(cat "$loader_file")"
"$PWD/node_modules/.bin/bun" scripts/check-run.ts --hosts "$host_file" --workspace "$PWD" --cwd . \
  --source-revision "$pin" --env-file "$envfile" --returns .temp/accounts/follow-admission.json -- \
  bun services/auth/scripts/dev-stack.ts walk --import-catalogue -- bun -e "$loader" -- "$pin" "$digest" "${parts[@]}"
