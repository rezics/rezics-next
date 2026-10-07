#!/bin/sh
# Build a separate sanitized TDB2/Lucene candidate from a cleanly stopped owner.
# Run inside the pinned Fuseki image with this script mounted read-only. The
# candidate is deliberately never swapped into the live state by this command.
set -eu
usage() { echo 'usage: purge-tdb2.sh EMPTY_DEST_BASE --campaign FILE | EMPTY_DEST_BASE EXACT_REVISION_IRI ERASURE_EPOCH' >&2; exit 64; }
[ "$#" -eq 3 ] || usage
destination=$1
# The one-target CLI is an explicit adapter, never a second sanitizer path.
if [ "$2" = --campaign ]; then
  [ -f "$3" ] && [ ! -L "$3" ] || usage
  [ "$(wc -c < "$3")" -le 8192 ] || usage
  campaign=$(cat "$3"; printf '.')
  campaign=${campaign%.}
  printf '%s' "$campaign" | cmp -s - "$3" || usage
else
  campaign=$(printf '%s\t%s\n.' "$2" "$3")
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
inventory() {
  # Lock bytes and stop markers are operational, not retained payload custody.
  [ -z "$(find "$1" ! -type f ! -type d -print -quit)" ] || return 1
  inventory_rows=$(cd "$1" && find . -type f ! -name owner.lock ! -name tdb.lock ! -name write.lock ! -name clean-stop -exec sha256sum {} +) || return 1
  printf '%s\n' "$inventory_rows" | LC_ALL=C sort | sha256sum | cut -d ' ' -f 1
}
state="${FUSEKI_BASE:-/fuseki}/databases/rezics"
case "$destination" in
  /*) ;;
  *) echo 'purge-tdb2: destination must be absolute' >&2; exit 64 ;;
esac
destination=$(realpath -m "$destination")
state=$(realpath -m "$state")
case "$destination" in
  "$state"|"$state"/*) echo 'purge-tdb2: destination overlaps source' >&2; exit 64 ;;
esac
case "$state" in "$destination"/*) echo 'purge-tdb2: destination overlaps source' >&2; exit 64 ;; esac
if [ -e "$destination" ] || [ ! -e "$state/clean-stop" ] || [ ! -d "$state/tdb2" ]; then
  echo 'purge-tdb2: empty destination and cleanly stopped source required' >&2
  exit 75
fi
exec 9>>"$state/owner.lock"
if ! flock -n 9; then
  echo 'purge-tdb2: source owner is active' >&2
  exit 75
fi
[ ! -e "$(dirname "$state")/purge.incomplete" ] || { echo 'purge-tdb2: incomplete cutover' >&2; exit 75; }
# Recheck after locking, since an owner may have resumed while we waited.
[ -f "$state/clean-stop" ] || exit 75
mkdir -p "$destination/databases/rezics/tdb2" "$destination/databases/rezics/lucene"
mkdir -p "$destination/extra"
cp "${FUSEKI_COMMAND_JAR:-/fuseki/extra/fuseki-command.jar}" "$destination/extra/fuseki-command.jar"
cp -R "${FUSEKI_BASE:-/fuseki}/profiles" "$destination/profiles"
printf '%s' "$campaign" > "$destination/databases/rezics/erasure-campaign.tsv"
jar="${FUSEKI_HOME:-/opt/apache-jena-fuseki-6.2.0}/fuseki-server.jar"
module="${FUSEKI_COMMAND_JAR:-/fuseki/extra/fuseki-command.jar}"
java -Xmx2g -cp "$module:$jar" com.rezics.jena.ErasurePurge \
  "$state/tdb2" "$destination/databases/rezics/tdb2" --campaign "$destination/databases/rezics/erasure-campaign.tsv"
# Reuse the qualified offline compactor on the *sanitized* copy. Old active
# generations are left under the inaccessible source for custody inventory.
: > "$destination/databases/rezics/clean-stop"
FUSEKI_BASE="$destination" "${ERASURE_COMPACTOR:-/usr/local/bin/tdb2-compact}"
cp "${ERASURE_ASSEMBLER:-/fuseki/fuseki-text.ttl}" "$destination/fuseki-text.ttl"
: > "$destination/databases/rezics/lucene.uncertain"
(cd "$destination" && FUSEKI_BASE="$destination" java -Xmx2g -cp "$module:$jar" \
  com.rezics.jena.ErasureTextIndexer --desc="$destination/fuseki-text.ttl")
rm "$destination/databases/rezics/lucene.uncertain"
candidate="$destination/databases/rezics"
printf '%s' "$campaign" | cmp -s - "$candidate/erasure-campaign.tsv" || { echo 'purge-tdb2: campaign snapshot changed' >&2; exit 75; }
digest=$(sha256sum "$candidate/erasure-campaign.tsv"); digest=${digest%% *}
source_digest=$(inventory "$state") || { echo 'purge-tdb2: unsupported linked source fileset' >&2; exit 75; }
printf 'format=rezics-erasure-campaign-v2\ncampaign-sha256=%s\ntargets=%s\nsource-identity=%s\nsource-sha256=%s\ncandidate-identity=%s\n' \
  "$digest" "$(printf '%s' "$campaign" | wc -l | tr -d ' ')" "$(identity "$state")" "$source_digest" "$(identity "$candidate")" > "$candidate/erasure-purge.ready"
sync
echo 'purge-tdb2: sanitized candidate built; verify graph, text, epochs and custody, then copy erasure-purge.ready to erasure-purge.verified before activation'
