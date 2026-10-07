# Backup, restoration and index recovery

The initial deployment accepts a maintenance window and manual restoration. It
does not promise replica failover, zero data loss or a turnkey product restore.
Keep Fuseki as the only JVM opening its TDB2 and Lucene paths. Stop it before
copying them; a live recursive copy or a second JVM is not a backup.

## Recovery set and positions

Stop Main, Account, relay and outbound workers for a maintenance window. Keep
storage running while the command fences owner logins, drains active transactions
and holds Access admission. An unresolved admission needs receipt reconciliation
before capture. The command then records one signed graph/owner cut, takes a
physical PostgreSQL base backup with streamed WAL, stops storage and captures
TDB2, Lucene and both filesystem and S3 immutable objects. Account, Access,
Content and relay share the local PostgreSQL cluster; operations state belongs
to relay. An undeclared database or an owner table without a primary key or an
explicit coverage exclusion fails capture.

```sh
export RECOVERY_MANIFEST_HMAC_KEY=<independently-retained-64-hex-key>
export OPS_RECOVERY_FRONTIER=<protected-current-frontier-file-outside-the-set>
task ops:backup -- --out <new-directory> --recipient <full-public-key-fingerprint>
# For an isolated persistent QA source, append:
# --profile qa --run-id <source-id> --persistent
```

The [backup command](../../scripts/ops/backup.ts) uses the existing Access fence,
[graph coverage capture](../../services/main/src/graph-recovery-coverage.ts),
two-owner deletion sets and catalog scanners. It encrypts each standard archive,
configuration and signed manifest with
[GnuPG recipient encryption](https://www.gnupg.org/documentation/manuals/gnupg26/gpg.1.html).
The source may hold the recipient's public key only; its private key lives
off-host. `RECOVERY_MANIFEST_HMAC_KEY` never belongs in stack configuration or
the set. The authenticated `set.json` binds encrypted artifact checksums to the
manifest. Release image identities, schema digests, the running assembler bytes
and checksums, JAR checksums, analyzer pins and the Java build accompany it.
[PostgreSQL 18's streamed WAL backup](https://www.postgresql.org/docs/18/app-pgbasebackup.html)
provides the complete physical replay boundary; `pg_verifybackup` checks it
before packaging and restoration.

The current frontier file is atomically replaced only after every encrypted
artifact is complete. Retain it independently with the current authority,
deletion and erasure journals, refresh it after restrictions, and keep its
custody separate from backup custody. Copying an old frontier beside an old set
cannot establish current authority. An older or different supplied frontier
fails closed; the command does not guess which newer restrictions to replay.
Keep encrypted sets and checksums in protected off-host custody with expiry
under the [erasure procedure](erasure.md). Local encryption is staging, not
host-loss protection; transfer and scheduling belong to deployment.

Successful capture briefly restarts only PostgreSQL to release the source
Access/login fences, then stops it again. It leaves product processes and graph
storage stopped. Before frontier publication, a failed capture releases only
the Access generation and owner login fence it created, removes the incomplete
output and restarts storage for a retry with the same output path. The previous
frontier stays unchanged. Main, Account and worker processes remain stopped.
After publication, a failure preserves the complete set and keeps storage
stopped. A pre-existing hold is never reopened. If cleanup cannot release its
own generation, repair the source recovery state before resuming product
processes; unresolved delivery evidence must stay held.

The [discovery drill](../../tests/qa/fault-recovery/recovery-coverage-discovery.test.ts)
checks new tables, row references, exclusions and keyset paging. The whole-set
scanner applies the same catalog checks to Account and relay as well. A
version-four or older owner digest needs a new fenced capture. Match the schema
generation and PostgreSQL major version when comparing row digests.

## PostgreSQL WAL recovery boundary

Restore each owner into an isolated PostgreSQL cluster with its retained base
backup and WAL. A successful startup can be an older valid point after an archive
gap. Capture the [WAL frontier](../../services/main/src/pg-recovery-frontier.ts)
after the last admitted mutation, outside the backup, and verify it against the
completed restore before routing. That check bounds the flushed LSN and cluster
identity; separately review timeline ancestry and compare current owner rows,
receipts, authority and erasure. The [Access WAL drill](../../services/main/tests/access-pitr.integration.test.ts)
and [Account WAL drill](../../services/account/tests/account-pitr.integration.test.ts)
demonstrate that omitted WAL can restore revoked credentials or deleted users.

For a deleted member, retain the signed
[two-owner recovery set](../../services/account/src/deletion-recovery-set.ts)
and independently retained relay deletion intent and subject tombstone. Verify
both isolated Account and Access cuts before either owner or Main is routed.
Supply every required signed deletion set at graph hold release. The
[two-owner drill](../../services/account/tests/evidence/2026-09-24-account-access-recovery.xml)
checks mixed cuts; the [erasure-frontier fixture](../../tests/qa/fault-recovery/account-erasure-frontier.test.ts)
checks a retained journal against an older restore. Neither proves that an
unknown later erasure was captured.

Private search deliveries are part of Access state. During a hold, run
`ACCESS_DATABASE_URL=<Access owner URL> task access:pending-search`. An armed
delivery requires its matching receipt; socket close or elapsed time does not
prove cancellation. Leave an unresolved armed row `delivering` and keep the
Access fence closed. Do not edit it to clear a pending closure.

## Isolated restoration

On the recovery host, make the recipient private key available through GnuPG's
protected keyring or agent and supply the independent HMAC key and **current**
frontier. Fence the original project; it cannot run alongside its successor.

The release must supply an authenticated `RestoreChecks` adapter before target
creation. The default CLI has no deployment adapter and refuses before target
mutation when those checks are missing. The invocation below applies only to a
release with that owner integration:

```sh
task ops:restore -- --set <directory> --project rezics-qa-<new-id>
```

The [restore command](../../scripts/ops/restore.ts) checks authenticated inventory,
all encrypted checksums, the independent frontier, release pins and safe archive
paths before creating storage. It refuses the original project, existing
configuration, existing containers and existing volumes. It restores one physical
PostgreSQL cluster into new volumes and verifies the running assembler, JAR and
Java pins against the captured source and repository. It then allocates a fresh
graph `dataEpoch` with sequence zero and `rv:restoreHold` before owner and sample
verification. It verifies WAL replay and every discovered owner's exact rows,
graph Content references, immutable object hashes and required signed deletion
sets. Existing receipts retain their old positions;
old cursors, handles, caches and workers cannot cross that boundary. Owner login
roles and Access remain closed throughout. It rebuilds Lucene offline with the
pinned assembler and erasure-aware indexer.

The integrated command keeps the copy held through replay and verification.
Its `RestoreChecks` interface must check exact samples, authorized and
denied reads, retained deletions/revocations, representative search
additions/deletions and both Account and library takeout. Authenticate through
Account and invoke `POST /v1/owners/reconciliations` with
`kind: "restore"`, `profile: "owner-reconciliation-v1"`, signed coverage,
required deletion sets and a unique `Idempotency-Key`. Only a matched reconciled
response permits Access and login release. Account authentication is never
replaced by a recovery-command assertion.

The default CLI cannot create a physical held copy without authenticated
checks. The QA drills supply an in-process Main route adapter with test
authentication; they require no listening Main or environment-selected
verification Task. Replay uses the independently retained current relay, not the
restored backup's own journal. Keep the graph and Access holds closed throughout
retained erasure replay. Held erasure replay must authenticate exact target/epoch
and original receipt evidence while preserving diagnostic sequence zero,
restore lineage and the prior cursor; ordinary suppression cannot substitute
for that replay. Release the graph only inside the retained-erasure callback,
after current journal, authority, live-copy and exact original custody checks,
then release the captured Access fence generation on its held client. Missing
or divergent evidence keeps the copy unavailable. A newer authority/erasure
frontier still needs the owner's verified replay and reconciliation; it is never
permission to reopen a stale cut. A held result needs repair and a new
project/idempotency key, not a forced Access reopen. Failed copies
preserve their stopped volumes and `recovery-evidence.json` for diagnosis;
remove only that failed target when discarding it.

After verified release, start Main, relay and consumers on the restored project,
resume at the retained, verified checkpoints, then route traffic. Do not serve
the original project beside its restored successor.

Editorial protection decisions and applications also need exact owner and graph
coverage before adoption resumes; the pending
[protection cases](../../scripts/qa/cases/editorial-protection.ts) do not yet
qualify backup-before-protection or interrupted replay. An absent restored
protection record must not be interpreted as an open protection state.

### Timed recovery drill

Each backup and each complete restore has a 600-second command deadline. Restore
includes decryption, copying, startup, WAL replay, full owner comparison, lineage
cutover, Lucene rebuild, samples and serving verification. Phase durations and
elapsed time are recorded in `backup-evidence.json` and `recovery-evidence.json`.
This is the acceptance ceiling. The measured command runs appear below. The
[small command drill](../../tests/qa/fault-recovery/g-727-recovery-set.test.ts)
checks encryption with a public-only capture keyring, retry after a failed
encryption phase, two-owner deletion, revocation, exact available/denied Content
reads, search, Account archive and release ordering. Its test authentication
adapter does not qualify deployment
OAuth or library takeout.
The small run `20261001t012136-664edd` passed on 2026-10-01: the verified
restore took 51.6 seconds and the complete harness took 249.0 seconds, including
preparation, an intentionally failed capture, immediate backup retry and a
separate intentionally held restore. This one-Work
command fixture is evidence of composition, not launch-data performance.

The [fixture drill](../../tests/qa/fault-recovery/g-727-launch-drill.test.ts)
does not skip: by default it takes a compatible retained `small` fixture and
runs `task fixture:restore` to obtain its own writable source. It never builds
the background corpus. `G727_LAUNCH_PROFILE=small` or `medium` selects the
profile; `G727_LAUNCH_FIXTURE` can pin the retained backup. Routine QA generates
separate temporary public/secret keyrings and removes them and its encrypted set
after the drill. The source's actual Work count, exact read, deletion, revocation,
search and Account archive are
checked with the same in-process adapter as the one-Work harness.

With exclusive host capacity, the manager prepares the 100,000-Work `medium`
fixture and restores a copy before the timed run:

```sh
task fixture:build -- --profile medium
task fixture:restore -- --fixture <fixture-id> --run-id fixture-g727-src
```

Set `G727_LAUNCH_SOURCE_RUN_ID=fixture-g727-src` and
`G727_LAUNCH_EXPECTED_WORKS=100000`. Configure the independent HMAC key and
frontier above, `OPS_RECOVERY_RECIPIENT`, a public-only `GNUPGHOME`, and
`OPS_RECOVERY_OFFHOST_GNUPGHOME` for the separate recovery keyring. Run:

```sh
bun scripts/goal/goalctl.ts test tests/qa/fault-recovery/g-727-launch-drill.test.ts
```

The drill verifies successful `fixture:restore` evidence, checks the actual Work
count, captures the source and times restoration. It records the source fixture,
count and per-phase evidence in `g-727-launch-restore.json`. It removes its
generated target and, when it prepared the source itself, that source copy.
The medium run `20261001t080856-bf552b` passed on 2026-10-01 against commit
`46a781ef`. It restored retained fixture `fx-medium-a4967fbb7f18` as
`fixture-g916-src5`, verified the actual count of 100,000 Works, then completed
both timed commands:

| Command | Elapsed | Deadline |
| --- | ---: | ---: |
| Backup | 476,766 ms | 600,000 ms |
| Verified restore | 345,104 ms | 600,000 ms |

Source preparation took 247,452 ms before these command timers. The complete
QA harness, including source probes and target teardown, took 962.9 seconds.
Backup coverage took 214.0 seconds and physical copy took 161.1 seconds.
Restore included 103.6 seconds for WAL and owner coverage, 24.0 seconds for
Lucene rebuild and 95.9 seconds for owner reconciliation before serving release.
The run retained `g-727-launch-restore.json` with both commands' complete phase
and budget evidence. These are medium-fixture command measurements on the shared
QA host; the manager's integrated exclusive run owns launch RPO/RTO qualification.

## Online public-name and rating-population backfill

Public-name and rating-population projection upgrades do not need this offline
rebuild when the existing text index is healthy. Deploy Fuseki command module
`0.5.35`, apply Access migrations `1007`–`1009` through
`task ops:migrate -- <private-env-file>`, and deploy Main from the same release.
Run `task search:names:backfill -- --batches 64` on the saved stack; repeat
until its JSON result has `complete: true`. For an isolated persistent QA stack,
append `--profile qa --run-id <id> --persistent`. Writers stay online. The command
first mirrors Agent visibility/listing policies, then derives public names,
sorted browse directories and receipt-backed rating counters. Each native command
holds at most 64 identities; epoch-specific Access checkpoints and graph receipts
resume after interruption without a population ceiling. Main startup attempts
one policy batch and logs a failure without preventing startup. Legacy Agent
names remain withheld until their Access policies are known, and rating reads
flag an incomplete counter backfill as stale. Use `--restart` only to rescan the
current epoch; it retains graph receipts and does not duplicate rating counts.

## Discovery projection rebuild

After backfill, activate a fresh Discovery generation (`discovery-source-v3`)
through its generation-build/advance/activation API. Until then reads serve the
pinned generation's values with `stale: true`. With `work:read` and the Access
recommendation-management grant:

1. POST `/v1/discovery/generation-builds` with an `Idempotency-Key`, profile
   `discovery-generation-build-v1`, an `actingSubject`, and basis
   `{ "scope": "global", "realm": null, "context": null }`.
2. POST `/v1/discovery/generations/{generation}/advance` with `actingSubject` and
   the returned `expectedCheckpoint`; repeat with each new checkpoint until
   `complete: true`. A concurrent change to an old Work can return 409; restart
   the build from a current cut.
3. GET `/v1/discovery/generations/{generation}?actingSubject=...` for
   `activeHeadRevision`. POST `/v1/discovery/generation-activations` with a new
   `Idempotency-Key`, profile `discovery-generation-activation-v1`,
   `actingSubject`, `generation`, and that value as `expectedHeadRevision`.
4. Repeat for each used Realm basis, with `scope: "realm"` and its Realm IRI.

## Offline TDB2 compaction

Compaction rewrites the current graph; it neither collects revisions nor rebuilds
Lucene. Pinned Jena 6.2.0's
[`tdbcompact`](https://github.com/apache/jena/blob/jena-6.2.0/jena-cmds/src/main/java/tdb2/tdbcompact.java)
retains the old generation by default. Its
[Linux implementation](https://github.com/apache/jena/blob/jena-6.2.0/jena-tdb2/src/main/java/org/apache/jena/tdb2/sys/DatabaseOps.java)
closes `Data-(N+1)-tmp`, moves it to `Data-(N+1)` and switches the container.
Restart selects the highest final generation and removes temporary ones.
Failure can occur after publication; exit status alone cannot choose recovery.
This is not a power-loss durability guarantee.

Retain a verified stopped-state recovery set with the paired Lucene cut and
current authority/erasure frontier. Stop Main, Account, relay and all
writers/consumers, then SIGTERM Fuseki and wait for orderly exit. Never
manufacture `clean-stop` or remove either lock. The
[operator command](../../scripts/ops/compact-tdb2.ts) runs only an offline
container against the saved image/volume; it does not stop or restart services.
It refuses an image whose owner entrypoint differs from this release. Regenerate
and rebuild the pinned image before maintenance after an owner-script upgrade.
The [compactor](../../infra/jena/compact-tdb2.sh) refuses a live `owner.lock`,
unclean stop, incomplete maintenance fence or multiple retained generations.

```sh
task ops:compact -- compact --window <maintenance-name> \
  --retain-until <YYYY-MM-DDTHH:MM:SSZ> --reserve-bytes 1073741824 --writers-stopped
task ops:compact -- status --window <maintenance-name> --writers-stopped
# Append to every command for an isolated persistent QA source:
# --profile qa --run-id <source-id> --persistent
```

Expiry must be future UTC. Required free space is twice the larger of allocated
and apparent source size, plus the reserve (default 1 GiB). Peak planning is
existing filesystem use plus this allowance; the old source stays allocated.
The [single copy transaction](https://github.com/apache/jena/blob/jena-6.2.0/jena-tdb2/src/main/java/org/apache/jena/tdb2/sys/CopyDSG.java)
includes all quads and prefixes. Twice the source allows for destination indexes,
journal and transient files; it is not a measured upper bound or a reservation.
Stop competing disk consumers, account for quotas/snapshots, monitor free space
and qualify this assumption on the deployment workload. Retire the previous
successful window before another compaction. Quarantined replacements still
consume disk until explicit custody cleanup.

Keep `databases/rezics/compaction/<maintenance-name>/` with the maintenance
record: generation names, expiry, space evidence, timestamps, phase and
`jena.log`. Success preserves the old generation and Lucene files; expiry does
not delete them. The existing zero-argument sanitized-candidate caller receives
a named `compact-<UTC timestamp>` seven-day window and the same default reserve.

Before reopening writers, compare exact graph/prefix coverage, epoch/sequence,
owner receipts, Content references and erasures/revocations with the retained
cut. Check `/health/ready`, `/health/search-ready`, representative additions and
deletions, named graphs, CJK queries and authorized/denied snippets before
reopening consumers. Counts alone do not verify the cut. Uncertain text needs
the Lucene procedure below. Retain these results before retirement.

Failure/interruption leaves the existing `databases/purge.incomplete` startup
fence with this window's identity. The owner refuses that fence (its diagnostic
still refers to erasure cutover). Ensure the compactor JVM/container has exited;
a CLI timeout may leave it holding the lock. Inspect status/logs, keep writers
stopped and recover explicitly:

```sh
task ops:compact -- rollback --window <maintenance-name> --writers-stopped
```

Rollback quarantines the recorded final/temporary replacement outside `tdb2`,
retains the source and diagnostics, and releases only its own fence. The same
command resumes interrupted rollback. Successful compaction can roll back only
before Fuseki consumes its original clean-stop marker. After an owner restart,
restore the whole paired recovery set with current authority/erasure
reconciliation: old RDF alone cannot reverse newer writes and Lucene changes.
Verify recovery before resuming services; never clear the fence by hand.

After expiry, stop writers and Fuseki cleanly again, review graph/text
verification and the recovery set, then acknowledge explicit retirement:

```sh
task ops:compact -- retire --window <maintenance-name> --verified --writers-stopped
```

This refuses early expiry, missing replacement and unexpected generations,
unlinks only the recorded source, retains timestamped acknowledgement and
resumes interrupted deletion. Snapshots, backups and media need separate
custody/erasure retirement. Failed/quarantined replacements remain for diagnosis
and explicit cleanup.

The [offline fixtures](../../infra/jena/tests/compaction.test.ts) use a stand-in
JVM to check refusal, publication failures, inherited locks and recovery;
they establish neither populated Jena timing nor peak space. The manager still
needs an exclusive drill: restore two isolated copies of one retained `medium`
fixture with `task fixture:restore`, verify an actual 100,000-Work count, then
cleanly stop each. On the first, time `ops:compact compact`, compare exact
graph/prefix/owner coverage, and exercise rollback before resume. On the second,
time compaction, verify graph and representative text reads with product writers
held, cleanly stop again, wait for the named expiry and explicitly retire.
Record fixture/image, allocated/apparent bytes, minimum free space and peak
replacement allocation, command/phase durations and outcomes. Each maintenance
command has a 600-second ceiling; record preparation/restore separately against
the 600-second preparation budget. No live populated drill is qualified here.

## Offline physical erasure campaign

Fence admission, publication, projection and disclosure through the existing
erasure journal, quiesce writers and cleanly stop Fuseki. Retain a verified
paired recovery set and current authority/erasure frontier. Run these scripts
inside the release's pinned Fuseki image with its saved volume; do not open a
second JVM on a live owner or manufacture `clean-stop`.

Prepare one protected `campaign.tsv` from committed exact Content revision and
erasure-epoch pairs. Each row is a lower-case UUID Content revision URN, one tab,
a positive decimal epoch of at most 19 digits, and LF. Supply 1–64 rows, without
headers, comments, blank rows, CRLF or repeated revisions. Input order and every
byte are part of the SHA-256 identity. Keep this file immutable throughout the
campaign. An existing graph tombstone must carry the supplied exact epoch; a
missing graph target or conflicting epoch rejects the whole copy.

```sh
sh /path/to/purge-tdb2.sh /fuseki/databases/erasure-candidate --campaign /protected/campaign.tsv
```

The [sanitizer](../../infra/jena/purge-tdb2.sh) snapshots the exact campaign,
copies retained quads and prefixes in one transaction, then compacts once and
rebuilds one empty Lucene index. It preserves each target's `ErasedRevision`
tombstone and epoch, unrelated public/private bytes, lineage and retained
model/command/object custody. Reserve space for the complete candidate,
compaction replacement and inaccessible source; qualify elapsed time and peak
space on the populated deployment cut before promising a maintenance budget.
The 64-pair bound limits one maintenance input, not the erasure backlog.

Before activation, verify every target is absent from sensitive graph triples
and direct public/private Lucene reads; confirm its exact tombstone/epoch.
Compare retained unrelated revisions, private/public data, prefixes, lineage,
receipts and model/command/object references against the stopped source and
owner inventory. Keep required immutable objects in custody; this graph command
does not retire them. Record these results, cleanly stop the candidate after any
read checks, then copy its `databases/rezics/erasure-purge.ready` to
`erasure-purge.verified`. The version-two record binds the exact campaign
digest/count, candidate identity and retained source identity/inventory. Missing,
corrupt, mixed or legacy two-line evidence fails closed.

```sh
sh /path/to/purge-activate.sh activate /fuseki/databases/erasure-candidate --campaign /protected/campaign.tsv maintenance-name
# Before the candidate has served, explicitly recover or undo this campaign:
sh /path/to/purge-activate.sh rollback maintenance-name --campaign /protected/campaign.tsv maintenance-name
```

The [activation command](../../infra/jena/purge-activate.sh) requires the same
state volume, stopped owners and exact verification. It retains the source at
`databases/rezics-retired-maintenance-name` and durable evidence at
`databases/erasure-retirement-maintenance-name`. An interrupted rename leaves
`databases/purge.incomplete`, so startup stays closed. Ensure the maintenance
process has exited; use the exact rollback command to recover an interrupted
activation or rollback. Never clear the fence by hand. Rollback restores only
the recorded unchanged source, quarantines the candidate and releases only its
own fence. It refuses after the candidate consumes its original clean-stop
marker: after serving, recover the whole paired set with current authority and
erasure reconciliation instead of swapping old RDF back beneath newer writes.

After successful activation and graph/text/owner verification, cleanly stop
writers and Fuseki again. Explicitly retire the recorded source:

```sh
sh /path/to/purge-activate.sh destroy maintenance-name --campaign /protected/campaign.tsv maintenance-name
```

Destruction binds the whole campaign, retirement ID and exact retained fileset.
It records authorization before unlinking and supports retry after interrupted
partial deletion; the evidence digest is reported only after the recorded
source is absent. Record that digest for the live TDB2/Lucene retention domains
of every campaign target. Snapshots, backups, media and immutable object copies
need separate evidence and remain retained or unverified until resolved.
Unlinking a fileset does not establish storage-media destruction.

The original single-target build and activation/destruction argument forms
remain adapters to this campaign implementation. They create version-two
campaign evidence; old two-line readiness markers are never reinterpreted.
The [native campaign checks](../../infra/jena/tests/erasure-campaign-native.test.ts)
exercise a 64-target TDB2 copy and direct Lucene queries; shell recovery fixtures
check evidence refusal, cutover interruption, rollback and exact retirement.
These fixtures establish correctness for their cuts, not populated timing or
peak allocation. The manager owns that separate qualification.

## Offline Lucene rebuild

Treat text as unavailable after uncertain index state, I/O failure, analyzer
change, bulk RDF load or unqualified restore. Reconcile exact Content revisions,
erasure and the RDF MatchUnit projection first. Stop Main writers and consumers;
retain the stopped-state backup and old index for diagnosis. On the development
stack or isolated persistent QA project, run `task search:rebuild -- --job <uuid>`
with a pinned image, assembler and state volume. The
[rebuild command](../../scripts/operations/rebuild-content-search.ts) checks
space and exclusive ownership, quarantines public search, replays exact Content,
indexes into an empty directory offline, compares Content/RDF/Lucene and
activates a new generation. Resume the same job ID after interruption. A failed
pass stays fenced; start a fresh empty index after correcting the cause.

Check `/health/search-ready` separately from `/health/ready`: verify the graph
epoch/sequence, generation, exact public MatchUnit inventory and representative
additions/deletions, named graphs, CJK terms and authorized snippets before
reopening text consumers. Do not infer a committed sequence from Lucene's
largest document. The [CJK drill](../../scripts/operations/verify_cjk_rebuild.py)
and SEARCH17 fault test cover selected rebuilds; they do not certify arbitrary
raw writes, new mappings or production duration. Qualify changed cuts and large indexes separately.

RPO/RTO require an owner-specific timed restore drill; backups and local tests alone establish neither value.
