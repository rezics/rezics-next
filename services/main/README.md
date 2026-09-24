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
The Access database must have migrations 001 through 006 plus an admitted principal,
subject, representation, grant and `work:create:root` gate. The graph control
record must have the matching data and routing epochs. Startup does not create
or migrate authority state. `POST /v1/content-edits` uses an exact Work head
precondition and a `work:edit:{Work URI}` Access scope. `GET /v1/revisions/{id}`
verifies Account's `work:read` scope, current `work:read:{Work URI}` authority,
current Work presence and retained object digests. These routes cover one
metadata profile; wider deployment still requires recovery qualification.

`POST /v1/contributions` accepts a fixed `text-contribution-v1` body with an
existing Work URI, language, draft text and acting subject. It requires Account
`work:edit` and an independent Access `contribution.create` grant at
`contribution:create:{Work URI}`. The response contains a new Contribution URI,
an immutable draft revision and source position. Same-key replay returns the
same identifiers. `GET /v1/contributions/{id}/drafts/{revision}` requires Account
`work:read` and current Access `contribution.read` at
`contribution:read:{Contribution URI}`; missing authority returns 404. Draft
text stays in immutable objects and is absent from graph literals and private
relay envelopes. Typed private `contribution.draft-created.v1`,
`contribution.draft-edited.v1`, `contribution.draft-edit-rejected.v1` and
`contribution.admission-cancelled.v1` events are retained. Expected-head draft
edit is available through `POST /v1/contribution-edits` with a separate
`contribution:edit:{Contribution URI}` Access grant. It preserves the
Contribution identity, Work, author and language; stale edits receive a
terminal receipt, and strong closure seals pending edits. `POST
/v1/contribution-publications` records contributor eligibility for one exact
draft with a guarded publication-decision head, an original-contribution
rights basis, public disclosure and a separate `contribution.publish` Access
grant. The original author must be the actor. Replays keep the same decision;
stale heads receive a terminal rejection, and strong closure seals pending
admissions. Typed eligibility, rejection and cancellation relay events carry
references and a manifest without draft text. The fixed
`POST /v1/publication-selections` Main Version default profile requires a
separate `publication.select` grant at `publication:select:{MainVersion URI}` and an exact eligible
decision. Its guarded update advances the selection head, replaces only that
Main Version's public MatchUnit and records a typed private selection event.
`GET /v1/main-versions/{id}/selection` reads the selected public body.
`POST /v1/publication-selections` also admits `realm-local-selection-v1` for a
typed Realm context and exact eligible publication. It requires Account
`realm:adopt` plus Access `publication.adopt` at
`publication:adopt:{Realm URI}`. The fixed manager review policy and an active
public Realm guard one slot's selection head and public MatchUnit. Stale and
strongly cancelled admissions seal terminal receipts; replay keeps the original
outcome. `GET /v1/realms/{realm}/main-versions/{id}/selection` reads that local
choice or its Main Version default, stating the effective context and reason.
`POST /v1/publication-rejections` uses `realm-local-rejection-v1`, Account
`realm:reject` and a separate Access `publication.reject` grant scoped to the
Realm. Its expected-head command stores an immutable negative slot decision,
removes the former local public unit and leaves Main and other Realms intact.
The Realm selection read reports `status: suppressed` while that head is
current; Realm search excludes the Main fallback. A later guarded adoption
can replace the rejection. Stale attempts and strong cancellation retain
terminal receipts, and the private relay carries typed outcomes.
`POST /v1/queries` admits bounded complete Main default and Realm-effective
public phrase profiles. Both count every public MatchUnit across contexts,
require at most 100 units with a Lucene limit of 101, and reject larger
populations with 422. Private search and broader query shapes remain pending.
Retained private draft, contributor eligibility and Main default
selection outcomes can be replayed under a recovery hold only with matching
sealed Access receipts and immutable objects. Publication replay verifies the
original author's admission, the exact selected draft and the decision manifest.
Selection replay restores the current public MatchUnit and selected body from
the exact draft; the mixed-cut drill verifies jena-text lookup after a stopped
graph restore. The retained Realm selection replay restores its slot and exact
public unit, and the mixed-cut drill reads that body after release. The coverage
guard retains the hold until source positions
reconcile. Crash-time text index rebuilding remains unqualified.
Retained Realm rejection replay restores an immutable negative slot head, removes
its former local unit, and keeps earlier adoption receipts verifiable. The drill
checks a body-free suppressed read, zero Realm text hits and a later adoption
from the restored rejection in a new data epoch.

`POST /v1/spaces` currently admits the fixed `space-realm-v1` capability set
`["realm"]`. A `space:create` Account scope and independent `space.create`
Access grant at `space:create:root` are required. One transaction creates a
public Space and a distinct active Realm identity with an owner, immutable
revision manifests, initial closed membership, manager review and Main Version
fallback policies, a receipt and a private typed relay event. Replays keep both
identities. `GET /v1/spaces/{id}` resolves the public Space and Realm policy
references. A pending creation is terminally cancelled by strong closure.
The mixed-cut recovery drill replays the retained create and cancellation under
hold, preserving both identities. Realm management grant provisioning, policy
revision and Zone capability creation remain pending.

`POST /v1/classification-contexts` provisions a distinct classification
Context for one active public Realm under Account `realm:classify` and Access
`classification.context.configure` at `classification:context:{Realm URI}`.
The fixed profile gives the Realm Context one Global fallback dependency and
leaves publication selection under the Realm identity. It writes a guarded
revision manifest, receipt and typed private relay event. A same-key retry
returns the same context; concurrent create-only requests have one winner;
strong closure seals pending work. `GET /v1/realms/{realm}/classification-context`
reads its current policy and revision. Retained context creation and cancellation
replay under recovery hold with sealed Access evidence and immutable bytes.
Shared vocabulary definition admission and contextual classification decisions
remain pending.

The primitive validates a complete small Work/MainVersion candidate with the
[fixed profile](../../model/README.md), stages content-addressed immutable payloads
and manifests, then sends one conditional update through Fuseki's text wrapper.
The update writes current heads, revision anchors, an operation receipt, sequence
and outbox batch together. It looks up its own receipt after the update, including
after an ambiguous response. An unmatched guard stays pending; it is never treated
as success merely because Fuseki accepted the SPARQL request.

The [Access admission migration](migrations/access/001_admission.sql),
[claim/seal migration](migrations/access/002_claim_and_seal.sql),
[recovery fence migration](migrations/access/003_recovery_fence.sql),
[principal fence migration](migrations/access/004_principal_fence.sql),
[Account deletion intent migration](migrations/access/005_account_deletion_fence.sql),
[deletion journal scan index](migrations/access/006_account_deletion_journal_scan.sql) and
[`AccessAdmissionRegistry`](src/modules/access/admission.ts) use PostgreSQL 18
for a private principal/subject/representation/grant snapshot and a row-locked
scope gate. Registration commits its admission, receipt and outbox together.
Ordinary gate closure prevents later new admissions while earlier registered
operations retain a finite deadline. Claim and strong closure serialize on the
same scope gate row. Strong closure blocks later claims; a bounded reconciler
uses the same guarded graph receipt identity to record either a successful Work
or terminal cancellation, then seals the outcome in Access. An unavailable
Fuseki keeps the closure pending for a later pass. Internal principal deactivation
advances its enforcement epoch and writes a private outbox fact. A claim races
against that principal row lock; after deactivation commits, new claims and
current Work reads are denied. The bounded Work reconciler settles pending
create/edit admissions and reports `pending` until their graph outcomes are
sealed. This is a logical authority fence, not physical erasure or Account
credential revocation. Account's authenticated deletion hook calls this fence
before removing the member's user, sessions and OAuth tokens when its private
Access and retained relay connections are configured. The hook writes a private
deletion intent in the same Access transaction as the principal fence and
verifies its synchronous relay handoff before credentials are removed. A relay
outage holds Account deletion for retry. A restore with this intent
cannot release its graph hold without a matching authenticated two-owner
recovery set. Operator and OAuth client owners are held for transfer. The
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
current-grant denial, an edit-scope strong fence and principal deactivation with
pending Work reconciliation. A 202 response carries an opaque operation
reference and instructs callers to retry the identical request and key. There
is no operation-read endpoint yet. Success carries public Work/MainVersion
references, revision anchors and source position; Problem Details omit private IDs.
The same result exercises private Contribution draft creation/edit/replay,
separate current draft read and edit grants, stale and fenced edits, no body in
RDF or relay, and strong closure of pending draft admissions.

The [edit/history result](tests/evidence/2026-09-24-work-edit.xml) records
the live-Fuseki same-head race, stale terminal receipt, lost update response,
replay, exact old revision resolution and missing/corrupt object rejection.
Its direct primitive admissions are fixtures; the full Work result exercises
the real cross-owner admission path.

The first RDF outbox relay runs as a separate process against a private PostgreSQL
handoff database. Apply [migration 001](migrations/relay/001_delivery.sql),
[migration 002](migrations/relay/002_coverage_scan.sql) and
[migration 003](migrations/relay/003_retained_batches.sql) and
[private deletion journal migration 004](migrations/relay/004_account_deletion_journal.sql)
the [recovery head migration 005](migrations/relay/005_recovery_coverage_head.sql)
and [Account subject tombstone migration 006](migrations/relay/006_account_subject_deletion.sql), then
initialize a checkpoint for a fresh installed data epoch and start the poller:

```sh
export FUSEKI_URL=http://127.0.0.1:3030/rezics/
export MAIN_RELAY_DATABASE_URL=postgres://user:password@127.0.0.1:5432/relay
export MAIN_RELAY_CONSUMER=first-handoff
export MAIN_DATA_EPOCH=installed-dataset-epoch
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/001_delivery.sql
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/002_coverage_scan.sql
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/003_retained_batches.sql
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/004_account_deletion_journal.sql
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/005_recovery_coverage_head.sql
psql "$MAIN_RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f services/main/migrations/relay/006_account_subject_deletion.sql
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
hold release requires an HMAC authenticated envelope of this independently
retained coverage to match the restored
cut, Account's PostgreSQL WAL position and pinned Better Auth row coverage, Access outbox coverage and Access
authority/admission row coverage. The
Access row scan uses a repeatable-read UTC snapshot and excludes the recovery
fence itself. Capture its comparison value from a quiesced, independently retained
current Access source; a matching outbox alone cannot prove restored gate or
admission rows. A relay position ahead of the old graph backup blocks
release until its missing effects are reconciled. The
[`graph-recovery-coverage` capture command](src/graph-recovery-coverage.ts)
requires Access's recovery fence to be held, checks that the relay has reached
the quiesced source graph position, then seals
that position with Account WAL and row coverage, Access and relay digests using
`RECOVERY_MANIFEST_HMAC_KEY`. It records the latest signed coverage digest in
the separate relay database before printing the envelope. A second scan rejects
owner or graph movement during capture. Use the
[Access capture fence CLI](src/access-capture-fence.ts) to hold the source and
retain its generation through backup before releasing it. Supply
`ACCOUNT_RECOVERY_DATABASE_URL` during capture
and the restored Account pool at every graph release.
Keep the private envelope and key outside the restored stores. Release rejects
altered or wrong-key coverage before touching Fuseki; external custody must
retain the latest current envelope and the relay recovery head. Release also
rejects an older valid envelope when a newer capture has advanced that head.
The [private Account deletion journal](src/modules/outbox/account-deletion-journal.ts)
copies Access deletion intent facts into the separate relay database. Drain it
after Account deletions and before recovery capture, while Access remains
available:

```sh
ACCESS_DATABASE_URL="$ACCESS_DATABASE_URL" MAIN_RELAY_DATABASE_URL="$MAIN_RELAY_DATABASE_URL" bun services/main/src/relay-account-deletions.ts once
```

Account also retains a private subject tombstone for every authenticated
deletion, including users with no Access principal. Recovery compares those
subjects with the promoted Account user table and keeps the graph held if any
deleted subject reappears.
For deletions made before relay migration 006, quiesce all three owners and
backfill subjects still provable from Access's deletion intents. The command
refuses a source Account user that is still present:

```sh
ACCOUNT_RECOVERY_DATABASE_URL="$ACCOUNT_DATABASE_URL" ACCESS_RECOVERY_DATABASE_URL="$ACCESS_DATABASE_URL" RELAY_RECOVERY_DATABASE_URL="$MAIN_RELAY_DATABASE_URL" bun services/main/src/relay-account-subject-backfill.ts once
```

This cannot discover older deletions of users who never had an Access principal;
those require an independent historical record before their restored absence
can be qualified.

The copy is idempotent. Capture and graph release compare its complete retained
set with Access; an older Access cut missing a retained deletion intent keeps
the hold even with a matching older signed graph envelope. A missed handoff
before source loss still needs external Account and erasure frontier evidence.
The current handoff scans every deletion intent on each run; sustained-load
qualification and a retained checkpoint protocol remain pending.

The [updated recovery result](tests/evidence/2026-09-24-work-outcome-reconcile.xml)
records a stopped-state copy of Fuseki/TDB2/Lucene, Access PostgreSQL and immutable objects
to an isolated directory. The internal
[`cutoverRestoredGraphLineage`](src/modules/work/restore-lineage.ts) guards the
recorded old position, assigns a fresh data epoch and resets its sequence to
zero under a recovery hold. Main readiness, commands and exact reads return 503
while held, and graph activation guards also exclude the hold. The internal
`releaseRestoredGraphHold` compares an independently recorded prior position,
Account WAL/row coverage, Access outbox/state coverage and retained relay coverage with the restored cut before
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

The internal [retained outcome replay](src/modules/work/reconcile-restored.ts)
supports a bounded mixed-cut case: the graph backup missed committed metadata
Work edits/creates, private Contribution draft creations/edits or terminal
cancellations, while current sealed Access
admissions, relay handoff and required immutable bytes survived. Under both
recovery holds it checks each retained receipt, source position, deterministic ID
and object digest, then restores original Work/MainVersion/Contribution identities, revisions,
receipts and outbox records in source order. Cancelled and stale operations
restore only their terminal records. The recovery marker advances without
advancing the new epoch's sequence. The [executed drill](tests/evidence/2026-09-24-work-outcome-reconcile.xml)
checks missing Access or object coverage, replay retries, held readiness, exact
historical reads, release against final Access/relay coverage, same-key retries
and a new edit at new-epoch sequence one. Draft replay checks body digests
against retained requests, rejects missing objects, preserves edit predecessors,
and restores stale/cancelled outcomes as terminal receipts. It does not recover missing
Access/Account state, revocations, erasures, later event kinds or downstream
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

The [Access test evidence](tests/evidence/2026-09-24-access-recovery-fence.xml) records
the local PostgreSQL register/replay/deny/closure checks, including competing
registration/closure, claim/strong-closure and claim/principal-deactivation
orders. It qualifies only the first one-scope gate and principal fence behavior;
the complete IAM07 and IAM10 outcomes remain pending.

The [Access WAL recovery result](tests/evidence/2026-09-24-access-pitr.xml)
uses a verified PostgreSQL 18.6 base backup and separately copied WAL segments.
It restores a strong scope closure and principal deactivation committed after
the backup, matches retained Access outbox and state coverage, and denies a new
registration and an old pending claim. Omitting the later segment yields an older,
readable cluster whose coverage differs; the [frontier CLI](src/pg-recovery-frontier.ts) also
rejects its WAL replay LSN. Capture its JSON output from a quiesced source,
retain it separately, and verify it on the isolated restore. Operators must
keep mismatched restores fenced. The [Access recovery manifest CLI](src/access-recovery-manifest.ts)
authenticates the WAL frontier together with Access outbox and authority/admission
row digests. Set `RECOVERY_MANIFEST_HMAC_KEY` to an independent random 32-byte hex
key and retain it separately from the private manifest and database backup:

```sh
ACCESS_RECOVERY_DATABASE_URL="$ACCESS_DATABASE_URL" bun services/main/src/access-recovery-manifest.ts capture > "$RECOVERY_MANIFEST_DIR/access.json"
ACCESS_RECOVERY_DATABASE_URL="$RESTORED_ACCESS_DATABASE_URL" bun services/main/src/access-recovery-manifest.ts verify "$RECOVERY_MANIFEST_DIR/access.json"
```

The drill rejects a changed envelope, wrong key and missing WAL. It does not recover
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
