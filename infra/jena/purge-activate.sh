#!/bin/sh
# Campaign-bound offline promotion, pre-resume rollback and retained-copy retirement.
set -eu
usage() { echo 'usage: purge-activate.sh activate|rollback|destroy CANDIDATE_BASE|RETIRE_ID --campaign FILE RETIRE_ID | MODE SOURCE EXACT_IRI EPOCH RETIRE_ID' >&2; exit 64; }
refuse() { echo "purge-activate: $*" >&2; exit 75; }
[ "$#" -eq 5 ] || usage
mode=$1
source=$2
retire_id=$5
case "$mode" in activate|rollback|destroy) ;; *) usage ;; esac
case "$retire_id" in ''|*[!a-z0-9-]*) usage ;; esac
[ "${#retire_id}" -le 64 ] || usage
if [ "$3" = --campaign ]; then
  [ -f "$4" ] && [ ! -L "$4" ] && [ "$(wc -c < "$4")" -le 8192 ] || usage
  campaign=$(cat "$4"; printf '.')
  campaign=${campaign%.}
  printf '%s' "$campaign" | cmp -s - "$4" || usage
else
  campaign=$(printf '%s\t%s\n.' "$3" "$4")
  campaign=${campaign%.}
fi
validate_campaign() {
  # awk accepts a missing final LF; compare exact bytes with its reconstruction.
  normalized=$(printf '%s' "$campaign" | LC_ALL=C awk -F '\t' '
    NF != 2 || $1 !~ /^urn:rezics:content:revision:[0-9a-f-]+$/ || length($1) != 64 ||
      $2 !~ /^[1-9][0-9]*$/ || length($2) > 19 || seen[$1]++ { exit 1 }
    { id=substr($1,29); if (id !~ /^[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/ ||
        substr(id,9,1)!="-" || substr(id,14,1)!="-" || substr(id,19,1)!="-" || substr(id,24,1)!="-") exit 1;
      print $1 "\t" $2 }
    END { if (NR < 1 || NR > 64) exit 1 }') || usage
  reconstructed=$(printf '%s\n.' "$normalized")
  [ "$campaign" = "${reconstructed%.}" ] || usage
}
validate_campaign
identity() { stat -c '%d:%i' "$1"; }
stop_identity() { stat -c '%d:%i:%y:%z:%s' "$1"; }
inventory() {
  # Lock bytes and stop markers are operational, not retained payload custody.
  [ -z "$(find "$1" ! -type f ! -type d -print -quit)" ] || return 1
  inventory_rows=$(cd "$1" && find . -type f ! -name owner.lock ! -name tdb.lock ! -name write.lock ! -name clean-stop -exec sha256sum {} +) || return 1
  printf '%s\n' "$inventory_rows" | LC_ALL=C sort | sha256sum | cut -d ' ' -f 1
}
base=$(realpath -m "${FUSEKI_BASE:-/fuseki}")
parent="$base/databases"
state="$parent/rezics"
retired="$parent/rezics-retired-$retire_id"
record="$parent/erasure-retirement-$retire_id"
marker="$parent/purge.incomplete"
field() { sed -n "s/^$2=//p" "$1"; }
check_ready() {
  ready=$1
  [ -f "$ready" ] && [ ! -L "$ready" ] || refuse 'campaign evidence is absent'
  [ "$(wc -l < "$ready" | tr -d ' ')" = 6 ] || refuse 'corrupt campaign evidence'
  LC_ALL=C awk '
    NR==1 { if ($0 != "format=rezics-erasure-campaign-v2") exit 1 }
    NR==2 { if ($0 !~ /^campaign-sha256=[0-9a-f]+$/ || length($0)!=80) exit 1 }
    NR==3 { if ($0 !~ /^targets=[1-9][0-9]*$/ || substr($0,9)>64) exit 1 }
    NR==4 { if ($0 !~ /^source-identity=[0-9]+:[0-9]+$/) exit 1 }
    NR==5 { if ($0 !~ /^source-sha256=[0-9a-f]+$/ || length($0)!=78) exit 1 }
    NR==6 { if ($0 !~ /^candidate-identity=[0-9]+:[0-9]+$/) exit 1 }
    END { if (NR!=6) exit 1 }' "$ready" || refuse 'corrupt campaign evidence'
  digest=$(printf '%s' "$campaign" | sha256sum); digest=${digest%% *}
  [ "$(field "$ready" campaign-sha256)" = "$digest" ] &&
    [ "$(field "$ready" targets)" = "$(printf '%s' "$campaign" | wc -l | tr -d ' ')" ] || refuse 'different campaign evidence'
}
lock_state() {
  [ -d "$state" ] && [ ! -L "$state" ] && [ -f "$state/clean-stop" ] || refuse 'cleanly stopped owner required'
  exec 9>>"$state/owner.lock"
  flock -n 9 || refuse 'source owner is active'
  [ -f "$state/clean-stop" ] || refuse 'owner resumed'
}
check_source() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(identity "$1")" = "$(field "$ready" source-identity)" ] || refuse 'different retained source identity'
  [ "$(inventory "$1")" = "$(field "$ready" source-sha256)" ] || refuse 'different retained source bytes'
}
if [ "$mode" = activate ]; then
  [ ! -e "$marker" ] && [ ! -e "$record" ] && [ ! -e "$retired" ] || refuse 'incomplete cutover or occupied retirement id'
  lock_state
  candidate_base=$(realpath -m "$source")
  candidate="$candidate_base/databases/rezics"
  case "$candidate_base" in "$parent"/*) ;; *) usage ;; esac
  case "$candidate_base" in "$state"|"$state"/*|"$retired"|"$retired"/*|"$record"|"$record"/*) usage ;; esac
  [ -d "$candidate/tdb2" ] && [ -d "$candidate/lucene" ] && [ -f "$candidate/clean-stop" ] &&
    [ ! -e "$candidate/lucene.uncertain" ] && [ ! -L "$candidate" ] || refuse 'candidate is incomplete'
  exec 8>>"$candidate/owner.lock"
  flock -n 8 || refuse 'candidate owner is active'
  [ -f "$candidate/clean-stop" ] || refuse 'candidate resumed'
  check_ready "$candidate/erasure-purge.ready"
  [ "$(identity "$candidate")" = "$(field "$ready" candidate-identity)" ] || refuse 'different candidate identity'
  printf '%s' "$campaign" | cmp -s - "$candidate/erasure-campaign.tsv" || refuse 'different immutable campaign'
  cmp -s "$ready" "$candidate/erasure-purge.verified" || refuse 'exact candidate verification is absent'
  check_source "$state"
  mkdir "$record"
  cp "$ready" "$record/ready"
  printf '%s' "$campaign" > "$record/campaign.tsv"
  printf '%s\n' "$candidate" > "$record/candidate"
  stop_identity "$candidate/clean-stop" > "$record/candidate-stop"
  stop_identity "$state/clean-stop" > "$record/source-stop"
  printf 'prepared\n' > "$record/phase"
  ready_digest=$(sha256sum "$ready"); ready_digest=${ready_digest%% *}
  printf 'retirement-id=%s\nready-sha256=%s\ncandidate=%s\ncandidate-stop=%s\nsource-stop=%s\n' \
    "$retire_id" "$ready_digest" "$candidate" "$(cat "$record/candidate-stop")" "$(cat "$record/source-stop")" > "$record/cutover"
  cutover_digest=$(sha256sum "$record/cutover"); cutover_digest=${cutover_digest%% *}
  printf 'erasure-campaign-v2:%s:%s\n' "$retire_id" "$cutover_digest" > "$record/fence"
  sync
  cp "$record/fence" "$marker"
  sync
  # On failure keep the exact startup fence and record for explicit rollback.
  mv "$state" "$retired"
  mv "$candidate" "$state"
  cp "$record/cutover" "$state/erasure-purge.active"
  printf 'active\n' > "$record/phase"
  sync
  rm "$marker"
  echo "purge-activate: candidate active; old fileset retained at $retired"
  exit 0
fi
[ "$source" = "$retire_id" ] && [ -d "$record" ] && [ ! -L "$record" ] || refuse 'exact retirement record required'
for evidence_file in ready campaign.tsv candidate candidate-stop source-stop phase fence cutover; do
  [ -f "$record/$evidence_file" ] && [ ! -L "$record/$evidence_file" ] || refuse 'missing exact recovery evidence'
done
check_ready "$record/ready"
printf '%s' "$campaign" | cmp -s - "$record/campaign.tsv" || refuse 'different recorded campaign'
ready_digest=$(sha256sum "$ready"); ready_digest=${ready_digest%% *}
printf 'retirement-id=%s\nready-sha256=%s\ncandidate=%s\ncandidate-stop=%s\nsource-stop=%s\n' \
  "$retire_id" "$ready_digest" "$(cat "$record/candidate")" "$(cat "$record/candidate-stop")" "$(cat "$record/source-stop")" | cmp -s - "$record/cutover" || refuse 'corrupt recovery evidence'
cutover_digest=$(sha256sum "$record/cutover"); cutover_digest=${cutover_digest%% *}
expected_fence=$(printf 'erasure-campaign-v2:%s:%s' "$retire_id" "$cutover_digest")
[ "$(cat "$record/fence")" = "$expected_fence" ] || refuse 'corrupt cutover evidence'
[ ! -e "$marker" ] || cmp -s "$marker" "$record/fence" || refuse 'another incomplete cutover'
phase=$(cat "$record/phase")
if [ "$mode" = rollback ]; then
  case "$phase" in prepared|active|rolled-back) ;; *) refuse 'retirement has begun' ;; esac
  candidate=$(cat "$record/candidate")
  case "$candidate" in "$parent"/*/databases/rezics) ;; *) refuse 'corrupt candidate path' ;; esac
  case "$candidate" in "$state"|"$state"/*|"$retired"/*|"$record"/*) refuse 'overlapping recovery paths' ;; esac
  if [ -d "$state" ] && [ "$(identity "$state")" = "$(field "$ready" candidate-identity)" ]; then
    lock_state
    [ "$(stop_identity "$state/clean-stop")" = "$(cat "$record/candidate-stop")" ] || refuse 'candidate owner has resumed'
    [ ! -e "$candidate" ] || refuse 'candidate rollback path is occupied'
    check_source "$retired"
    exec 8>>"$retired/owner.lock"
    flock -n 8 || refuse 'retired owner is active'
    [ -f "$retired/clean-stop" ] && [ "$(stop_identity "$retired/clean-stop")" = "$(cat "$record/source-stop")" ] || refuse 'source owner has resumed'
    cp "$record/fence" "$marker"
    sync
    mv "$state" "$candidate"
  fi
  restored_lock=0
  if [ ! -e "$state" ]; then
    check_source "$retired"
    exec 8>>"$retired/owner.lock"
    flock -n 8 || refuse 'retired owner is active'
    [ -f "$retired/clean-stop" ] && [ "$(stop_identity "$retired/clean-stop")" = "$(cat "$record/source-stop")" ] || refuse 'source owner has resumed'
    mv "$retired" "$state"
    # Keep the source lock across the rename without relocking another open
    # description of the same file (which would conflict with our own lock).
    exec 9>&8
    exec 8>&-
    restored_lock=1
  fi
  if [ "$restored_lock" = 0 ]; then lock_state; fi
  check_source "$state"
  [ "$(stop_identity "$state/clean-stop")" = "$(cat "$record/source-stop")" ] || refuse 'source owner has resumed'
  [ -d "$candidate" ] && [ ! -L "$candidate" ] &&
    [ "$(identity "$candidate")" = "$(field "$ready" candidate-identity)" ] &&
    [ -f "$candidate/clean-stop" ] &&
    [ "$(stop_identity "$candidate/clean-stop")" = "$(cat "$record/candidate-stop")" ] || refuse 'different rollback candidate'
  exec 8>>"$candidate/owner.lock"
  flock -n 8 || refuse 'candidate owner is active'
  cmp -s "$ready" "$candidate/erasure-purge.ready" &&
    cmp -s "$ready" "$candidate/erasure-purge.verified" || refuse 'missing rollback candidate evidence'
  printf '%s' "$campaign" | cmp -s - "$candidate/erasure-campaign.tsv" || refuse 'different rollback campaign'
  printf 'rolled-back\n' > "$record/phase"
  sync
  if [ -e "$marker" ]; then rm "$marker"; fi
  echo 'purge-activate: original source restored; sanitized candidate retained'
  exit 0
fi
[ ! -e "$marker" ] || refuse 'incomplete cutover requires rollback'
lock_state
[ "$(identity "$state")" = "$(field "$ready" candidate-identity)" ] &&
  cmp -s "$record/cutover" "$state/erasure-purge.active" &&
  cmp -s "$ready" "$state/erasure-purge.ready" &&
  cmp -s "$ready" "$state/erasure-purge.verified" || refuse 'exact active campaign evidence required'
printf '%s' "$campaign" | cmp -s - "$state/erasure-campaign.tsv" || refuse 'different active campaign snapshot'
receipt=$(printf 'format=rezics-erasure-retirement-v2\nretirement-id=%s\nready-sha256=%s\ncutover-sha256=%s\nsource-identity=%s\nsource-sha256=%s\naction=retained-fileset-unlinked\n.' \
  "$retire_id" "$ready_digest" "$cutover_digest" "$(field "$ready" source-identity)" "$(field "$ready" source-sha256)")
receipt=${receipt%.}
case "$phase" in
  active)
    check_source "$retired"
    exec 8>>"$retired/owner.lock"
    flock -n 8 || refuse 'retired owner is active'
    check_source "$retired"
    printf '%s' "$receipt" > "$record/destruction-authorized"
    sync
    printf 'destroying\n' > "$record/phase"
    sync ;;
  destroying|destroyed)
    printf '%s' "$receipt" | cmp -s - "$record/destruction-authorized" || refuse 'missing exact destruction authorization'
    if [ -e "$retired" ]; then
      [ ! -L "$retired" ] && [ "$(identity "$retired")" = "$(field "$ready" source-identity)" ] || refuse 'different partially retired source'
      exec 8>>"$retired/owner.lock"
      flock -n 8 || refuse 'retired owner is active'
    fi ;;
  *) refuse 'campaign is not active' ;;
esac
rm -rf "$retired"
printf '%s' "$receipt" > "$state/erasure-purge.retired-$retire_id"
printf 'destroyed\n' > "$record/phase"
sync
evidence=$(sha256sum "$state/erasure-purge.retired-$retire_id"); evidence=${evidence%% *}
echo "purge-activate: retired fileset unlinked; evidence-sha256=$evidence; snapshots, backups and media remain unverified"
