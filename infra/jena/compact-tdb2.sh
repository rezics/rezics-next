#!/bin/sh
# Jena retains Data-N and publishes Data-(N+1) after building its -tmp directory.
# Never pass --deleteOld: retirement is a separate operator action.
set -eu
umask 077
refuse() { echo "tdb2 compact: $*" >&2; exit 75; }
usage() { echo 'usage: tdb2-compact [compact WINDOW RETAIN_UNTIL_EPOCH RESERVE_BYTES | status WINDOW | rollback WINDOW | retire WINDOW --verified]' >&2; exit 64; }
mode=${1:-compact}
# Preserve the sanitized-candidate caller, with a named seven-day window.
if [ "$#" = 0 ]; then
  window="compact-$(date -u +%Y%m%d%H%M%S)"
  until=$(( $(date +%s) + 604800 ))
  reserve=1073741824
else
  window=${2:-}
  case "$mode:$#" in
    compact:4) until=$3; reserve=$4 ;;
    status:2|rollback:2) ;;
    retire:3) [ "$3" = --verified ] || usage ;;
    *) usage ;;
  esac
fi
case "$window" in ''|*[!a-z0-9-]*) usage ;; esac
[ "${#window}" -le 64 ] || usage
state="${FUSEKI_BASE:-/fuseki}/databases/rezics"
parent="${FUSEKI_BASE:-/fuseki}/databases"
[ -d "$state/tdb2" ] || refuse 'existing TDB2 required'
exec 9>>"$state/owner.lock"
flock -n 9 || refuse 'another process owns the state directory'
record="$state/compaction/$window"
# Reuse the entrypoint's persistent cutover fence. Exact content prevents this
# operation from releasing an erasure operation's fence.
fence="$parent/purge.incomplete"
identity="tdb2-compaction:$window"
phase() { printf '%s\n' "$1" > "$record/phase.next"; mv "$record/phase.next" "$record/phase"; sync; }
publish_fence() {
  printf '%s\n' "$identity" > "$record/startup-fence.next"
  sync
  mv "$record/startup-fence.next" "$fence"
  sync
}
stop_identity() { find "$state/clean-stop" -maxdepth 0 -printf '%i %T@ %C@\n'; }
if [ "$mode" = status ]; then
  [ -f "$record/phase" ] || refuse 'unknown recovery window'
  cat "$record/evidence" "$record/phase"
  exit 0
fi
if [ "$mode" = compact ]; then
  case "$until:$reserve" in *[!0-9:]*|:*|*:) usage ;; esac
  [ "${#until}" -le 12 ] && [ "${#reserve}" -le 15 ] || usage
  case "$until" in 0*) usage ;; esac
  case "$reserve" in 0) ;; 0*) usage ;; esac
  [ "$until" -gt "$(date +%s)" ] || refuse 'recovery window must end in the future'
  [ -f "$state/clean-stop" ] || refuse 'a cleanly stopped owner is required'
  [ ! -e "$fence" ] || refuse 'an incomplete maintenance operation is fenced'
  [ ! -e "$record" ] || refuse 'recovery window already exists; inspect its status'
  # Refuse to accumulate generations, including interrupted temporary ones.
  count=0
  for directory in "$state/tdb2"/Data*; do
    [ -e "$directory" ] || continue
    [ -d "$directory" ] && [ ! -L "$directory" ] || refuse 'invalid generation'
    name=${directory##*/}
    number=${name#Data-}
    case "$number" in ''|*[!0-9]*) refuse 'unexpected or temporary generation; recover first' ;; esac
    [ "${#number}" -le 9 ] || refuse 'unsupported generation number'
    source=$name
    count=$((count + 1))
  done
  [ "$count" = 1 ] || refuse 'exactly one generation is required; retire or recover the previous window'
  number=$(printf '%s' "$number" | sed 's/^0*//')
  number=${number:-0}
  target=$(printf 'Data-%04d' "$((number + 1))")
  allocated=$(du -sk "$state/tdb2/$source" | awk '{print $1}')
  apparent=$(du -sk --apparent-size "$state/tdb2/$source" | awk '{print $1}')
  source_kib=$allocated
  [ "$apparent" -le "$source_kib" ] || source_kib=$apparent
  # Planning allowance includes the destination journal/transient files.
  # Twice the source is an assumption, not a measured Jena upper bound.
  replacement_kib=$((source_kib * 2))
  required_kib=$((replacement_kib + (reserve + 1023) / 1024))
  available_kib=$(df -Pk "$state/tdb2" | awk 'END {print $4}')
  case "$available_kib" in ''|*[!0-9]*) refuse 'cannot determine disk headroom' ;; esac
  echo "tdb2 compact: source-kib=$source_kib replacement-budget-kib=$replacement_kib required-free-kib=$required_kib available-kib=$available_kib; old generation retained; no concurrent disk consumers assumed"
  [ "$available_kib" -ge "$required_kib" ] || refuse 'inadequate disk headroom'
  mkdir -p "$record"
  printf '%s\n' "$source" > "$record/source"
  printf '%s\n' "$target" > "$record/target"
  printf '%s\n' "$until" > "$record/retain-until"
  printf 'window=%s\nsource=%s\ntarget=%s\nretain-until=%s\nsource-kib=%s\nsource-allocated-kib=%s\nsource-apparent-kib=%s\nreplacement-budget-kib=%s\nrequired-free-kib=%s\navailable-kib=%s\n' \
    "$window" "$source" "$target" "$until" "$source_kib" "$allocated" "$apparent" "$replacement_kib" "$required_kib" "$available_kib" > "$record/evidence"
  stop_identity > "$record/clean-stop-identity"
  printf 'started-at=%s\n' "$(date +%s)" >> "$record/evidence"
  phase prepared
  publish_fence
  rm "$state/clean-stop"
  phase running
  # The parent and Java retain owner.lock. Any failure, including SIGKILL,
  # leaves the persistent startup fence and the recorded recovery generation.
  if java -Xmx2g -cp "${FUSEKI_HOME:-/opt/apache-jena-fuseki-6.2.0}/fuseki-server.jar" \
    tdb2.tdbcompact --loc "$state/tdb2" > "$record/jena.log" 2>&1; then
    [ -d "$state/tdb2/$source" ] && [ -d "$state/tdb2/$target" ] \
      && [ ! -e "$state/tdb2/$target-tmp" ] || refuse 'unexpected compaction output; recovery fence retained'
    printf 'finished-at=%s\n' "$(date +%s)" >> "$record/evidence"
    phase retained
    : > "$state/clean-stop"
    stop_identity > "$record/clean-stop-identity"
    sync
    rm "$fence"
    echo "tdb2 compact: retained recovery window $window until $until; source=$source target=$target"
  else
    phase failed
    refuse "Jena failed; keep writers stopped and rollback window $window; see $record/jena.log"
  fi
  exit 0
fi
[ -f "$record/phase" ] || refuse 'unknown recovery window'
source=$(cat "$record/source")
target=$(cat "$record/target")
for name in "$source" "$target"; do
  case "$name" in Data-*) number=${name#Data-} ;; *) refuse 'invalid recorded generation' ;; esac
  case "$number" in ''|*[!0-9]*) refuse 'invalid recorded generation' ;; esac
  [ "${#number}" -le 10 ] || refuse 'invalid recorded generation'
done
number=$(printf '%s' "${source#Data-}" | sed 's/^0*//')
number=${number:-0}
[ "$target" = "$(printf 'Data-%04d' "$((number + 1))")" ] || refuse 'recorded target is not the next generation'
[ ! -L "$state/tdb2/$source" ] && [ ! -L "$state/tdb2/$target" ] || refuse 'linked recovery generation'
current_phase=$(cat "$record/phase")
if [ "$mode" = rollback ]; then
  case "$current_phase" in prepared|running|failed|retained|rolling-back|rolled-back) ;; *) refuse 'window cannot be rolled back' ;; esac
  [ -d "$state/tdb2/$source" ] || refuse 'recovery generation is missing'
  for directory in "$state/tdb2"/Data*; do
    [ "$directory" = "$state/tdb2/$source" ] || [ "$directory" = "$state/tdb2/$target" ] \
      || [ "$directory" = "$state/tdb2/$target-tmp" ] || refuse 'unexpected generation; rollback refused'
  done
  if [ "$current_phase" = rolled-back ] && [ ! -e "$fence" ]; then
    echo "tdb2 compact: window $window already rolled back"
    exit 0
  fi
  if [ -e "$fence" ]; then
    [ "$(cat "$fence")" = "$identity" ] || refuse 'another maintenance operation owns the fence'
  else
    [ -f "$state/clean-stop" ] && [ -f "$record/clean-stop-identity" ] || refuse 'original clean stop required for rollback'
    [ "$(stop_identity)" = "$(cat "$record/clean-stop-identity")" ] || refuse 'owner has resumed; use the whole recovery set'
    publish_fence
  fi
  phase rolling-back
  mkdir -p "$record/quarantine"
  for name in "$target" "$target-tmp"; do
    if [ -e "$state/tdb2/$name" ]; then
      [ ! -e "$record/quarantine/$name" ] || refuse 'quarantine collision'
      mv "$state/tdb2/$name" "$record/quarantine/$name"
    fi
  done
  phase rolled-back
  : > "$state/clean-stop"
  sync
  rm "$fence"
  echo "tdb2 compact: source restored; replacement quarantined in $record/quarantine"
elif [ "$mode" = retire ]; then
  [ -f "$state/clean-stop" ] && [ ! -e "$fence" ] || refuse 'clean stop without a maintenance fence required'
  case "$current_phase" in retained|retiring) ;; *) refuse 'only a successful retained window can be retired' ;; esac
  [ "$(date +%s)" -ge "$(cat "$record/retain-until")" ] || refuse 'recovery window has not expired'
  [ -d "$state/tdb2/$target" ] || refuse 'replacement generation is missing'
  for directory in "$state/tdb2"/Data*; do
    [ "$directory" = "$state/tdb2/$source" ] || [ "$directory" = "$state/tdb2/$target" ] || refuse 'unexpected generation; retirement refused'
  done
  phase retiring
  rm -rf "$state/tdb2/$source"
  printf 'retired-at=%s\noperator-verified=true\n' "$(date +%s)" > "$record/retirement"
  phase retired
  echo "tdb2 compact: retired $source; evidence retained at $record; snapshots, backups and media remain unverified"
else
  usage
fi
