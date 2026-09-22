# Backup, restoration and index recovery

Use one stopped-process backup first. The initial deployment accepts a maintenance
window and manual restoration; it does not claim replica failover or zero data
loss. Fuseki is the only live JVM opening its TDB2 and Lucene paths. A second
JVM running a CLI against a live database is not an online backup procedure.

## Recovery set and positions

For the graph substrate, capture the whole TDB2 database root, Lucene directory,
assembler, exact Jena archive/checksum, Java build and analyzer/index manifest.
Do not copy only the newest `Data-*` directory or assume a live recursive file
copy is consistent. TDB2's current database and compacted generations are
[administrative storage structures](https://jena.apache.org/documentation/tdb2/tdb2_admin.html),
not permanent REZICS revision archives.

A product recovery set additionally includes Account/Access PostgreSQL backups
and WAL positions, immutable revision manifests and payload objects, operation
receipts/outbox, durable consumer progress, source observations, authority and
erasure journals, model definitions, configuration and protected keys. TDB2 alone
cannot restore external objects or private authority. Lucene is derived; it can
be discarded only if the indexed RDF and exact index recipe survive.

Record `{datasetId, dataEpoch, sequence}` for the graph position; sequence is a
lossless decimal string in external manifests. Record each PostgreSQL and object
cut separately. Pause product admission and outbound effects when a coordinated
cut is required, drain in-flight commands, record the positions, stop Fuseki and
capture the participating stores. Independent backups have no global atomicity.
Reconcile owner receipts and retained outbox records before reopening a mixed cut.

## Offline graph backup example

These commands use the paths from [installation](installation.md). First stop the
foreground Fuseki process gracefully and wait for it to exit. Disable a supervisor's
automatic restart if one was added. Confirm there is no other process using this
state directory. Do not proceed while the owner is running.

```sh
REZICS_BACKUP_DIR="$REZICS_STATE/backups"
mkdir -p "$REZICS_BACKUP_DIR"
REZICS_BACKUP="$REZICS_BACKUP_DIR/graph-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -czf "$REZICS_BACKUP" -C "$REZICS_STATE" run
sha512sum "$REZICS_BACKUP" > "$REZICS_BACKUP.sha512"
```

Keep the archive and checksum with the release manifest in encrypted off-host
storage under separate credentials. The local `backups` directory is a staging
location, not protection from disk/host loss. Restart the original process after
the stopped-state copy finishes. The graph archive is only the substrate portion
of a product backup; mark a missing product component as incomplete coverage.

## Isolated restoration

Verify the checksum against the retained manifest. Use a new empty destination
rather than overlaying a running or failed database. Preserve the old state for
bounded diagnosis; never serve the old writer and its restored successor together.

```sh
sha512sum --check "$REZICS_BACKUP.sha512"
REZICS_RESTORE="$HOME/.local/state/rezics-jena-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$REZICS_RESTORE"
tar -xzf "$REZICS_BACKUP" -C "$REZICS_RESTORE"
export FUSEKI_BASE="$REZICS_RESTORE/run"
cd "$FUSEKI_BASE"
```

Use the recorded compatible `FUSEKI_HOME` and Java build. The example assembler's
relative paths now resolve inside the restore directory. Review any production
absolute paths before startup so the restore cannot open the original database.
Fence the original instance and start the restored instance with the installation
command on loopback. Keep all product routing, writes, delivery and worker effects
disabled during reconciliation.

For a substrate-only drill, run known graph and text probes against the saved
content. If the smoke resource was removed before backup, its absence is expected;
record the expected saved data when capturing the backup. Verify more than process
startup: RDF values, named graph identity and expected text additions/deletions.
Rebuild Lucene if the generation cannot be trusted.

For a product restore, apply separately retained current authority/erasure journals
before any user reads. Verify manifests/payload hashes, exact revision references
and the receipt/outbox cut. Allocate a **new `dataEpoch`**, reset its sequence to
zero and initialize that lineage's retention/checkpoint baseline before reopening
Main. Keep restored receipts and batches at their original epoch/sequence;
this fences pre-restore cursors, candidate handles, caches, leases and workers even
when a restored sequence number was used before. Reconcile unknown effects with
owner/provider receipts, then resume consumers from recorded checkpoints and
open routing. There is no turnkey product restore command in this checkout yet.

An old backup cannot prove that later revocations or erasures did not happen.
If the journal coverage is missing or uncertain, leave affected data and outbound
effects offline. RPO/RTO are selected by owner and demonstrated with a timed
restore drill; neither this recipe nor a scheduled backup establishes those values.

## Offline Lucene rebuild

Treat text results as unavailable after a crash with uncertain index state,
index I/O failure, analyzer/property-map change, underlying RDF bulk load or
unqualified restore. jena-text's
[TDB2 adapter](https://github.com/apache/jena/blob/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextIndexDB.java)
participates in prepare/commit/abort, but this is not a promise that both filesets
recover atomically from every failure. TDB2 receipts decide graph command outcomes;
Lucene does not decide whether an operation committed.

1. Stop Main admission and affected text consumers. Finish or reconcile outstanding
   updates. Stop Fuseki and its automatic restart; wait for exclusive file ownership.
2. Capture a stopped-state backup. Record graph position, old index generation,
   reason and the intended new analyzer/mapping digest. Ensure space for both old
   and replacement indexes. Keep any suspect index restricted from disclosure.
3. Run this block from `FUSEKI_BASE`, with the exact compatible release. The same
   assembler contains exactly one `text:TextDataset`, so the indexer can select it.

```sh
cd "$FUSEKI_BASE"
REZICS_INDEX_PREVIOUS="databases/rezics/lucene-untrusted-$(date -u +%Y%m%dT%H%M%SZ)"
if [ -d databases/rezics/lucene ]; then
  mv databases/rezics/lucene "$REZICS_INDEX_PREVIOUS"
fi
mkdir -p databases/rezics/lucene
java -Xmx4g -cp "$FUSEKI_HOME/fuseki-server.jar" \
  jena.textindexer --desc="$FUSEKI_BASE/fuseki-text.ttl"
```

4. Require successful indexer exit. It adds documents from existing RDF; always
   start with an empty replacement index, not a partially failed index. It is an
   offline scan, not an incremental consumer of REZICS outbox checkpoints. On
   failure keep the service fenced, retain diagnosis and retry with a fresh empty
   replacement after correcting the cause.
5. Start Fuseki privately with the same assembler. Verify known additions,
   deletions using the quickstart’s retained-graph/no-join probe, named-graph separation and representative
   analyzer cases. Product probes also check authorized/denied matching and snippets.
6. Record the rebuilt generation and its graph fence, invalidate text handles and
   caches, then activate text readiness and resume Main/consumers. Do not fabricate
   a committed sequence from the largest Lucene document. Retire old index copies
   according to erasure and retention policy.

The [6.2.0 text indexer source](https://github.com/apache/jena/blob/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/cmd/textindexer.java)
provides the `--desc` interface and dataset scan. New product mappings, document
producers or selective indexing require their own rebuild-equivalence acceptance;
the bootstrap's simple predicate map does not certify those future configurations.
Rebuilding a large index may extend the outage; no duration has been measured here.

## Bulk load, compaction and drills

Prefer owner commands for ordinary writes so the text wrapper, graph receipts and
invariants participate. A controlled offline import uses TDB2 tools and a complete
RDF dataset export preserving named graphs; it then rebuilds text and reconciles
product manifests/positions before activation. Do not copy TDB1 loader examples
into this TDB2 deployment, and do not infer that loading RDF reconstructs missing
product history or outbox records.

TDB2 compaction can create a new physical generation while retaining older files.
That is neither backup nor selective erasure. Whole-store rewrite/import, old
fileset retirement and backup expiry follow the [erasure runbook](erasure.md).
Drills cover process/host loss, interrupted update response, text index corruption,
missing payload, old backup plus newer erasure journal, lost consumer checkpoint,
upgrade interruption and writer fencing. These are implementation acceptance
requirements; this documentation change executed none of the runtime drills.
