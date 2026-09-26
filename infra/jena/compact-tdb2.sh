#!/bin/sh
# Offline TDB2 compaction. Run only after the Fuseki owner has stopped cleanly.
# The old generation is retained for the recovery window; this does not collect
# revision objects or change the Lucene index.
set -eu
state="${FUSEKI_BASE:-/fuseki}/databases/rezics"
mkdir -p "$state"
exec 9>>"$state/owner.lock"
if ! flock -n 9; then
  echo 'tdb2 compact: another process owns the state directory' >&2
  exit 75
fi
if [ ! -d "$state/tdb2" ] || [ ! -e "$state/clean-stop" ]; then
  echo 'tdb2 compact: a cleanly stopped owner and existing TDB2 are required' >&2
  exit 75
fi
if [ -z "$(ls -A "$state/tdb2")" ]; then
  echo 'tdb2 compact: no TDB2 generation exists' >&2
  exit 75
fi
exec java -Xmx2g -cp "${FUSEKI_HOME:-/opt/apache-jena-fuseki-6.2.0}/fuseki-server.jar" \
  tdb2.tdbcompact --loc "$state/tdb2"
