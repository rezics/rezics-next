# Main startup and current command boundary

Main runs on Bun 1.4.2 with pinned Elysia 2.0.0-beta.16. Yarn 4.18.0 owns
dependency resolution. The service factory is importable without starting
Fuseki; the process entry listens on loopback and requires private Fuseki,
PostgreSQL Access and Account configuration.

```sh
corepack yarn install --immutable
export FUSEKI_URL=http://127.0.0.1:3030/rezics/
export ACCESS_DATABASE_URL=postgres://user:password@127.0.0.1:5432/access
export ACCOUNT_ISSUER=http://127.0.0.1:3002/api/auth
export ACCOUNT_MAIN_RESOURCE=https://main.rezics.test
export ACCOUNT_JWKS_URL=http://127.0.0.1:3002/api/auth/jwks
export ACCOUNT_INTROSPECT_URL=http://127.0.0.1:3002/api/auth/oauth2/introspect
export ACCOUNT_MAIN_CLIENT_ID=registered-confidential-client
export ACCOUNT_MAIN_CLIENT_SECRET=registered-client-secret
export MAIN_DATA_EPOCH=installed-dataset-epoch
export MAIN_ROUTING_EPOCH=installed-routing-epoch
export MAIN_OBJECT_DIRECTORY=/absolute/path/to/durable/objects
export MAIN_CANDIDATE_DIRECTORY=/absolute/path/to/private/candidates
export REZICS_JENA_HOME=/absolute/path/to/apache-jena-6.2.0
export REZICS_JAVA_HOME=/absolute/path/to/java-21
corepack yarn main:dev
```

`GET /health/live` checks the process; `GET /health/ready` queries Fuseki and
checks the configured data/routing epoch when the Work routes are installed. It
returns 503 when the graph is unavailable or Main has stale lineage configuration.
`POST /v1/works` is
the first authenticated product command. It accepts the fixed
`metadata-only-v1` profile, a title and an acting subject with an Account bearer
token and `Idempotency-Key`. The Account issuer must match discovery exactly.
The Access database must have migrations 001, 002 and 003 plus an admitted principal,
subject, representation, grant and `work:create:root` gate. The graph control
record must have the matching data and routing epochs. Startup does not create
or migrate authority state. `POST /v1/content-edits` uses an exact Work head
precondition and a `work:edit:{Work URI}` Access scope. `GET /v1/revisions/{id}`
verifies Account's `work:read` scope, current `work:read:{Work URI}` authority,
current Work presence and retained object digests. These routes cover one
metadata profile; wider deployment still requires recovery qualification.

The primitive validates a complete small Work/MainVersion candidate with the
[fixed profile](../../model/README.md), stages content-addressed immutable payloads
and manifests, then sends one conditional update through Fuseki's text wrapper.
The update writes current heads, revision anchors, an operation receipt, sequence
and outbox batch together. It looks up its own receipt after the update, including
after an ambiguous response. An unmatched guard stays pending; it is never treated
as success merely because Fuseki accepted the SPARQL request.

The [Access admission migration](migrations/access/001_admission.sql),
[claim/seal migration](migrations/access/002_claim_and_seal.sql),
[recovery fence migration](migrations/access/003_recovery_fence.sql) and
[`AccessAdmissionRegistry`](src/modules/access/admission.ts) use PostgreSQL 18
for a private principal/subject/representation/grant snapshot and a row-locked
scope gate. Registration commits its admission, receipt and outbox together.
Ordinary gate closure prevents later new admissions while earlier registered
operations retain a finite deadline. Claim and strong closure serialize on the
same scope gate row. Strong closure blocks later claims; a bounded reconciler
uses the same guarded graph receipt identity to record either a successful Work
or terminal cancellation, then seals the outcome in Access. An unavailable
Fuseki keeps the closure pending for a later pass. The
[`createAdmittedMetadataWork`](src/modules/work/create-admitted.ts) first verifies
Account's bearer assertion and scope, registers Access's principal, representation
and grant decision, then passes its admission ID, request digest, scope and epoch
to the guarded graph command. The graph receipt records that admission binding.
The storage test seeds authority fixtures directly and uses a fixture Account
verifier. The full Work test starts the real Account issuer, Access PostgreSQL,
Main HTTP adapter and Fuseki together. It uses a user authorization-code/PKCE
token to create, edit and read exact old/current Work revisions, then checks
sign-out denial on replay and read. Its Access fixtures grant and revoke exact
Work edit/read scopes. Grant mutation commands, restart/restore
reconciliation and wider claim/strong-revocation profiles remain required
before treating the route as fully qualified for deployment. The gate-first lock order
must be preserved by later grant and representation mutations. PostgreSQL's
[transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html)
and node-postgres's [single-client transaction rule](https://node-postgres.com/features/transactions)
inform this first binding.

To run the owner integration tests, provide PostgreSQL 18 binaries (`initdb`,
`pg_ctl`) and the extracted, checksum-verified Jena and Fuseki 6.2.0
distributions and Java 21 runtime:

```sh
export REZICS_FUSEKI_HOME=/absolute/path/to/apache-jena-fuseki-6.2.0
export REZICS_JENA_HOME=/absolute/path/to/apache-jena-6.2.0
export REZICS_JAVA_HOME=/absolute/path/to/java-21
corepack yarn main:typecheck
corepack yarn main:test
```

The storage test starts disposable Fuseki and PostgreSQL state in repository `.temp/`,
checks a network HTTP readiness response, graph/text bindings, retained object
bytes, receipt replay, conflicting keys, a lost response, a same-key race, stale
epoch rejection, an expired admission, an Access-registered Work command, denied
actor/assertion cases, claim before strong closure, both terminal graph outcomes,
a delayed update defeated by cancellation, a pending pass during Fuseki outage,
current-grant denial on replay, HTTP validation and pending/retry responses,
and the outbox count. [Executed JUnit evidence](tests/evidence/2026-09-24-main-storage.xml)
records the current run. These checks cover a storage sub-slice of SYS02/SYS10/SYS14
and a one-scope IAM07 Access/graph fence; they do not establish all strong
revocation cases, historical resolution or complete S1
acceptance. The [plan](../../docs/plan/README.md#active-execution)
owns current scope and next action.

The [full Work result](tests/evidence/2026-09-24-full-work.xml) records the
Account/Access/Main/Fuseki HTTP path, including guarded edit, exact history,
current-grant denial and an edit-scope strong fence. A 202 response carries an opaque operation
reference and instructs callers to retry the identical request and key. There
is no operation-read endpoint yet. Success carries public Work/MainVersion
references, revision anchors and source position; Problem Details omit private IDs.

The [edit/history result](tests/evidence/2026-09-24-work-edit.xml) records
the live-Fuseki same-head race, stale terminal receipt, lost update response,
replay, exact old revision resolution and missing/corrupt object rejection.
Its direct primitive admissions are fixtures; the full Work result exercises
the real cross-owner admission path.

The first RDF outbox relay runs as a separate process against a private PostgreSQL
handoff database. Apply [migration 001](migrations/relay/001_delivery.sql),
[migration 002](migrations/relay/002_coverage_scan.sql) and
[migration 003](migrations/relay/003_retained_batches.sql), then
initialize a checkpoint for a fresh installed data epoch and start the poller:

```sh
export FUSEKI_URL=http://127.0.0.1:3030/rezics/
export MAIN_RELAY_DATABASE_URL=postgres://user:password@127.0.0.1:5432/relay
export MAIN_RELAY_CONSUMER=first-handoff
export MAIN_DATA_EPOCH=installed-dataset-epoch
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/001_delivery.sql
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/002_coverage_scan.sql
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/003_retained_batches.sql
corepack yarn main:relay:init
corepack yarn main:relay
```

The relay reads one contiguous source batch at a time, verifies its event count,
objects, complete event ordinals, terminal receipts and revision manifest
references, then writes internal CloudEvents 1.0 Work outcome envelopes idempotently to
`relay.delivered_event`, retains every batch header in `relay.delivered_batch`,
and advances its durable checkpoint after handoff. A zero-event batch retains its
header and advances without an envelope. A missing batch/object, epoch change
or recovery hold stops the process. Checkpoint initialization never moves an
existing cursor; a restored epoch requires explicit reconciliation and a new
checkpoint decision. `MAIN_RELAY_INTERVAL_MS` defaults to 1000 milliseconds.
The [updated outbox result](tests/evidence/2026-09-24-relay-recovery-coverage.xml)
restarts the runnable relay after a simulated crash after handoff, then checks
duplicate replay, four Work outcome types, a mismatched receipt or ordinal,
gaps, missing objects, zero-event progress and restore hold with live
Fuseki/PostgreSQL. The handoff includes private
admission and scope facts and must remain private. It is a first durable event
record, not an authoritative recovery journal: its checkpoint may lag committed
graph positions, and downstream effects, retention and consumer recovery still
need implementation.

The internal `relayCoverage` scan records the checkpoint and SHA-256 digests of
all retained batch headers and handed-off envelopes through it. It requires one
contiguous header per source position and the recorded event count at each.
It rejects durable headers or events beyond the checkpoint, including a crash
after delivery but before acknowledgement. Existing databases upgraded from
migration 002 need an independently verified backfill of old headers from the
retained source before coverage can pass; migration 003 does not invent them. Graph
hold release requires this independently retained coverage to match the restored
cut, Access outbox coverage and Access authority/admission row coverage. The
Access row scan uses a repeatable-read UTC snapshot and excludes the recovery
fence itself. Capture its comparison value from a quiesced, independently retained
current Access source; a matching outbox alone cannot prove restored gate or
admission rows. A relay position ahead of the old graph backup blocks
release until its missing effects are reconciled.

The [updated recovery result](tests/evidence/2026-09-24-work-outcome-reconcile.xml)
records a stopped-state copy of Fuseki/TDB2/Lucene, Access PostgreSQL and immutable objects
to an isolated directory. The internal
[`cutoverRestoredGraphLineage`](src/modules/work/restore-lineage.ts) guards the
recorded old position, assigns a fresh data epoch and resets its sequence to
zero under a recovery hold. Main readiness, commands and exact reads return 503
while held, and graph activation guards also exclude the hold. The internal
`releaseRestoredGraphHold` compares an independently recorded prior position,
Access outbox/state coverage and retained relay coverage with the restored cut before
removing it. The drill checks hold responses, mismatched coverage, old receipt replay, retained revisions,
stale-worker rejection, ambiguous cutover response and a new edit at sequence
one after release. A later edit committed on the original timeline is missing
from a second older restore; final coverage mismatch keeps that restore held
and retry of its key creates no Access admission. A Work creation scope closure
after the saved cut remains effective with newer Access: an old sealed create
replays, while a new create is denied after graph release. That older-cut path with only
older Access and object state cannot reconcile the missing effect. The drill does
not prove Account or later authority/erasure journal coverage or reconcile consumer checkpoints; keep those boundaries
offline when their authoritative frontier is unavailable.

The internal [retained Work outcome replay](src/modules/work/reconcile-restored.ts)
supports a bounded mixed-cut case: the graph backup missed committed metadata
Work edits, creates or terminal cancellations, while current sealed Access
admissions, relay handoff and required immutable bytes survived. Under both
recovery holds it checks each retained receipt, source position, deterministic ID
and object digest, then restores original Work/MainVersion identities, revisions,
receipts and outbox records in source order. Cancelled and stale operations
restore only their terminal records. The recovery marker advances without
advancing the new epoch's sequence. The [executed drill](tests/evidence/2026-09-24-work-outcome-reconcile.xml)
checks missing Access or object coverage, replay retries, held readiness, exact
historical reads, release against final Access/relay coverage, same-key retries
and a new edit at new-epoch sequence one. It does not recover missing
Access/Account state, revocations, erasures, other event kinds or downstream
consumer effects. A retained zero-event header can also be replayed under the
recovery holds to advance the old source marker without an Access admission.

Access migration 003 creates a global recovery fence. Internal
`engageAccessRecoveryFence` waits for ordinary Access transactions, then blocks
admission, claim, closure, outcome recording and current read decisions. The
graph hold release requires this fence to remain held under a PostgreSQL row
lock while it checks Access outbox coverage and removes the graph hold. A retry
accepts the same released cut if the graph update response was lost. Only
after that release may the internal `releaseAccessRecoveryFence` reopen Access.
The recovery test exercises this ordering. The operator must first stop Main and
outbound workers, fence the isolated restored Access database, and retain the
independent coverage record; these internal helpers are not a turnkey restore.

The [Access test evidence](tests/evidence/2026-09-24-access-admission.xml) records
the local PostgreSQL register/replay/deny/closure checks, including competing
registration/closure and claim/strong-closure orders. It qualifies only the
first one-scope gate behavior;
the complete IAM07 and IAM10 outcomes remain pending.

The [Access WAL recovery result](tests/evidence/2026-09-24-access-pitr.xml)
uses a verified PostgreSQL 18.6 base backup and separately copied WAL segments.
It restores a strong scope closure committed after the backup, matches the
retained Access outbox and state coverage, and denies a new registration and an
old pending claim. Omitting the closure segment yields an older, readable cluster
whose coverage differs; operators must keep it fenced. The drill does not recover
Account, graph or erasure state and does not qualify off-host archive custody.

The internal [`AccountAssertionVerifier`](src/modules/account/verify-assertion.ts)
requires a signed bearer JWT with the configured Account issuer, Main audience,
subject and expiry. It checks Account's current introspection result on every
admission and requires exact OAuth scopes. It returns only the verified
issuer/subject for Access's principal lookup; it does not accept a token-supplied
Access principal ID or public Agent. This first profile rejects DPoP assertions until
a shared cross-replica replay store is bound. Missing Account keys or current
enforcement fail closed. Other command scopes and restart recovery still need
their fence profiles. The [verifier evidence](tests/evidence/2026-09-24-account-assertion.xml)
uses a local test issuer and introspection server; the separate
[Account evidence](../account/tests/evidence/2026-09-24-account.xml) exercises
the real issuer and Main verifier together.
