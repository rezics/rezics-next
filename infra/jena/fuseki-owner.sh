#!/bin/sh
# Fuseki image entrypoint: one process owns one TDB2/Lucene state directory.
#
# OPS13: the owner lock is taken before any file is inspected, and the JVM
# inherits it. A second container on the same volume exits 75 without touching
# the state; TDB2's own tdb.lock still refuses any JVM that bypasses this script.
# Nothing here removes or overrides a database lock.
#
# OPS15: jena-text does not promise crash-atomic TDB2/Lucene commits. Only an
# orderly JVM exit after SIGTERM leaves `clean-stop`. Any other previous stop of
# a nonempty state leaves `lucene.uncertain`; the command module reports it and
# Main keeps public text unavailable until `yarn search:rebuild` indexes an empty
# replacement directory and removes the marker.
set -eu
state="${FUSEKI_BASE:-/fuseki}/databases/rezics"
if [ -e "${FUSEKI_BASE:-/fuseki}/databases/purge.incomplete" ]; then
  echo 'fuseki-owner: erasure candidate cutover is incomplete' >&2
  exit 75
fi
mkdir -p "$state/tdb2" "$state/lucene"
exec 9>>"$state/owner.lock"
if ! flock -n 9; then
  echo "fuseki-owner: another process owns $state; refusing to start" >&2
  exit 75
fi
if [ -e "$state/clean-stop" ]; then
  rm -f "$state/clean-stop"
elif [ -n "$(ls -A "$state/tdb2")" ] || [ -n "$(ls -A "$state/lucene")" ]; then
  : > "$state/lucene.uncertain"
fi
sync
stopping=0
"$@" &
child=$!
trap 'stopping=1; kill -TERM "$child" 2>/dev/null || true' TERM INT
status=0
wait "$child" || status=$?
# A trapped signal interrupts wait; collect the JVM's own exit status.
while kill -0 "$child" 2>/dev/null; do
  status=0
  wait "$child" || status=$?
done
if [ "$stopping" = 1 ] && { [ "$status" = 0 ] || [ "$status" = 143 ]; }; then
  : > "$state/clean-stop"
  sync
fi
exit "$status"
