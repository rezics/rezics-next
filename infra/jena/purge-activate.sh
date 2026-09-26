#!/bin/sh
# Promote an externally verified, stopped sanitized candidate on one volume.
# The parent marker makes an interrupted two-rename cutover fail closed.
set -eu
usage='usage: purge-activate.sh activate|destroy CANDIDATE_BASE|RETIRE_ID EXACT_REVISION_IRI ERASURE_EPOCH RETIRE_ID'
if [ "$#" -ne 5 ]; then echo "$usage" >&2; exit 64; fi
mode=$1
source=$2
target=$3
epoch=$4
retire_id=$5
case "$target" in
  urn:rezics:content:revision:*) ;;
  *) echo 'purge-activate: invalid exact target' >&2; exit 64 ;;
esac
case "$epoch" in
  ''|0*|*[!0-9]*) echo 'purge-activate: invalid epoch' >&2; exit 64 ;;
esac
case "$retire_id" in
  ''|*[!a-z0-9-]*) echo 'purge-activate: invalid retirement id' >&2; exit 64 ;;
esac
base=$(realpath -m "${FUSEKI_BASE:-/fuseki}")
parent="$base/databases"
state="$parent/rezics"
retired="$parent/rezics-retired-$retire_id"
marker="$parent/purge.incomplete"
expected=$(printf '%s\n%s\n' "$target" "$epoch")
if [ ! -d "$state" ] || [ ! -f "$state/clean-stop" ] || [ -e "$marker" ]; then
  echo 'purge-activate: a cleanly stopped owner without an incomplete cutover is required' >&2
  exit 75
fi
exec 9>>"$state/owner.lock"
if ! flock -n 9; then echo 'purge-activate: source owner is active' >&2; exit 75; fi
if [ "$mode" = activate ]; then
  candidate_base=$(realpath -m "$source")
  candidate="$candidate_base/databases/rezics"
  case "$candidate_base" in
    "$parent"/*) ;;
    *) echo 'purge-activate: candidate must be in the same state volume' >&2; exit 64 ;;
  esac
  if [ "$candidate_base" = "$base" ] || [ ! -d "$candidate/tdb2" ] \
    || [ ! -d "$candidate/lucene" ] || [ ! -f "$candidate/clean-stop" ] \
    || [ -e "$candidate/lucene.uncertain" ] || [ -e "$retired" ]; then
    echo 'purge-activate: candidate is incomplete or retirement id is occupied' >&2
    exit 75
  fi
  exec 8>>"$candidate/owner.lock"
  if ! flock -n 8; then echo 'purge-activate: candidate owner is active' >&2; exit 75; fi
  if [ ! -f "$candidate/erasure-purge.ready" ] \
    || [ ! -f "$candidate/erasure-purge.verified" ] \
    || [ "$(cat "$candidate/erasure-purge.ready")" != "$expected" ] \
    || ! cmp -s "$candidate/erasure-purge.ready" "$candidate/erasure-purge.verified"; then
    echo 'purge-activate: exact candidate verification is absent' >&2
    exit 75
  fi
  : > "$marker"
  sync
  # The server entrypoint refuses while the marker exists, including after a
  # crash between renames. A caught error before promotion restores the source.
  trap 'if [ ! -e "$state" ] && [ -d "$retired" ]; then mv "$retired" "$state"; fi' EXIT
  mv "$state" "$retired"
  mv "$candidate" "$state"
  cp "$state/erasure-purge.ready" "$state/erasure-purge.active"
  sync
  rm "$marker"
  trap - EXIT
  echo "purge-activate: candidate active; old fileset retained at $retired"
elif [ "$mode" = destroy ]; then
  if [ "$source" != "$retire_id" ] || [ ! -d "$retired" ] \
    || [ ! -f "$state/erasure-purge.active" ] \
    || [ "$(cat "$state/erasure-purge.active")" != "$expected" ]; then
    echo 'purge-activate: exact active and retired filesets are required' >&2
    exit 75
  fi
  exec 8>>"$retired/owner.lock"
  if ! flock -n 8; then echo 'purge-activate: retired owner is active' >&2; exit 75; fi
  rm -rf "$retired"
  printf '%s\n%s\n' "$target" "$epoch" > "$state/erasure-purge.retired-$retire_id"
  sync
  echo 'purge-activate: retired fileset unlinked; separately inventory snapshots, backups and media disposition'
else
  echo "$usage" >&2
  exit 64
fi
