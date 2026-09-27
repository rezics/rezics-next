# Backup, restoration and index recovery

The initial deployment accepts a maintenance window and manual restoration. It
does not promise replica failover, zero data loss or a turnkey product restore.
Keep Fuseki as the only JVM opening its TDB2 and Lucene paths. Stop it before
copying them; a live recursive copy or a second JVM is not a backup.

## Recovery set and positions

1. Choose and record a recovery cut. Pause admission, outbound effects and
   workers; drain in-flight commands. Record the graph `{datasetId, dataEpoch,
   sequence}` (sequence as decimal text), each owner's PostgreSQL/WAL position,
   the relay checkpoint and object cut separately. Independent stores have no
   global atomic snapshot. Preserve an independently retained **current**
   authority, deletion and erasure frontier; an old backup cannot prove that
   later restrictions did not happen.
2. Stop Fuseki and capture its entire TDB2 database root, Lucene directory,
   assembler, exact Jena archive/checksum, Java build and index/analyzer pins.
   Include Content, Account, Access and operations PostgreSQL backups and WAL;
   exact Content revision bytes/manifests and publication pins; immutable
   manifests/payloads; receipts/outbox, consumer positions, source observations,
   authority/erasure journals, model/configuration and protected keys. TDB2
   alone cannot recover bodies or authority. Lucene is derived.
3. Keep backups, checksums and signed coverage in protected off-host custody.
   Keep `RECOVERY_MANIFEST_HMAC_KEY` (an independent random 32-byte hex key)
   separately from both manifests and backups. Keep continuous WAL from before
   the base backup through the chosen cut. Record custody and expiry under the
   [erasure procedure](erasure.md). A local staging copy is not host-loss
   protection.

The [graph coverage capture](../../services/main/src/graph-recovery-coverage.ts)
requires `CONTENT_RECOVERY_DATABASE_URL` even for a graph without Content
references. Stop Account, Access, Content, graph and relay writers, let relay
catch up and drain retained Account deletion intents. Hold the
[Access capture fence](../../services/main/src/access-capture-fence.ts), then
capture signed graph coverage with the retained relay database and object-store
credentials. Save the fence generation and release the **source** fence
only after the stopped backup finishes. The capture compares owner rows,
receipts, relay handoff, exact graph references and immutable objects. Its
[Content](../../services/main/src/modules/work/content-recovery-coverage.ts)
and [Access](../../services/main/src/modules/work/access-recovery-coverage.ts)
scanners discover owner tables from the PostgreSQL catalog; the
[discovery drill](../../tests/qa/fault-recovery/recovery-coverage-discovery.test.ts)
checks new tables, row references, exclusions and keyset paging. A version-four
or older owner digest needs a new fenced capture. Match the schema generation
and PostgreSQL major version when comparing row digests.

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

1. Verify the backup checksum and release pins. Restore into **new empty**
   volumes/clusters, never over a running or failed owner. Keep the original
   fenced and do not serve it beside its restored successor. Check assembler
   paths so a restored Fuseki cannot open the original state. Start restored
   services privately, with reads, writes, delivery and workers held.
2. Apply the current authority, deletion and erasure journals before user reads.
   Compare restored Account, Access, Content, relay and immutable-object cuts
   against the separately retained signed coverage. Reconcile unknown outcomes
   using owner/provider receipts, retain pins for unresolved work, and keep
   missing required data unavailable. A newer graph cannot use an older Content
   body; newer unused Content revisions are not publication authority.
3. On the fenced graph restore, use the internal
   [lineage cutover](../../services/main/src/modules/work/restore-lineage.ts)
   to allocate a fresh `dataEpoch` with sequence zero and `rv:restoreHold`.
   Existing receipts retain their old positions. This invalidates old cursors,
   handles, caches and workers. Supply the signed coverage and any deletion
   sets to `POST /v1/owners/reconciliations` with `kind: "restore"`,
   `profile: "owner-reconciliation-v1"`, `sealedCoverage`, `Idempotency-Key`
   and an `owner:operate` bearer token. A held result needs repair and a new
   idempotency key; do not reopen Access while graph release is held.
4. Rebuild derived projections and text from exact revisions and approved
   recipes after authority/erasure reconciliation. Check known graph values,
   named graphs, retained deletions, Content bytes, object hashes, receipt and
   outbox positions, search additions/deletions and authorized/denied reads.
   Release the graph hold only on matching retained coverage, then reopen
   Access, resume consumers at verified checkpoints and route traffic.

The retained relay head and signed envelope reject older captures and mixed
cuts, but they cannot prove the supplied external frontier includes every later
authority, erasure or external effect. If custody or coverage is incomplete,
keep affected reads and outbound effects offline. The
[local graph drill](../../services/main/tests/evidence/2026-09-24-relay-recovery-coverage.xml)
and [Work replay drill](../../services/main/tests/evidence/2026-09-24-work-outcome-reconcile.xml)
exercise selected held restores; they do not qualify a coordinated production
restore. Editorial protection decisions and applications also need exact owner
and graph coverage before adoption resumes; the pending
[protection cases](../../scripts/qa/cases/editorial-protection.ts) do not yet
qualify backup-before-protection or interrupted replay. An absent restored
protection record must not be interpreted as an open protection state.

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
