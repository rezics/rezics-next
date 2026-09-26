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

A product recovery set additionally includes Content/Account/Access/operations
PostgreSQL backups and WAL positions, Content revision bytes/manifests and
publication pins, immutable semantic manifests and payload objects, operation
receipts/outbox, durable consumer progress, source observations, authority and
erasure journals, model definitions, configuration and protected keys. TDB2 alone
cannot restore Content bodies, external objects or private authority. Lucene is
derived; rebuilding requires a verified RDF projection and recipe. Regenerating
that projection additionally requires exact Content revisions and graph references.

Record `{datasetId, dataEpoch, sequence}` for the graph position; sequence is a
lossless decimal string in external manifests. Record each PostgreSQL and object
cut separately. Pause product admission and outbound effects when a coordinated
cut is required, drain in-flight commands, record the positions, stop Fuseki and
capture the participating stores. Independent backups have no global atomicity.
Reconcile owner receipts and retained outbox records before reopening a mixed cut.

## Content and projection reconciliation

The PostgreSQL Content binding is a selected target, not covered by the existing
Account/Access drills below. Its recovery set includes revision identity/digest,
bytes/manifests, local heads, receipts/outbox, preparation pins, source lineage,
consumer checkpoints and separately retained authority/erasure frontiers.

The internal graph coverage capture requires `CONTENT_RECOVERY_DATABASE_URL`
alongside the other recovery database URLs, even when the graph has no Content
references. Its version-three signed envelope records the Content owner
epoch/sequence, exact graph references, and full row digests of `content.*` and
the five Go and one Cargo `pkg.*` evidence tables, including retained bytes,
checksum notes and immutable Cargo snapshots.
Supply the isolated restored Content pool to graph hold release; absent or
different Content or package rows keep the hold. Older version-one/two and
graph-only envelopes require a fresh fenced capture before release. This check requires
externally quiesced Content writers and is conservative about a different Content
cut; separately qualify any newer unused revisions before capturing a new cut.

Restore owners into isolation; fence publication, disclosure-sensitive reads and
outbound effects. Reconcile graph references against exact Content revisions and
durable preparation outcomes. A newer graph with an older Content cut cannot
substitute a current or same-language body. A newer Content cut may retain unused
revisions; it must not publish them without a graph outcome. Unresolved operations
keep their retention pins until reconciled; missing required data stays unavailable.

After current authority/erasure reconciliation, replay or regenerate approved
MatchUnits from exact revisions using the retained extraction recipe. Verify the
RDF projection's completeness before the offline Lucene rebuild below. Record
both owner positions plus projection/index generations, invalidate old handles
and activate only the supported coherent search view. Stale events and restored
bytes must not resurrect erased text. Maintenance may pause search; ordinary
content delay does not authorize exposing an unreconciled restore.

OPS03/09/11/12/15/16 and SEARCH19–20 require actual mixed-cut, missing-body,
lost-checkpoint, stale-event and two-stage reconstruction evidence in P0.8.

## PostgreSQL WAL recovery boundary

PostgreSQL 18 [continuous archiving and PITR](https://www.postgresql.org/docs/18/continuous-archiving.html)
can recover Access's committed authority, admission, receipt and outbox rows from
an older base backup when every required WAL segment was retained. Archive from
before the base backup, keep the base backup and continuous WAL in protected
separate custody, then replay into an isolated cluster with `recovery.signal` and
`restore_command`. Verify the recovered Access outbox and row digests against an
independently recorded current frontier before releasing its recovery fence.
An archive gap can let PostgreSQL finish recovery at an older valid point; a
successful startup alone does not prove the latest revocation survived.

After quiescing an owner, the [frontier CLI](../../services/main/src/pg-recovery-frontier.ts)
can capture its PostgreSQL cluster ID and flushed WAL LSN. Store the output in
protected custody outside the cluster and backup. On an isolated completed
restore, verify that same file before any owner routes reopen:

```sh
PG_RECOVERY_DATABASE_URL="$OWNER_DATABASE_URL" bun services/main/src/pg-recovery-frontier.ts capture > "$RECOVERY_MANIFEST_DIR/owner-frontier.json"
PG_RECOVERY_DATABASE_URL="$RESTORED_OWNER_DATABASE_URL" bun services/main/src/pg-recovery-frontier.ts verify "$RECOVERY_MANIFEST_DIR/owner-frontier.json"
```

The check rejects a different cluster ID or replay LSN below the retained source
position. Capture after the last admitted mutation; an earlier frontier cannot
prove that later revocations or erasures are absent. The LSN lower bound does
not verify timeline ancestry, the contents of owner rows, object state or
cross-owner ordering. Review timeline history and compare each owner's current
receipt, authority and erasure coverage before routing.

The [local Access WAL drill](../../services/main/tests/access-pitr.integration.test.ts)
uses a PostgreSQL 18.6 base backup, checks its manifest, commits a strong scope
closure and principal deactivation afterward, archives the segment, and restores
an isolated older copy. With that segment, both fences, full Access coverage and
denied commands return.
With the segment omitted, recovery yields different outbox and state coverage.
The older restore also has an active principal that the current source fenced.
The retained WAL frontier check rejects the incomplete restore; it passes after
full replay. The [Access manifest](../../services/main/src/access-recovery-manifest.ts)
authenticates that frontier together with the full Access outbox and
authority/admission row digests. Set `RECOVERY_MANIFEST_HMAC_KEY` to an independent
random 32-byte hex key for capture and verification; retain it separately from
the private manifest and backup. The local drill rejects changed content, a
wrong key and the older Access cut.
Its local archive is disposable and the package's missing `pg_waldump` limits
`pg_verifybackup` to manifest/file checks; actual WAL replay is exercised. This
drill does not establish off-host custody, continuous archive monitoring,
cross-owner erasure replay or a production RPO.

Private search deliveries are part of the Access recovery cut. The state digest
includes `access.search_read_lease`, including its durable send marker and
receipt digest. During a hold, inspect unresolved rows with
`ACCESS_DATABASE_URL=<Access owner URL> yarn access:pending-search`. An unarmed
row can be aborted through its owner; an armed row may finish only with its
matching client receipt. Socket close, elapsed lease time and process death
do not prove that buffered result bytes were cancelled. An armed row without
a receipt remains `delivering`, and `releaseAccessRecoveryFence` refuses to
reopen Access. Preserve that hold and escalate the unresolved row identity;
do not edit the row to clear a pending close.
Migration 010 preserves any `delivered` row written under schema 009 without
inventing a receipt or changing its historical outcome. Its new terminal-send
constraint is `NOT VALID` for that legacy data; PostgreSQL still enforces it
for every new or updated row. Keep those old terminal rows immutable in place.

The [Account WAL drill](../../services/account/tests/account-pitr.integration.test.ts)
uses the same physical recovery boundary for user authorization-code tokens.
A sign-out and a separate member deletion committed after the base backup remain
enforced after full archived WAL replay and Account service restart. The deleted
member's user and offline refresh rows remain absent. Omitting the later segment
produces a readable older Account database that accepts both still-signed tokens
and restores the deleted member and refresh row. The retained WAL frontier check
rejects the incomplete restore; it passes after full replay. The
[Account manifest](../../services/account/src/recovery-manifest.ts)
also compares every pinned Account table, including sessions, OAuth tokens and
the private authorization-code consent basis used to reject stale codes;
its row digest detects the missing sign-out and deletion mutations. Its HMAC
envelope rejects modified content and the wrong key. Set
`RECOVERY_MANIFEST_HMAC_KEY` to an independent random 32-byte hex key for both
commands, retain the key separately from the private manifest and owner backup,
and capture only after Account is quiesced. Do not
route an Account restore until its independently retained revocation/deletion
frontier is checked.
The deletion hook in this Account WAL drill records a simulated Access callback;
the full Work test exercises the real Access fence. These separate WAL drills do
not provide a coordinated Account/Access/graph restore or recover cross-owner
erasure state.

For one deleted member, the [two-owner recovery set](../../services/account/src/deletion-recovery-set.ts)
captures Account and Access cluster IDs, WAL positions, Account table coverage
and Access authority/admission/outbox coverage after both services and all other
writers are stopped while PostgreSQL remains available. Capture requires the Account
user to be absent, the matching Access principal to be inactive with retained
private deactivation and Account deletion intent facts, and all that principal's
admissions to be sealed. The intent is committed with the Access fence before
Account removes the user. If the later Account deletion fails, retain the intent
and reconcile the pending deletion while recovery stays held.
Set `RECOVERY_MANIFEST_HMAC_KEY` to a retained, independent random 32-byte hex key
before both commands. The CLI rejects a missing or invalid key and authenticates
the saved envelope with HMAC-SHA-256; verification rejects altered content or a
different key. Keep the key and private JSON in separate protected custody
outside both backups and WAL archives:

```sh
ACCOUNT_RECOVERY_DATABASE_URL="$ACCOUNT_DATABASE_URL" ACCESS_RECOVERY_DATABASE_URL="$ACCESS_DATABASE_URL" bun services/account/src/deletion-recovery-set-cli.ts capture "$ACCOUNT_ISSUER" "$ACCOUNT_SUBJECT" > "$RECOVERY_MANIFEST_DIR/deletion-set.json"
ACCOUNT_RECOVERY_DATABASE_URL="$RESTORED_ACCOUNT_DATABASE_URL" ACCESS_RECOVERY_DATABASE_URL="$RESTORED_ACCESS_DATABASE_URL" bun services/account/src/deletion-recovery-set-cli.ts verify "$RECOVERY_MANIFEST_DIR/deletion-set.json"
```

Verify both isolated completed restores before either owner or Main is routed.
The [local two-owner drill](../../services/account/tests/evidence/2026-09-24-account-access-recovery.xml)
uses separate PostgreSQL 18.6 clusters and post-backup Account deletion/Access
deactivation. Either mixed cut fails verification; full WAL replay for both
owners passes; modified content and a wrong key also fail. Graph hold release
requires one authenticated set for every retained Account deletion intent and
rejects a missing, stale or wrong-key set before graph release. The local drill
exercises the guard on restored owners and rejects a release with missing
evidence. With the pinned Fuseki runtime enabled, it copies a stopped graph
control cut, starts the isolated copy under a new held lineage, and releases
against an independently retained relay checkpoint after both PostgreSQL owners
replay the deletion WAL. It then verifies graph admission reopens. The graph cut
has no Work outcomes; this does not qualify their reconciliation or a global
atomic snapshot. Run that branch by setting `REZICS_FUSEKI_HOME` and
`REZICS_JAVA_HOME` to the pinned local runtime paths.
The HMAC uses Node's [HMAC and timing-safe comparison](https://nodejs.org/api/crypto.html)
APIs. It protects integrity, not confidentiality or key custody. This verifier
does not prove that a supplied set covers every deletion after an older Access
backup, cover other deleted subjects or replay an independent erasure journal.
Preserve those holds for full product recovery.

The registered [isolated erasure-frontier fixture](../../tests/qa/fault-recovery/account-erasure-frontier.test.ts)
uses the QA Compose stack and its project-scoped physical backup command. It
checks an older Account/Access cut against the independently retained relay
deletion journal and subject tombstone, then checks a complete post-deletion
cut before graph release. Its graph contains no public Work or Content, so this
fixture does not establish their survival or physical credential sanitization
from historical backup files.

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

The internal Main [lineage cutover helper](../../services/main/src/modules/work/restore-lineage.ts)
guards the exact recorded old epoch, routing epoch and sequence, writes a fresh
epoch with sequence zero under `rv:restoreHold`, and rereads control after an
ambiguous response. Main reports 503 while held; guarded create/edit writes
also reject activation. The internal release compares the restored cut with
an independently retained prior graph position, Account WAL position and full table row coverage,
Access outbox count/digest, Access authority/admission row count/digest, and relay
checkpoint, batch-header digest and envelope digest. Apply relay migrations 004–006,
stop Account, graph and Access writers, let the graph relay catch up, then drain private Account deletion
intents into the separately retained relay database. Stop relay writers and
hold Access's recovery fence before capturing the authenticated coverage
envelope. Record the generation returned by `hold` and keep Access fenced
through the stopped-state backup:

```sh
ACCESS_DATABASE_URL="$ACCESS_DATABASE_URL" MAIN_RELAY_DATABASE_URL="$RELAY_DATABASE_URL" bun services/main/src/relay-account-deletions.ts once
ACCESS_RECOVERY_DATABASE_URL="$ACCESS_DATABASE_URL" bun services/main/src/access-capture-fence.ts hold
FUSEKI_URL="$FUSEKI_URL" ACCOUNT_RECOVERY_DATABASE_URL="$ACCOUNT_DATABASE_URL" ACCESS_RECOVERY_DATABASE_URL="$ACCESS_DATABASE_URL" RELAY_RECOVERY_DATABASE_URL="$RELAY_DATABASE_URL" CONTENT_RECOVERY_DATABASE_URL="$CONTENT_DATABASE_URL" RELAY_CONSUMER="$RELAY_CONSUMER" bun services/main/src/graph-recovery-coverage.ts capture > "$RECOVERY_MANIFEST_DIR/graph-coverage.json"
```

After the graph and participating stores are backed up and routing can resume,
release the source fence with the recorded generation:

```sh
ACCESS_CAPTURE_GENERATION=replace-with-generation-returned-by-hold
ACCESS_RECOVERY_DATABASE_URL="$ACCESS_DATABASE_URL" bun services/main/src/access-capture-fence.ts release "$ACCESS_CAPTURE_GENERATION"
```

This command requires `RECOVERY_MANIFEST_HMAC_KEY`; keep its output and key in
separate protected custody outside the restored stores. Capture stores the
latest signed coverage digest in the retained relay database before emitting
the envelope. Capture rereads Account WAL/rows, Access outbox/state and relay
coverage and rejects a changed source; this detects movement during the scan,
while the maintenance stop and Access fence keep the cut stable afterward.
Release opens that envelope with the retained key and locks the
matching relay head through graph release. A changed envelope, wrong key or
older valid capture keeps the hold. The retained relay database stays outside an
older graph/Access copy; stop its writer for the recovery comparison. A later
handoff than the graph cut or an uncheckpointed delivered event keeps the hold.
Release also requires the promoted restored Account database and compares its
PostgreSQL replay position and complete Better Auth row digest with the signed
source cut, even when no deletion intent exists. This rejects a mixed cut whose
Account WAL omitted a later sign-out or deletion when the current signed coverage
is supplied. Capture and release also compare the retained deletion journal with all Account
deletion intents in Access. The Account deletion hook verifies the exact relay
copy before it removes credentials; a relay outage leaves the user intact and
the Access fence ready for retry. The batch journal command remains useful for
verified backfill of earlier intents. An older Access cut missing a retained
intent stays held even when its own older signed coverage matches. The relay
also retains an Account subject tombstone before every authenticated deletion;
capture and release reject a restored Account that contains any tombstoned user,
including one who never had an Access principal. A deletion that fails after
tombstone retention requires retry or reconciliation before release. The relay
head rejects an envelope older than the last retained capture. It cannot prove
that Account and Access stopped mutating after that capture, or protect against
loss or rollback of the relay head itself. Historical deletions that bypassed
this hook also require journal backfill and independent proof.
For relay databases upgraded from before migration 006, stop Account, Access
and relay writers and run the [subject backfill](../../services/main/src/relay-account-subject-backfill.ts)
against the current Account and Access owners before capture. It reconstructs
only Access-bound deletion subjects whose Account user is absent. A still-present
user aborts the pass; historical deletions without an Access binding require
separate evidence and cannot be inferred from this scan.
Apply Access migrations through 006 and engage its global recovery fence after
stopping Main and outbound workers on the isolated restore. Ordinary Access admission,
claims, outcome recording and current read decisions then fail closed. Graph
hold release locks that fence through its Access outbox, state, restored Account
WAL/row coverage and Account deletion evidence checks and graph release. Supply the
restored Account database for every release, plus retained sealed deletion sets
when deletion intents exist. An ambiguous graph release response can be retried against the same
cut and sealed coverage. Reopen Access only after graph release succeeds. This
comparison cannot prove that the supplied envelope is the newest retained cut
or that it includes every later authority, erasure or external effect. If that frontier is unavailable or
differs, keep the hold and all affected reads/effects offline. Run these
helpers only on the isolated, fenced restore before admission. The
[local recovery drill](../../services/main/tests/evidence/2026-09-24-relay-recovery-coverage.xml)
copied stopped Fuseki, Access PostgreSQL and immutable object state, then
verified hold behavior, retained receipts/revisions and a new-lineage edit after
coverage matched. A second timeline committed an edit after the saved cut;
restoring that older cut with the final coverage kept the hold and rejected a
retry of the missing key before Access admission. The drill also replays a
separate Account PostgreSQL WAL archive through the signed cut and verifies it
at graph release, with no Account user mutation in that fixture. It does not cover later
Account mutations, later authority or erasure journals, downstream consumer
checkpoints or a coordinated production recovery set. A subsequent
[mixed-cut drill](../../services/main/tests/evidence/2026-09-24-work-outcome-reconcile.xml)
replayed missing committed metadata Work edit/create outcomes and terminal
cancellation/stale outcomes from retained relay records when their current sealed
Access admissions and exact immutable objects also survived. The replay kept the
graph held, restored original identities, revisions, receipts and outbox positions,
checked final Access/relay coverage, then released a new data epoch. An older
Access or object cut still kept the restore held. A strong Work creation closure
committed after the saved cut remains effective with current Access: an old sealed
create replays, while a new create is denied after graph release. The Access state
digest checks current rows but is not an independently retained authority journal.
The current digest also covers private reader and acting-context preferences,
Realm reading recommendations, their idempotency receipts and pending search
read leases. Restore the same Access schema generation before comparing a signed
cut; an older manifest's row digest is not interchangeable with this inventory.
The private source projection now has a bounded
[retained replayer](../../services/main/src/modules/source/reconcile-restored.ts)
for one complete Open Library Work conversion. It requires the held restore,
Access recovery fence, exact relay coverage, original event and complete
immutable Content source observation; it reconstructs the original source
receipt, three private source nodes, outbox event and ordered cursor. The
isolated [source replay case](../../tests/qa/fault-recovery/source-projection-recovery.test.ts)
passed `20260925t213510-a73d87`, including altered/missing-evidence refusal.
A complete coordinated source-to-native backup frontier and later authority/erasure
frontiers remain unreconciled. The selected two-event extension
`20260925t213841-0592bc` separately replayed source projection followed by
an Access-admitted Work creation from its proposal, then verified the private
binding against the restored Work receipt and rejected a changed binding proof.
It did not compare a complete saved PostgreSQL/object/graph backup frontier or
reconcile refresh and withdrawal. G-014's selected three-event extension
`20260926t064311-22920a` adds a second independent title support and retains the
first support's withdrawal. It replays both exact source projections and the
native Work creation before exposing the complete private collection, then
withdraws the second support without resurrecting the first. Source PostgreSQL
rows are retained during this held-graph test; a lagging Source backup and an
atomic Access/Source authorization cut remain unqualified. Abrupt Access
connection loss during its live lock envelope is also an open distributed
failure boundary. The retained relay handoff
keeps zero-event batch headers; the bounded replay restores those positions
under the recovery holds. On an installation upgraded from relay migration 002,
backfill old headers from a verified retained source before relying on coverage.

For each one-event retained replay, coverage, the selected event bytes and its
batch header are read from one repeatable-read relay snapshot. A row change
after the coverage scan cannot substitute a different event for that replay.
The full retained coverage scan still runs for each replayed position.

An old backup cannot prove that later revocations or erasures did not happen.
If the journal coverage is missing or uncertain, leave affected data and outbound
effects offline. RPO/RTO are selected by owner and demonstrated with a timed
restore drill; neither this recipe nor a scheduled backup establishes those values.

## Editorial protection recovery

This is a required extension for
[protected adoption](../contracts/editorial-protection.md), not an executed
recovery qualification. Include exact protection/control revisions and heads,
correction proposals/decisions, unique applications, rule/evidence references and
their receipts/outbox coverage in the owning backup/replay manifest. Jena owns
semantic protection; PostgreSQL owns protection of its local mutable heads.
Their cuts remain separate, with exact Content pins for graph adoption.

Keep the restored owner under its existing recovery hold while proving the
accepted frontier, replaying retained decisions and reconciling later source
withdrawal, authority and erasure restrictions. Restoring a backup made before
protection must not turn missing records into the profile's normal absent/open
state. A fresh epoch rejects stale workers but does not reconstruct lost decisions
or prove that no later protection existed. Missing or mismatched coverage keeps
protected writes/reads unavailable under the affected owner/scope boundary.

Reconstruct current projections from exact content plus protection/control and
acceptance state, not from content manifests alone. Reconcile proposal application
identities before accepting retries with old or new keys. Restore exact history
and erasure availability without changing the approved candidate or retargeting
a sealed release. Quality summaries are derived: check their full input generations
or mark them stale/pending and rebuild before presenting them as current.

Qualify backup-before-protection, mixed Content/graph cuts, missing application
receipts, interrupted replay and newer erasure/revocation evidence through
[the existing OPS/SYS protection subcases](../testing/editorial-protection.md).
An old passing restore fixture does not establish these additional records or
the completeness of the retained frontier.

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

4. Require successful indexer exit. It adds documents from existing RDF; it does
   not fetch PostgreSQL bodies or repair missing RDF MatchUnits. Reconcile and
   regenerate that projection before this offline pass when needed. Always
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

For the installed bounded public phrase profile, `GET /health/search-ready`
reports the graph epoch/sequence and text generation only when Main finds the
bootstrap profile, generation, CJK probe and a complete exact public MatchUnit
inventory in the index. Check it separately from `/health/ready` after an
isolated restore. A failed text check keeps public phrase responses unavailable
even when graph reads are ready. `yarn search:rebuild` implements a privileged
quarantine, exact Content replay, offline indexer pass on the named volume,
source/RDF/Lucene comparison and new-generation activation for the development
stack or an isolated persistent QA project. The positive fault/recovery drill
resumes after quarantine and checks a complete exact Content result after
restart. The SEARCH17 fault/recovery drill inserts RDF through a QA-only bare
TDB2 alias after quarantine, proves the RDF/Lucene mismatch cannot produce a
complete public result, then verifies exact Content and index membership after
the controlled rebuild activates a new generation. These drills do not qualify
a production restore or arbitrary unquarantined raw writes; keep those text
consumers fenced pending a separate changed-cut drill.

The [6.2.0 text indexer source](https://github.com/apache/jena/blob/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/cmd/textindexer.java)
provides the `--desc` interface and dataset scan. New product mappings, document
producers or selective indexing require their own rebuild-equivalence acceptance;
the bootstrap's simple predicate map does not certify those future configurations.
Rebuilding a large index may extend the outage; no duration has been measured here.

The local [CJK migration drill](../../scripts/operations/verify_cjk_rebuild.py)
exercises the StandardAnalyzer-to-`cjk-bigram-v1` change on a disposable dataset.
Its [result](../../tests/recovery/evidence/2026-09-24-cjk-rebuild.json) records the
old and new assembler digests, exclusive offline indexer exit, original Chinese
literal/language/graph binding after rebuild, and absence of a deleted value.
It does not certify Main's runtime text-readiness state or a production upgrade.

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
