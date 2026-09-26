#!/bin/sh
# Build a separate sanitized TDB2/Lucene candidate from a cleanly stopped owner.
# Run inside the pinned Fuseki image with this script mounted read-only. The
# candidate is deliberately never swapped into the live state by this command.
set -eu
if [ "$#" -ne 3 ]; then
  echo 'usage: purge-tdb2.sh EMPTY_DEST_BASE EXACT_REVISION_IRI ERASURE_EPOCH' >&2
  exit 64
fi
destination=$1
target=$2
epoch=$3
case "$epoch" in
  ''|0*|*[!0-9]*) echo 'purge-tdb2: invalid erasure epoch' >&2; exit 64 ;;
esac
case "$target" in
  urn:rezics:content:revision:*) ;;
  *) echo 'purge-tdb2: unsupported exact target' >&2; exit 64 ;;
esac
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
if [ -e "$destination" ] || [ ! -e "$state/clean-stop" ] || [ ! -d "$state/tdb2" ]; then
  echo 'purge-tdb2: empty destination and cleanly stopped source required' >&2
  exit 75
fi
exec 9>>"$state/owner.lock"
if ! flock -n 9; then
  echo 'purge-tdb2: source owner is active' >&2
  exit 75
fi
mkdir -p "$destination/databases/rezics/tdb2" "$destination/databases/rezics/lucene"
mkdir -p "$destination/extra"
cp "${FUSEKI_COMMAND_JAR:-/fuseki/extra/fuseki-command.jar}" "$destination/extra/fuseki-command.jar"
cp -R /fuseki/profiles "$destination/profiles"
jar="${FUSEKI_HOME:-/opt/apache-jena-fuseki-6.2.0}/fuseki-server.jar"
module="${FUSEKI_COMMAND_JAR:-/fuseki/extra/fuseki-command.jar}"
java -Xmx2g -cp "$module:$jar" com.rezics.jena.ErasurePurge \
  "$state/tdb2" "$destination/databases/rezics/tdb2" "$target" "$epoch"
# Reuse the qualified offline compactor on the *sanitized* copy. Old active
# generations are left under the inaccessible source for custody inventory.
: > "$destination/databases/rezics/clean-stop"
FUSEKI_BASE="$destination" "${ERASURE_COMPACTOR:-/usr/local/bin/tdb2-compact}"
cp "${ERASURE_ASSEMBLER:-/fuseki/fuseki-text.ttl}" "$destination/fuseki-text.ttl"
: > "$destination/databases/rezics/lucene.uncertain"
(cd "$destination" && FUSEKI_BASE="$destination" java -Xmx2g -cp "$jar" \
  jena.textindexer --desc="$destination/fuseki-text.ttl")
rm "$destination/databases/rezics/lucene.uncertain"
sync
echo 'purge-tdb2: sanitized candidate built; verify graph, text, epochs and custody before activation'
