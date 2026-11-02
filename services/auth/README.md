# Auth account effects

`@rezics/auth` is a separate workspace and PostgreSQL store. It owns password
credentials, Better Auth sessions, registered clients, consent and signing keys.
Access owns the only public identity, `account_id`, and all account state,
operator relationships and resource authorization. Auth neither reads kernel
account tables nor stores account profiles, handles, controllers, birth dates,
organization authority or grants.

Auth supplies guarded account effects through Better Auth, including operator
session opening, actor-owned password and public-key credentials, human recovery
and Access-first consent reduction. The explicit account workflow host adds DBOS
registration, organization and membership coordination, operator creation and transfer,
deletion, fencing fanout, authorized rename and Access-first authority reductions.
OIDC authorization, token exchange, CIBA and device authorization remain outside
this service. Token issuance accepts `requested_by` only after current Access
proof of a principal-created assignment for the authenticated actor. Unverified
`requested_by` and all caller-supplied `act` values are rejected.

## Native Collection Kind consent closure

`@rezics/auth-contract` exports `KindConsentParticipant` and
`KindConsentInvalidationReceiver`; `@rezics/auth/kind-consent` exports
`createKindConsentParticipant`. These are trusted native composition ports.
`participant.enroll` binds the account, client, original requested scopes and
the exact Collection Kind route/owner/collection/preparation/origin locators.
It returns only an opaque Auth lookup reference and the intersection of stored
consent, current client coverage and any pending consent ceiling. First-party
client status does not imply consent. The reference is not a grant or an allow
verdict. The Source consumer must establish request provenance before calling
the participant and must keep its own adoption guard.

Auth consent and client writers close the durable enrollment frontier before
making their exact authority change visible. Auth releases its database checkout
before calling the native same-home receiver. Each transition advances at most
100 enrolled consumers per call; the receiver must commit an immutable fence and
then verify that exact current fence before Auth records the receipt. Lost or
ambiguous replies retry the same transition identity. A missing receiver or an
unverified result keeps the transition pending and prevents the Auth mutation.
The default maintenance workflow advances pending invalidation pages. Restored
Auth service and isolated restore-host admission fence the restored generation
before opening normal admission. Database guards also reject direct consent,
client, coverage and client-reduction authority writes that bypass an active or
unresolved Kind closure.

This is the Auth producer boundary only. A Source implementation must still
adopt the exported types and methods, provide its native invalidate/verify
receiver, and serialize adoption against its local fence before the automatic
Collection Kind journey is complete.

## Restored database admission

A deployment restoring Auth declares `restoredGeneration: { kind: 'RESTORED',
generation, databaseOwner }` on `AuthServiceOptions` (also inherited by the host).
The generation identifies the actual isolated restored image, not a startup UUID.
`createAuthService` checks admission before native producer installation, signer
loading or Better Auth construction. Consequently `createAuthHost` cannot return
an active service/handler before `start()`: refusal also precedes workflow SDK
registration/recovery, maintenance, client registration and mail writers. Host
refusal closes its owned pools; library refusal leaves the caller's pool owned
by the caller. A durable unverified declaration is retained even when the owner is missing;
its null inventory proves no backup boundary. The marker refuses subsequent
construction that omits the deployment declaration. Unmarked fresh library/host construction
retains its ordinary lifecycle. Physical isolation of unmarked old snapshots and
old executors remains the deployment owner's responsibility.

`AuthRestoreDatabaseOwner` in [restore-admission.ts](src/restore-admission.ts)
is the explicit trusted dependency for verifying the connected database against
its nonsecret database identity, inventory entry/version, original cluster/timeline/source lineage, capture
point and recoverable committed native tail beyond the snapshot. Its exact
account recovery returns original native identity, checkpoint, captured floor,
applicability, first user-deletion/consent cutoff and genuine original consumer
acceptance/discharge. There is no installed deployment/database implementation.
No callback returning a boolean, generated identifier, wall clock, absent user or
absent snapshot row verifies this evidence. Missing or conflicting evidence has
an `AuthRestoreAdmissionError.code`; it never establishes no deletion or custody.

`importRestoredAuthProgress` recovers one exact account obligation outside all
Auth locks, then binds that evidence under the existing account producer lock.
It preserves original source acceptance, workflow/receipt, applicability and
consent cutoff; disagreement refuses the transaction. `auth_erasure` retains the
source route/account/version/T and original floor. `auth_restore_generation`
retains verified image identity, and `auth_restore_replay` holds immutable
original progress and per-generation checkpoints beside the existing obligation.
`replayRestoredAuthPage` reuses the native store/role/client engine and original
consumer proofs, at most one native unit per call (48 raw keys, 1 KiB per locator,
64 KiB whole-step ceiling), followed on later calls by existing shared-copy work.
Each generation restarts the existing native role classification and revisits
reintroduced bytes, including an image carrying older completion. Original first consent due evidence is retained, without another
310-second wait; a proved never-established cutoff uses the existing native
first deletion transaction. Missing original consumer release stays pending.
No approval, credential effect or 30-minute source authorization is renewed.

`AuthRestoredGeneration.obligations` accepts the original
`AuthErasureObligationPorts` from `@rezics/auth-contract`. Trusted service/host
composition supplies the native `createAuthErasureObligationBindings(pool)` or
the same four methods on default `createAuthBindings`; Auth receives no kernel
pool, module or HTTP-provided readiness. `stageRestoredAuthObligations` stages
one actual native partition/page, at most 48 obligations, under one five-second
absolute deadline. It persists a stable cut UUID before contacting Access and
reuses that locator on every retry. The UUID establishes no backup proof.

Each ready page obligation is resolved again through the real Source point port
and compared with independently recovered Auth progress before import. Route
(0–65535), account, version, exact PostgreSQL T and canonical native integer floor
must agree. The original Source receipt and ordinal are retained separately from
Auth's original consumer receipt/continuation. Unknown original floors or missing
Auth tail never create replacement native progress. No Auth checkout spans a
Source or database-owner read. The existing account producer/floor locks still
serialize imports. Durable page/cut/cursor and version checkpoints accompany
immutable Source obligations and Auth original progress; a crash repeats the
same page and each native replay uses the existing engine.

Traversal follows native `state` and `next`, keeping pending/initializing pages
at their original cursor. Empty pages and `sealedPartitions` alone prove no
completion. After traversal, bounded calls verify all 4096 partitions through
the actual current Source verifier and retain its generation/epoch/owner and
high-water/live-high-water observations. A changed head/owner stays pending on
the same cut rather than silently replacing it. Verification is an observation, not a live cutover fence.

`AuthRestoredGeneration.live(receiver)` binds the original
`AuthErasureLivePorts` to the verified generation/database identity/inventory
entry/version and the original cut. Trusted composition supplies
`receiver => createAuthErasureLiveBindings(sourcePool, receiver)`; the Source
pool remains inside Access. Auth uses the producer's original published ABI,
including its opaque string inventory version. Missing native composition still
reports `source-live-handoff-pending`; a boolean cannot replace it.

After traversal/verification, each bounded call arms or tails one actual native
partition. Source enrollment uses the actual tombstone append fence. Auth keeps
the exact receiver and original Source generation/epoch/owner/cut high-water/arm
high-water. Its tail begins at the original cut high-water, including obligations
between that cut and the arm. The dynamic `enrolledThrough` is the native tail
boundary; the cut's `highWater` does not grow. At most 48 obligations and 64 KiB
cross one call under the same five-second absolute deadline. Every root is
point-checked and imported through the existing immutable original-progress
validator. Missing independently recovered Auth progress remains pending, even
when Source has a genuine new obligation. Auth never invents original progress
from an absent snapshot row. Page/import/checkpoint interruptions retry the same
immutable evidence; a CAS advances only a completely imported page.

`auth_restore_live_generation`, `auth_restore_live_partition` and
`auth_restore_live_work` own durable partition rotation, Source observations,
CAS cursors and indexed fair native scheduling. An indexed 48-key attachment
page also enrolls genuine replay rows imported before the live scheduler existed;
an empty new queue cannot hide that earlier native work. A newly imported obligation
gets unfinished per-generation native/receiving work without clearing an older
obligation's original consent cutoff or acknowledged Source evidence. These
independent tables bind the original verified restore record at runtime; their
UTC migration does not depend on the ordering of older future-dated migrations.

`reconcileRestoredAuthPage` alternates Source consumption and actual existing
native replay using durable turns and indexed keys. `createAuthRestoreHost`
provides the isolated deployment's `start`/`reconcile`/`stop` lifecycle before
normal `createAuthHost`: it owns its Auth pool, schedules further bounded work,
awaits in-flight work before pool shutdown, and exposes no service, handler,
issuer, workflow SDK or maintenance writer. Restarting it resumes native
checkpoints. Required original consumer continuations remain pending until their
real owner can redrive them; the isolated host does not launch an SDK to infer
that release. Normal service admission also runs one reconciler unit before
refusing. Unmarked fresh service/host behavior is unchanged.

Once all partitions have genuine live enrollment and consumed native tail
observations, the reported boundary becomes the actual `native-replay-pending`,
`receiving-closure-pending` or `external-owner-pending`. This progress never opens
traffic: the installed database owner API verifies image identity and recovered
native progress only. No installed owner supplies final independent physical,
committed-tail and receiving closure. A tail-end observation or current Source
point is insufficient. History completion publication remains held on a marked
restore image, including carried completion. This delivers no
physical backup/replica/mail/log deletion or final coordinator ACK. Outstanding
external custody and backup expiry remain separate pending owner obligations in
[the external custody contract](src/external-custody-contract.md). The protected
external/restore custody tests retain their explicit missing-owner failures;
this change does not certify before-T restore or overall erasure completion.

### Current receiving closure provenance

[receiving-closure.ts](src/receiving-closure.ts) implements the private
`auth.receiving-closure/v1` receipt factory. Default service composition exposes
that fixed factory to the native Access binding; callers supply an obligation
key, never a publication blob. The producer wire includes the exact accepted
source continuation and receipt, reread from the durable Auth obligation. Access
matches that tuple against native consumption and stores it in the immutable
receiving receipt; a publication for the same barrier alone cannot substitute.
Legacy source-unbound receipts remain historical without a backfill.
Native terminal role/cursor work records its
commit under the permanent account writer fence. Copy cleanup records the real
permanent SDK fence after actual deletion and absence checks. Receipt creation
rereads current role coverage, the original source discharge, consent cutoff,
actual consent/copy absence and the exact restored replay when applicable. It
preserves original progress and never waits for a final participant ACK.

Access stores independent per-home receiving control, exact account/barrier
obligations and immutable current-closure receipts. Registration creates pending
obligations without claiming physical ownership. Native INSERT guards reread
the original Source and exact account/barrier/floor before conflict handling,
preventing incorrect immutable registration tuples. Invalidation locks the same
control that verification locks and advances its revision before replacement
consumers may arm. Restore import, replay and bounded live-home enrollment
require that control; inventory and live enrollment remain distinct authorities.

`prepareCurrentAuthReceivingClosure` observes only released native homes.
`verifyCurrentAuthReceivingClosure` rereads the exact Source/control/root/receipt
in the caller's live transaction and retains shared locks through commit. It
performs no Auth or foreign I/O. The opaque locator includes the original barrier,
Source continuity, receiver binding and durable receipt; a JavaScript brand or
process-local cache cannot substitute for the native read. Autocommit cannot
certify destructive work. Foreign or unavailable homes remain unavailable.

The required original physical-owner operation is absent. In particular:

- `AuthRestoreDatabaseOwner.verifyRestoredDatabase` verifies restored inventory;
  `recoverCommittedNativeProgress` recovers one original obligation. Neither
  operation establishes the current original database's physical ownership,
  receiving incarnation or independently controlled restore generation.
- `host.ts` compares product and system connection URLs. That comparison does not
  identify a physical database or fence an old database/executor after replacement.
- Access's `auth_erasure_source` binds a Source partition's generation, epoch and
  node. Those values identify Source continuity, not an Auth receiving database.
  Its native registration and live enrollment do not control Auth writers.

The missing host provenance is the conjunction of original ownership/control
records outside the restorable image, the actual connected receiver's identity,
surviving deployment inventory/isolation and installation, receiving/restore
generation, and actual per-obligation physical and writer closure. Inventory and
live enrollment do not establish that conjunction. The installed host inputs
cannot serialize old/current Auth writers, restore/replay admission, receiver
replacement and destructive verification against one independently owned fence.
Replacement must invalidate earlier receipts before either database can serve or
write. No replacement owner interface is specified here; deployment owns the
trusted provenance that the current host inputs lack.

The exact integration gap is at `createAuthHost`/`createAuthService` and
`createAuthHistoryProofBindings`: no existing owner export supplies an actual
original database identity, receiving incarnation, restore generation, original
installation/writer fence or per-obligation physical and receiving closure.
`auth_receiving_control_guard` therefore rejects activation and identity changes;
`auth_receiving_obligation_guard` rejects physical-custody installation. These
refusals must be replaced by the original owner's record validation when that
operation exists. There is no installer flag, generic owner setter or SQL backfill.
The register, invalidate, publish and current verify bodies are implemented;
they cannot manufacture this missing authority. The new native-fixture
missing-owner regression is authored and unrun. A genuine fresh-receiver and
owner-replacement regression still requires the missing original operation.
Ordinary authentication and historical erasure publications retain their roles.

### Receiving producer and restore costs

The native control prices are in [Access](../kernel/src/access/README.md#bounded-receiving-sql).
The following additions use exact local keys and the existing original engines;
they do not scan retained obligations, restart a cursor or renew consent. Key
visits count repeated keyed reads/writes and FK checks. `restoreDatabaseWithin`
executes BEGIN + initial settings, settings before each body statement, and
settings + COMMIT: a body of n statements costs 2n+4 client statements. A
standalone query through it costs six. Failure adds at most one ROLLBACK per
opened transaction. Advisory locks/settings access no product table keys.

| Local entry                         |                       Key visits |              Client SQL bound | Derivation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------: | ----------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Begin receiving work                |                                5 |                            18 | Root point 1 (six statements); advisory lock, exact restored generation 1, marked-image LIMIT1 1, work INSERT + erasure FK 2 (four body statements, twelve with wrapper); PLUS native registration at released Access home                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Actual native terminal callback     |                                3 | 1, or 2 under restore wrapper | Exact erasure 1, latest work reverse PK 1, one work UPDATE 1; no reset or new native erasure algorithm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Record one SDK copy                 |                                8 |                            19 | Latest work point 1/six statements, then root 1, advisory lock, work/copy INSERT SELECT 2 + receipt INSERT/two-column work FK 2, exact reread 1 (four body statements/twelve with wrapper); PLUS one actual SDK fence PK read/one statement/one key. The FK is one composite-key lookup; total local visits seven plus the SDK key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Private receipt factory after begin |                               12 |                            20 | Exact work/erasure preflight 2/six statements, checking account/version/T before any native page; then five body statements: explicit settings, advisory lock, coverage 1, exact work/erasure 2 + marked-image LIMIT1 1 + exact replay/generation 2 + copy/consent absence prefixes 2 + coverage 1, then work UPDATE 1. Fourteen includes all transaction wrapper settings and controls. Every factory call first repeats begin receiving work (5 local keys/18 statements plus native registration 17 keys/9 statements), including historical obligations with no local work yet. Thus the complete Auth factory has 17 keys/38 client statements plus that native registration. If the preflight lacks a current native xid, one original native page and its existing producer fence run first, with their original separate bounds and no cursor reset; its receiving begin and terminal callback are additional, not included twice for free |
| Restored import addition            |     native invalidate + register |             no added Auth SQL | Owner recovery and existing source floor/lineage validation precede control operations; exact database identity/generation must match verified inventory before the original import transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Restored replay addition            | 1 + native invalidate + register |       6 added Auth statements | Exact original source tuple read through deadline wrapper before existing native replay; original replay/copy costs remain charged on every reached invocation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Live home addition                  | native invalidate + read-control |             no added Auth SQL | One existing rotating home; quarantine commits before any original live enrollment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The copy row bound above includes a successful immutable receipt insertion and
its composite FK. `getWorkflowWriterFence` is the installed SDK patch's single
`workflow_writer_fences(workflow_uuid)` query; it neither retires nor scans SDK
history. All calls occur with Auth and Access homes released. The existing
`eraseCopy` operation still performs genuine writer retirement and physical
absence checks before this extra read/receipt. Its original 139-row/10-MiB,
eight-locator page and one-execution limits remain unchanged and are additional
to this table. The new receipt never treats SDK status, callback or that old
receipt alone as current restored physical closure. Local factory output is
bounded below 64 KiB; Access additionally rejects a current locator above 1 KiB.
The original 310-second cutoff, page sizes, source high water/floor and lineage
are unchanged. Factory registration and its native-page receiving hook retain
the same absolute deadline; they cannot renew its five-second budget. New work requires the native terminal engine to run under the
registered binding; the private factory invokes one original page when needed.
Historical completion cannot populate its fresh `native_xid`.
Focused native fixture cases are authored but UNRUN. Original acceptance/native
and browser checks remain deferred to integration.

## Database and checks

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd services/auth check
bun run --cwd services/auth typecheck
```

The standalone typecheck follows the [compiler placement contract](../../docs/development/compiler-check-placement.md)
and creates one throwaway compiler database on an approved check host. This database receives both kernel and Auth
migrations because the compiler also follows imports of kernel SQL. An explicit `DATABASE_URL` requires an already
admitted physical run. Unavailable placement fails closed; tsc's status and diagnostics are unchanged.

The check always creates a throwaway **separate** database using the same pinned
PostgreSQL 19 image as kernel. It never uses `DATABASE_URL`, `AUTH_DATABASE_URL`
or the development database. It applies committed dbmate migrations twice,
compares the normalized schema dump, checks the schema against the installed
Better Auth migration API, runs strict root TypeScript, root lint/format tools
and the frozen Bun tests. Containers use `rezics.auth.check.pid` labels and disk-backed volumes;
normal exit and SIGINT/SIGTERM remove them, and later checks remove stale fixtures.
Auth test databases run through `scripts/stack-run.ts` on a check host when one answers (otherwise locally with a stderr notice), reuse the check lane's container, and remove leftover containers on failure.
Docker is required; a missing database URL never skips tests. Direct database tests must use
`bun run --cwd services/auth check <file>` so the whole test can be placed.
`AUTH_TEST_DATABASE_URL` is reserved for the check's fixture, never a development database.

Create an Auth-only database and apply migrations before starting an application:

```sh
AUTH_DATABASE_URL='postgres://…/rezics_auth' bun run --cwd services/auth db migrate
AUTH_DATABASE_URL='postgres://…/rezics_auth' bun run --cwd services/auth db dump
```

The schema dump is generated with the pinned image. The initial migration was
generated by Better Auth 1.7.12 `getMigrations().compileMigrations()`; subsequent
constraints enforce inert mandatory profile placeholders and credential ownership.
To inspect a replacement baseline against an **empty** separate database, use
`AUTH_DATABASE_URL=… bun services/auth/scripts/generate-schema.ts`. Commit schema
changes as migrations, rather than running automatic migrations at application
startup. `getMigrations` is exported by `better-auth/db/migration`.

## Application boundary and configuration

`src/index.ts` exports `createAuthService(options): Promise<AuthService>` and the
`AuthServiceOptions`, `TrustedAccessPorts`, `AccessAccount`, `SessionProof`,
`PublicJwks`, `AccessTokenClaims` and `VerifierConfiguration` types. The returned
service has `handler(Request): Promise<Response>`, `verifier` and `internal`.
The host owns the injected `pg.Pool` and closes it on shutdown.

Required production configuration:

- A PostgreSQL pool restricted to the separate Auth database. Kernel and clients
  must have no access to its credentials or private signing keys.
- An HTTPS issuer origin, without a trailing slash, and the fixed HTTPS rezics
  API audience. These are server configuration, never request fields.
- A persistent, high-entropy Better Auth secret of at least 32 characters,
  supplied through Auth's secret configuration. Changing it invalidates cookies.
- `signing: { activeKid, privateKeys }`. Bootstrap with Auth-only ES256/P-256
  private JWKs bearing unique `kid` values. They are validated with real JOSE,
  persisted in `auth_signing_key` and never returned by HTTP. Later starts can
  supply `privateKeys: []` and load `activeKid` from this store. No key is generated
  implicitly. Reusing a `kid` for different material fails startup. To rotate,
  inject a new key and select its ID; restart instances to reload their key set.
  Retain old public keys through outstanding token lifetimes and verifier cache
  lifetimes. This foundation has no key deletion endpoint.
- Trusted Access application ports and configured registered clients.

`trustedAccess.readAccount(accountId)` must perform an authoritative current
read and return the matching ID, structural kind, state and integer epoch floor.
It must reject unavailable or fenced evidence, normally by returning null;
explicit `fenced: true` also denies establishment and ordinary session reads. The `automated` fixture field is transient;
Auth persists no operator or automation copy. Reads, sessions and token issue
fail closed on missing/inactive accounts, organizations or dependency failures.

`trustedAccess.authorizeProvisioning(commandReference)` resolves an already
approved Access registration command to its account ID. The host must supply a
real trusted implementation; parsing a caller's ID or unsigned grant is not an
implementation of this port. Tests inject Access fixtures as boundary evidence,
not as proof of final cross-service integration.

Production activation requires the optional typed `receipt` in the internal
`authorizeProvisioning` result:

```ts
type ProvisioningAuthorization = {
  accountId: string;
  receipt: {
    registrationId: string;
    reservationId: string;
    authnEpoch: number;
    expiresAt: string; // canonical UTC ISO timestamp, original pending deadline
  };
};
```

The Access binding/composition owner must populate these from the verified native
pending receipt and its exact current registration/reservation read. In the
current native Access lifecycle, `registrationId` is the pending command's
`reservationId`; supply that identity in both fields, not the Auth staging ID.
`authnEpoch` is the trusted account read's original pending epoch and must match
that read exactly. Do not use a constant or upgrade it on replay. The current
account-only binding must return this additional metadata before it can produce
activation evidence. Legacy fixtures may omit `receipt`; they receive no proof.
An invalid or partial receipt fails closed.

`provisionPassword` and `provisionCredentialless` return
`{ accountId, provisioningEvidence? }`. With exact metadata, both write the native
Better Auth owner, credential row (null password for credentialless automation)
and immutable `auth_provisioning_receipt` together. An explicit `idempotencyKey`
is supported by both; without one, the evidence path uses a stable kind/account
key. Exact retries preserve the native credential ID and reference. Existing user
or staging rows never substitute for this commit. Pending authorization is
rechecked against the original binding before commit and again before publishing
the reference; expiration, fencing or any binding change denies publication.

`createProvisioningEvidenceVerifier({ database })` exports internal read-only
capabilities. `createReference({ receiptKey, accountId, registrationId,
reservationId, authnEpoch, expiresAt })` returns a typed nonsecret reference only
for the exact committed receipt and bound native owner/credential. The composition
owner must verify the original pending authorization before publishing a reference;
the provisioning methods perform that check themselves. Pass `resolve` as Access's
`provisioningEvidence` resolver. It returns only `{ accountId, registrationId,
authIdentityId, authnEpoch }`, or null for malformed, missing, expired or mismatched
evidence. It reads no staging or kernel database and exposes no HTTP minting API,
password, hash, token or private profile. Native owner/credential deletion cascades
through indexed receipt references, permanently revoking proof. Old receipts
without evidence columns remain unproven idempotency history.

The native Auth tests establish actual commit, rollback, replay and erasure only.
They use an Auth-only structural Access trust fixture. Final registration binding
must compose the real pending receipt verifier with the actual Access lifecycle
activation command; callback policy or staging/user existence is insufficient.

Only trusted application code may call the internal effects:

- `internal.provisionPassword({ authorization, email, password })` resolves the
  approved command, checks the current pending actor, hashes through Better Auth
  and atomically creates its credential owner and password credential. It creates
  no session and performs no Access activation. People and automated actors use
  the same credential type; credentialless actors cannot independently sign in.
- `internal.revokeSessions(accountId)` uses Better Auth's
  `internalAdapter.deleteUserSessions`. Operator authorization and any epoch fence
  must already have succeeded as Access commands before this effect is called.
- `internal.registerClient({ clientId, firstParty, scopes, displayName?, mode? })` persists trusted
  client configuration. When supplied, `displayName` must contain 1–100 characters
  after trimming; invalid names are refused with 400. Re-registration replaces the
  display name, and omitting it stores null. Only trusted deployment/application code decides which
  clients are first party. Scope growth does not change existing sessions.
  Removing scopes or changing a first-party client to third party uses the workflow
  host's `reduceClientScopes`; direct `registerClient` calls continue to refuse reductions.
  With `mode: 'create-or-match'`, the same native client lock and reduction guards
  protect insertion or an exact first-party flag and normalized scope-set match.
  A match preserves all existing metadata; a mismatch rolls back without writes.
  Invalid modes are refused. Omitting the mode retains the ordinary upsert behavior.

These are in-process methods, with no internal HTTP authorization endpoint.

### Security and deletion preflight inventory

The configured issuer's same Auth handler serves `GET /clients` and `GET /consents`.
Both require the current native human session cookie, exact issuer `Origin` and
no cross-site fetch. Account, session, epoch, consent and issuance fences are
revalidated; an unavailable dependency returns 503, denied authentication 401 and
an invalid origin 403. Neither route accepts a selected account, client, bearer
body, organization/operator authority or administrative fallback.

Only these two exact GET paths accept `cursor?` and `limit?` query parameters.
Limit defaults to 20 and must be an integer from 1 through 100; unknown, duplicate,
empty or malformed parameters return 400. Other routes retain their query guards.
Responses, including inventory errors, use `Cache-Control: private, no-store`.
The closed response shapes are:

```ts
type ClientsPage = {
  clients: Array<{
    client_id: string;
    display_name: string | null;
    disabled: boolean;
    scopes: string[];
  }>;
  next: string | null;
};
type ConsentsPage = {
  consents: Array<{
    client_id: string;
    display_name: string | null;
    granted: string[];
    status: 'current' | 'inactive' | 'unavailable';
    reducible: boolean;
    pending_reduction: boolean;
  }>;
  next: string | null;
};
```

`AuthService.security.listClients({headers,cursor?,limit?})` and
`listConsents({headers,cursor?,limit?})` expose these same native reads for the
existing `/security` and `/account/delete` consumers. Their inputs have no
account selector and apply the same origin/session guards. DTOs and port types
are exported from `@rezics/auth`.

Clients come only from native `auth_client."userId"` ownership. The existing
`erasure_auth_client_0(userId,client_id)` index supplies the ordered page; a
configured first-party client, reference pointer, managed account or organization
membership supplies no personal ownership. Returned labels are only the native
configured `display_name`; scopes are the registered allowed ceiling, never a
grant. A disabled or fenced owned record remains visible for responsibility
remedies; fenced records suppress their label/scopes and report disabled. Listing
does not waive the existing transfer/deletion responsibility guards. No arbitrary
resource JSON or related-party metadata is exposed.

Consents page actual `auth_consent(account_id,client_id)` primary-key rows, then
read at most 100 exact native client keys in the same read-only REPEATABLE READ
snapshot. `granted` intersects stored scopes, the current registered ceiling and
`pending_scopes` when present, including an empty pending set. Disabled, fenced,
uncovered, reducing, missing or invalid client authority yields `unavailable`
with no effective grant; its consent row remains visible. A valid empty grant is
`inactive`. `pending_reduction` preserves both consent and client reduction state.
`reducible` is true only for a usable third-party binding; first-party standing
consent gets no invented revocation control. The existing consent/mutation policy
and permanent erasure rules are unchanged.

Each list uses one native keyset page with one-row lookahead and exact bounded
authority reads, without totals/history scans. `next` is an authenticated opaque
AES-GCM cursor, using purpose-separated HKDF keys from the persistent Auth secret,
bound to issuer, account, native session, client, epoch, session scopes, view and
limit. It expires after 15 minutes. Modified, foreign, expired or changed-binding
cursors fail with 400 before the page read and return no partial list. Consumers
pass the same limit on subsequent pages. Concurrent changes are read at the next
page's current snapshot; keys already passed are not repeated. No inventory cache,
new key store, index or retained private record is introduced.
Registration command durability, retries and Access activation remain the
registration workflow's responsibility.

Scope-list validation uses a bound computed once at service creation: the size
of the union of `openid`, `offline_access`, `media:complete` and every mounted
`siteActions` key, including anonymous actions. Without `siteActions`, the bound
is 1,000 entries. Generic registration, session proofs, consent and token requests
apply it before deduplication; website registration applies it after deduplication.
Each scope still has a 128-character limit and the existing OAuth scope character rules.
Validation touches only the request's scopes, costs O(scopes in the request),
at most O(mounted actions), and adds no reads. Token scope claims and stored
consent remain O(mounted actions), which is platform configuration, not user data.

Better Auth 1.8.0-beta.3's installed public `$context.adapter` types support
`create({ forceAllowId: true })` and `transaction()`. Provisioning uses that
facility with `user.id = account_id`, and credential `accountId = userId`.
No internal identity mapping is necessary. The tests inspect actual PostgreSQL
rows to prove those IDs and the persisted password hash. `name` is always the
mandatory empty placeholder and `image` is null. Password verification, signed
cookies, session persistence, expiry and revocation are Better Auth operations.

## Trusted account effects

The new `TrustedAccessPorts` effects are optional at construction. An absent port
denies its feature; unrelated password, session and verifier consumers still
construct normally. The host must bind these ports to durable Access commands,
never to request booleans or a second permission engine in Auth.

- `consumeAuthorization({ authorization, subjectAccountId, purpose, human })`
  consumes an Access receipt exactly once. `human` is the verified Better Auth
  `SessionProof` derived from the provided session headers, never a caller's
  identity claim. Access rechecks current relationship, operator management,
  human/subject epochs, verified client/scopes and expiry. Its
  `EffectAuthorization` binds receipt ID, purpose, subject, actual human,
  operator, client, scopes, human epoch and subject epoch. For a person's
  credentials the operator is null and the person manages their own account.
  For an automated actor Access decides the operator approval. Session receipts
  and the exact credential purposes (`set-password`, `remove-password`,
  `add-key`, `remove-key`) cannot be interchanged. Auth also journals receipt IDs
  durably to prevent duplicate local issuance across instances.
- `consumePasskeyAuthorization({ authorization, subjectAccountId, purpose, operationKey, effectReference, human })`
  consumes an exact `add-passkey` or `remove-passkey` approval for the human's own
  account. The host opts into these floor purposes with `passkeys: true`.
  Passkey approvals bind the same immutable stage locators and current session
  evidence; they cannot authorize an operator or automated-account credential
  operation. `consumeAuthorization` retains the four password and key purposes
  above, plus `session`.
- `invalidateAccount({ accountId, previousEpoch, reason, proofReference, operationKey })` atomically checks the
  old floor and commits an increased account floor before returning an
  `InvalidationReceipt`. Its receipt ID, account and higher minimum epoch are
  mandatory. This port must never clear a fence. Auth uses it for
  `consent-reduction` before any reducing Auth write or session deletion.
- `readRecoveryAccount(accountId)` is an authoritative recovery-only read of an
  active human, including the current floor while fenced. Ordinary
  `readAccount` continues to deny that fence. No recovery read can establish a
  session or issue a token.
- `authorizeRecovery({ accountId, proofEpoch, proofReference, operationKey })` atomically rejects a stale
  recovery epoch and commits a higher floor with a durable receipt before any
  native password reset. It must retain any existing fence.

`internal.openAutomatedSession({ authorization, subjectAccountId, headers })`
requires a current human session and a current automated target. It consumes a
`session` receipt before creating any session. Better Auth's creation hook
rechecks current target, human, epochs, registered client and target consent.
The returned `Response` contains a `SessionProof` and Better Auth's signed
session cookie. Both session owner and token `sub` are the automated account.
`auth_session_opening` privately retains subject, opening human, operator and
consumed receipt ID after session revocation. Neither the approval reference nor
private opening attribution is placed in a token, public JWKS or HTTP error.
`act` remains reserved for token exchange.

`internal.setCredential({ authorization, subjectAccountId, headers, credential })`
consumes the exact purpose approved by Access. `credential` is either
`{ kind: "password", password }` (null removes the password),
`{ kind: "key", kid, publicJwk }`, or `{ kind: "key", kid, remove: true }`.
Password replacement and credential removal require an invalidation receipt
with a higher floor from the consumed Access command, before the native effect.
These effects currently require a readable active subject after that floor
increase; a fenced subject denies them. Human recovery uses its separate fenced
read. Destructive effects revoke the subject's native sessions. Failed effects
may spend the approval or leave the Access barrier raised; retry with a new
approved command rather than replaying its receipt.

A first operator opening or key installation creates a native credential owner
with `user.id = account_id` and a `credential` account row. A passwordless owner
has null password. The schema plugin makes the native email column optional;
an owner without an email has null email, with no synthetic recoverable address.
A supplied provisioning email remains private and never enables automated email
recovery. Organization subjects are denied before credential-owner creation.
Adding/removing independent credentials changes neither kind nor public ID.
Passwords are hashed/verified through Better Auth; its adapter and hooks own
credential rows, sessions, cookies and revocation.

Public keys are owned by account ID, indexed by `(account_id, kid)`, and limited
to registered ES256/P-256 public verification material. Private or symmetric key
material is rejected. JOSE validates each signin assertion with that registered
key and algorithm: exact owner `iss` and `sub`, exact scalar
`aud = <issuer>/token`, required `iat`, `exp`, `jti`, no future issue time, and a
maximum lifetime/age of 60 seconds. The durable account-wide JTI uniqueness
constraint arbitrates concurrent replay across service instances, including
key replacement. JTI rows are retained with the account. An assertion proves a
credential; it does not create another session store or a long-term bearer
credential. Key signin still passes all native session hooks, consent and epoch
checks. Credential keys never join Auth's public signing JWKS.

## Passkeys and credential freshness

Better Auth's `@better-auth/passkey` plugin is pinned to `1.8.0-beta.3`, matching
`better-auth`. It uses RP ID `rezics.com`, RP name `REZICS`, the configured issuer
as its expected origin, and requires a resident credential and user verification.
The native `/api/auth/passkey/*` routes remain private. Auth aliases require the
issuer `Origin`, reject queries and unknown JSON fields, return `no-store`, and
share the native `/signin` attempt budget. Errors use fixed codes.

| Route                             | Contract                                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /signin/passkey/options`    | `{}`; returns discoverable `PublicKeyCredentialRequestOptionsJSON`, including `userVerification: "required"` and no credential allow list, plus a ceremony cookie.                                                                                                      |
| `POST /signin/passkey`            | `{ response, client_id, scope }` and ceremony cookie; verifies an assertion and returns the same session proof and cookie as `/signin`, with `amr: ["pop"]`. Access, epochs, consent, session binding and replacement of the presented session follow password sign-in. |
| `POST /passkeys/register/options` | Session cookie and `{}`; returns `PublicKeyCredentialCreationOptionsJSON` plus a ceremony cookie.                                                                                                                                                                       |
| `POST /passkeys/register`         | Session and ceremony cookies and `{ response, name? }`; verifies, stages, approves and applies `add-passkey`, returning 201 `{ id, name, created_at }`. Names contain 1–128 characters after trimming; absent names are null.                                           |
| `GET /passkeys`                   | Session cookie; returns `{ passkeys: [{ id, name, created_at, last_used_at }] }` for this person only, limited to 32. `last_used_at` is null before the first sign-in.                                                                                                  |
| `POST /passkeys/remove`           | Session cookie and `{ id }`; stages, approves and applies `remove-passkey`, with a committed credential floor receipt and bounded session revocation, returning `{ success: true }`.                                                                                    |

The closed `CredentialPurpose` and `CredentialEffect` contracts retain the four
operator-manageable purposes: `set-password`, `remove-password`, `add-key` and
`remove-key`. The separate own-human `PasskeyPurpose` is `add-passkey` or
`remove-passkey`; `PasskeyEffect` describes their public credential material.
`CredentialFloorPurpose` records both sets in shared stages, approvals and floor
receipts. Passkeys belong only to their human owner; operator openings and
automated-account credential management exclude passkeys. The public passkey aliases operate only on the current person's
credentials. Installation can only stage a public credential produced by successful WebAuthn verification;
public credential-effect commands cannot install arbitrary passkey material.
The host dispatches passkey removal to the own-human `stagePasskeyEffect` port;
`stageCredentialEffect` keeps its password/public-key input and four-purpose result.
Passkey consumption uses the separate `consumePasskeyAuthorization` port.
The kernel binding opts into all floor purposes with `passkeys: true`; existing
password/public-key-only trusted hosts keep their original approval types and
refuse passkey effects when that capability is absent.
The plugin's verification hooks enforce the authenticator's verified UV flag and
hand registration to credential effects before native persistence.

The registration operation key derives from the ceremony challenge. Its encrypted
stage binds the verified public credential, exact ceremony response and name,
person, client and scopes. A retry after a lost response resolves that stage and
revalidates the committing approval before returning the same saved public result;
it never installs a second passkey. Removal advances the Access floor by exactly one before the
Auth transaction deletes the selected credential, revokes all of the owner's at most
64 sessions and commits its immutable effect receipt. The consumed approval and
floor receipt bind the exact route, account, opening, operation, effect reference
and digest. Current-time validity is rechecked through commit; a revoked source
session cannot replay the removal or advance the floor again. Removing
the last interactive credential (password or passkey) is refused with 409 and
`effect_status: "not_applied"`. A person can have at most 32 passkeys; another installation is 409.

Every own-human credential stage, approval and application requires `auth_time`
within the last 600 seconds, read from the native session row with cookie caching
and refresh disabled. This includes `/credential-effects/approve`, password
changes and the passkey aliases. An older session receives 401
`{ error: "step_up_required", effect_status: "not_applied" }` before any credential
or approval change. Client input cannot supply authentication time. Operator and
automated paths retain their existing rules; passkey listing and sign-in do not
require fresh authentication.

The Cost table separates the measured sign-in/list paths from registration and
removal. `passkeys.test.ts` and `credential-freshness.test.ts` exercise software
P-256 authenticators through real handlers, PostgreSQL and kernel capabilities.
The six ordinary growth cases retain their original 1/8/64 scales and bounds.
Consumable registration/removal fixtures prepare a fresh native ceremony and
selected credential for the scale's warmup and every physical measured invocation,
including runs discarded by the shared harness. Setup restores the capped native
session neighborhood outside capture and retains committed effects, consumed
approvals and expired challenge history. A failed growth check retains its original
samples without running a replacement diagnostic operation. The retained failure
below is historical evidence; the full acceptance command remains post-integration
proof of the current source's bound.

## Guarded human recovery

Hosts configure
`recoveryDelivery.deliver({ deliveryId, accountId, email, token, expiresAt, url })` as a
private delivery port. `url` is
`${issuer}/recovery#account_id=<encoded account id>&token=<encoded token>`.
Auth builds that URL and the mail adapter sends it verbatim. Only the native
Better Auth reset facility generates and verifies tokens. Auth adds a SHA-256
proof binding to the exact account and issuance epoch with a five-minute expiry.
The delivery port receives the proof; HTTP never returns it. `POST /recovery/start`
validates `{ email }`, passes the attempt limit, and answers `{ success: true }`
without waiting for the account lookup, Access or delivery. The detached work
mails at most one link per account per 60 seconds, and only for a current active
human. Unknown, automated and inactive addresses get the same HTTP answer and no
message. Completion still denies automation and organizations, missing evidence,
inactive accounts and Access outages.

`deliveryId` is the actual newly inserted Better Auth verification row ID. The
supported native Kysely adapter commits that INSERT, its typed ownership
projection and `auth_recovery_copy_source` together, before the after-create hook
or delivery. A deferred producer guard refuses typed reset writers that omit the
Source record. The original hook still binds token, owner and five-minute expiry;
it does not acquire credential authority or stand in for atomic recording.
`auth_recovery.proof_hash` remains authentication evidence only. Source metadata
contains the original nonsecret identity, pinned producer/version, native creation
and expiry and the actual known account roles. It contains no email, token, URL,
credential, identifying hash or guessed provider identity.

Before the callback, Auth commits one in-flight attempt under the current
all-role erasure fence, then releases its connection and locks. The callback wait
has a five-second deadline. Legacy callbacks cannot be cancelled; late sends
remain unresolved under their original identity. There is no automatic resend.
The existing `Promise<void>` ABI is preserved apart from the additive identity.
Void resolution records `legacy-void`; arbitrary returned values are discarded
without decoding or serialization (`unsupported-result`, zero retained response
bytes). Failure and timeout retain only fixed codes. No such result verifies a
receiver, sink generation, copy disposition or erasure. A failed technical
checkpoint cannot invalidate an otherwise successful recovery proof. Delivery
failure keeps the existing exact proof/verification cleanup; custody survives it.

Native-only `readRecoveryCopySource(database, deliveryId)` exposes the first
Source/status types. `readRecoveryCopySourcePage(database, { accountId, role,
after? })` reads one indexed typed role and at most 48 nonsecret locators, each
at most 1 KiB, below 64 KiB including status. Neither is an HTTP account lookup.
The existing native obligation records `recovery_copy_pending` separately from
shared history: `recovery-copy-custody` for a known unresolved Source,
`recovery-copy-coverage` for unconverted historical sends. This field also
defaults to unknown coverage on older obligations; pending native pages expose
it as `externalPending`. Local native cleanup and the
original 310-second consent lifecycle continue; unresolved Source metadata is
retained and indexed in the native role inventory. Empty pages, local expiry,
absence of a user and disabled callbacks never prove historical zero data.
Scoped native/shared-history proofs remain their existing proofs; neither closes
this independent external branch or supplies a terminal Auth acknowledgement.

No receiving owner with durable result verification is installed, so
`sinkGeneration` is explicitly null and custody remains unknown. There is no
optional receipt callback or configured namespace to mistake for owner evidence.
An actual receiving adapter must adopt the independent generation/fence, exact
result lookup/idempotence and bounded physical disposition boundary in the
[external custody contract](src/external-custody-contract.md) before any Source
can be minimized or certified. Restores and diagnostic Sources remain separate.

### Recovery Source recording cost

- Touches: the actual verification INSERT/typed projection, one exact Source
  key, five fixed typed-role erasure locks/probes and the existing proof INSERT.
  A native erasure acceptance or tail checks at most one indexed key per role.
- Bound: one native transaction for creation, one dispatch checkpoint, at most
  one callback outside all DB leases, and one fixed status update; no payload or
  history discovery. Status pages seek one role/key index with LIMIT 48; a full
  page of 1 KiB IDs and fixed codes stays below 64 KiB. No new erasure engine,
  scheduling loop, per-provider scan or cascade is introduced.
- Growth check: deferred to integration under this slice's minimal verification
  instruction. Focused existing-fixture producer cases cover pre-hook custody,
  rollback, released connections, void/ambiguous/late results and retained identity;
  existing exact recovery and external receiving acceptance remain unchanged.

Completion resolves the token with Better Auth's installed native verifier, checks
its account, expiry and issuance epoch, then atomically deletes that exact native
verification row, marks the existing Auth recovery binding consumed and commits
an immutable barrier receipt. Neither a missing token row nor a request field is
consumption evidence. Access must compare the proof epoch in its native command
transaction. Only after validating its returned account, higher floor and current
exact floor does Auth use the installed password hasher and native bounded session
revocation function to commit the credential CAS and applied receipt together.
An Access failure leaves credentials unchanged. The same token and intended
password can resume the committed consumption after restart until its original
expiry; another password or superseded credential cannot claim it.
Successful reset retains a fence. Only a later trusted Access lifecycle workflow
may clear it using fresh recovery/establishment evidence at the exact new epoch;
Auth exposes no fence-clearing effect and never upgrades an old session.

The original operator, recovery and invalidation fixtures establish the Auth
boundary using real Better Auth, PostgreSQL and JOSE. They are not final Goal
proof. The workflow suites below add native Access command bindings and durable
failure recovery. Deployment approval resolution, recovery fence clearing and
the complete lifecycle/permission outcome drivers remain application integration
work. Multi-account revocation runs as bounded DBOS steps.

## Public HTTP contract

Expose only `service.handler`. Do not mount a raw Better Auth instance. The
wrapper does not forward arbitrary paths. Better Auth email signup is also
disabled, and its session creation hook requires a private per-request context
that the wrapper installs only after password proof, key proof or a consumed
Access authorization. The private Better Auth plugin endpoint uses
`internalAdapter.createSession` and `setSessionCookie`; mounting it directly still
cannot establish a session without this private context.

All POST requests require JSON, the configured issuer `Origin`, and a body of
at most 16 KiB. Unknown fields and query parameters are rejected. Better Auth's
secure, HttpOnly, SameSite cookies remain on the issuer origin. The reverse proxy
must preserve that origin and sanitize forwarded client-IP headers used by
Better Auth. Host consent UI must show the selected client and scopes explicitly.

| Method and path                    | Input / result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /signin`                     | `{ email, password, client_id, scope: string[] }` or `{ account_id, password, client_id, scope: string[] }`; returns `SessionProof` and the Better Auth session cookie after password, Access and consent checks. A valid session cookie on this request is deleted in the same successful response                                                                                                                                                                                                                    |
| `POST /signin/key`                 | `{ account_id, assertion, client_id, scope: string[] }`; verifies an owned `private_key_jwt` and returns a native session                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /recovery/start`             | `{ email }`; `200` `{ success: true }` for every well-formed address, without waiting for lookup, Access or delivery. Detached delivery sends at most one link per account per 60 seconds, and only to a current active human                                                                                                                                                                                                                                                                                          |
| `POST /recovery/complete`          | `{ account_id, token, new_password }`; consumes the epoch-bound proof and invalidates through Access before native reset                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /session`                     | Cookie; returns only `SessionProof`, with a database session read and current Access/consent validation                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /token`                      | Cookie and `{ requested_by?: string }`; returns `{ access_token, token_type: "Bearer", expires_in: 300 }`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /consent/<client_id>`         | Cookie; returns `{ client_id, display_name, scopes, granted }` for a covered third-party client; 401 for an invalid human session, 404 for unknown, first-party, uncovered or reducing clients                                                                                                                                                                                                                                                                                                                         |
| `GET /sessions`                    | Cookie; returns `{ sessions: [{ id, client_id, client_display_name, created_at, expires_at, user_agent, current }] }`, only this person's unexpired sessions, newest first, at most 64; IDs are opaque native row IDs, never cookie tokens                                                                                                                                                                                                                                                                             |
| `POST /sessions/revoke`            | Cookie and `{ session_id }`; deletes an own session and returns `{}` without step-up; clears cookies when revoking the current session; unknown or foreign IDs return 404 without mutation                                                                                                                                                                                                                                                                                                                             |
| `POST /consent`                    | Cookie and `{ client_id, scope: string[] }`; explicitly replaces this actor's third-party consent and returns those fields                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /signout`                    | Cookie and `{}`; Better Auth deletes the session and clears its cookie                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /account-operations/approve` | Auth-host composition only; session cookie and `{ operationKey, operation }`, where `operation` is an organization creation, rename, deletion, transfer, transfer acceptance, membership or operator-fencing request without `authorization`. Requires `auth_time` within the last 600 seconds (otherwise 401 `step_up_required`); organization creation is also checked against the `organizations` platform gate group (403 `platform_closed`). Answers `{ reference, expiresAt }` from the kernel workflow approval |
| `POST /account-operations/execute` | Auth-host composition only; session cookie and `{ operationKey, operation, reference }`, plus `acceptance` for a co-approved transfer. Resolves the approval for the same person, runs the workflow and answers its native result, such as `{ accountId }`; replaying an operation key returns the same result without repeating effects. Transfer acceptance is approve-only                                                                                                                                          |
| `GET /.well-known/jwks.json`       | Public `PublicJwks`, containing only ES256 verification material                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The website client's OAuth/OIDC routes are listed under "Website client".
Unrecognized routes, including `/api/auth/*`, signup and raw password recovery,
are unavailable. `POST /recovery/start` accepts an email and does not disclose
whether delivery occurred; automated accounts receive no mail. Failure responses
expose only `authentication_denied`, never credential or Access details.
After a human's sign-in credential verifies, suspension instead returns 403 with legacy `error: 'account_suspended'` and native `code: 'ACCOUNT_SUSPENDED'` without its reason, a session, cookie or token; unverified credentials retain the generic refusal.

`internal.registerClient` accepts an optional `displayName`, trimmed to 1–100
characters (invalid values fail with status 400). It is stored as nullable
`auth_client.display_name`; re-registration replaces it, and omission stores null.
Consent reads return registered scopes and the person's effective granted scopes,
intersected with any pending reduction ceiling. Reads never create consent.
Every pages route uses current native session, human and Access checks, rejects
query parameters, and returns `no-store` with the fixed `authentication_denied`
error code on failure. POSTs retain the issuer Origin and closed JSON body rules.
The Cost table derives consent/session reads and single-session revocation,
including their complete handler growth citations. `pages-consent-sessions.test.ts`
exercises the real handlers and database.

First-party clients are preconsented for their registered scopes. Third-party
clients require persisted explicit consent. A person can consent from an existing
first-party session, then sign in for the third-party client. Signin binds the
requested subset to the new session; it cannot expand consent. Consent changes do
not expand existing sessions. A reduction first commits its immutable native
proof and `pending_scopes`/`pending_reference` ceiling on the exact consent pair,
without changing the original scopes or revision. Signin, native session creation,
session proof, `/token` and live-proof signing intersect consent with that ceiling.
Auth releases its connection and client lock before calling Access to raise the
floor, so Access's verifier can share even a one-connection Auth pool. A second
short transaction rechecks current client caps and the exact revision/reference,
commits the narrower consent, clears its matching ceiling and applies the receipt
atomically; session cleanup then visits at most 64 rows. Already signed old-floor
JWTs fail kernel's next account-floor check even with cached JWKS. Without the
invalidation port, reduction fails closed; consent growth needs no invalidation.
Lost acknowledgements, outages, proof expiry and proof collection never clear the
ceiling. Exact native retries reuse the original proof, receipt and floor. A later
current human nonreducing consent can supersede the request; first-party
materialization and caller-supplied references cannot lift it. `/token` accepts no client, scope, epoch or principal identity input. Its optional
`requested_by` field is an untrusted assignment reference. Session cookie caching is disabled, including on subsequent database reads.

## Purpose-specific barrier proofs

`createBarrierProofVerifier({ database: Pool })` is an inert Auth-only factory:
it neither launches DBOS nor opens a kernel database. Bind its
`verify(reference, { accountId, purpose, previousEpoch, operationKey })` to the
later concrete Access barrier adapter. It returns a frozen `BarrierProof` with
those four bounded fields, an exact SHA-256 semantic `digest`, and ISO `expiresAt`,
or `null` for missing, expired, superseded or mismatched evidence. Access still
owns account authorization and compares the floor in its command transaction;
a reference or a caller-supplied floor alone never authorizes a write.

The actual `/consent` caller publishes only after a current human `SessionProof`
and a reduction of that same owner's stored consent. Its digest binds the native
session identity and claims, client and registered scopes, consent revision, and
old/new scopes. A committed pending transition can resume with its original
native session after a lost Access acknowledgement; this exception cannot mint
another transition from a stale session. Expansion and noop produce no proof.
The actual `/recovery/complete` caller publishes in the exact consumption
transaction described above. Its digest binds the consumed native verification
identity, account/epoch, credential fingerprint and a server-keyed digest of the
intended reset. Receipts contain no tokens, passwords or bearer copies.

Both callers always supply `proofReference` and deterministic `operationKey`.
The optional input fields preserve structural fixture compatibility; a production
Access adapter must deny either missing field and resolve the purpose-specific
proof. Immutable receipt uniqueness and native CAS preserve exact retry identity.
Neither callback fixtures nor this verifier alone establish a concrete native
Access adapter. Evidence expires within five minutes and within the remaining
native source lifetime; committed Auth rows and persistent server configuration
suffice after process restart.

Auth maintenance can separately schedule
`createBarrierProofVerifier({ database }).sweep({ limit })`, where `limit` is an
integer from 1 through 1000. One invocation returns `{ removed, hasMore }`, deleting
at most that many expired receipts with indexed admission and bounded lock probes.
It never drains history. This task does not register a maintenance schedule;
expiry denies immediately even while receipts await scheduled cleanup.

## Kernel claim and verification contract

The configured issuer must be a canonical origin without userinfo, a path
(including a trailing slash), query or fragment. HTTPS is required except for
HTTP on exactly `127.0.0.1`, `localhost` or `[::1]`, with an optional configured
port, such as `http://localhost:4200`. Other loopback spellings, numeric aliases,
suffixes, private/LAN addresses and `0.0.0.0` are rejected. The configured origin
and port define the identity; request Host headers never select an issuer.
Better Auth chooses its native cookie security from this origin; HTTPS keeps
secure cookies. No environment mode or global insecure switch enables HTTP.

The API audience always uses HTTPS: production is `https://api.rezics.com`
without a trailing slash, and tests use `https://api.rezics.test`. A local HTTP
issuer does not permit an HTTP audience. Tokens retain the exact issuer and port;
own-key assertions must target exactly `${issuer}/token`, including that port.
Kernel may fetch HTTP public JWKS only on that same approved HTTP issuer origin.
The local issuer tests use separate migrated Auth databases; kernel tests run
password signin, token issuance and public JWKS verification over real loopback
sockets for all three approved hosts.

`SessionProof` contains only `account_id`, `client_id`, `scope: string[]`,
`authn_epoch`, `auth_time` and `amr`. Successful password verification installs
the epoch, authentication time (Unix seconds) and `amr: ["pwd"]`. Passkey verification installs `amr: ["pop"]`; website authorization, ID tokens and refresh accept it. Own-key
verification installs `amr: ["private_key_jwt"]`. Operator establishment uses
`amr: ["operator"]` and the opening human's original authentication time, with
private attribution to that human and operator. Reading a newer Access floor
never upgrades a stale session; fresh verified establishment is required. Tokens preserve the authenticated actor as their subject, including
when that actor is automated.

Access tokens have `typ: "at+jwt"`, `alg: "ES256"` and an identified `kid`.
The exact claims are `iss`, `aud`, `sub = account_id`, `client_id`, space-separated
`scope`, `authn_epoch`, `iat`, `exp`, `auth_time` and `amr`. `exp - iat` is exactly
300 seconds. No profile, email, password or session bearer secret is included.
`AccessTokenClaims.requested_by` is present only after current Access assignment
proof. It is the canonical string
`urn:rezics:request:<principal-uuid>:<request-uuid>`, using lowercase routed UUIDs.
The assignment changes neither the authenticated actor's `sub` nor the session's
client, scopes, epoch, authentication time or methods. Ordinary delegation never
issues `act`; RFC 8693 token exchange remains unsupported.

`service.verifier` supplies the configured `issuer`, `audience`, `jwksUrl`
(`${issuer}/.well-known/jwks.json`), `algorithms: ["ES256"]` and
`accessTokenLifetimeSeconds: 300`. Kernel owns local verification through cached
public JWKS and the subsequent single current actor state/epoch-floor read.
Auth implements no kernel request hook. The JOSE tests verify with public JWKS
alone and reject forged, unknown-key, wrong-issuer, wrong-audience and expired
tokens; they also distinguish person and automated actor subjects.

## Durable account workflow host

`createAccountWorkflows(options)` is exported from `src/index.ts` with
`AccountWorkflowOptions`, `AccountWorkflowPorts`, `AccountOperation`,
`RegistrationReference`, `WorkflowHandleTransition`, `WorkflowFence`,
`WorkflowMembership`, `WorkflowResponsibility` and `WorkflowAccount`.
The returned host exports:

- `start()` and `close()` for the official pinned DBOS SDK executor;
- `beginRegistration`, `installRegistrationCredential`, `activateRegistration`
  and `register` for staged human registration;
- `expireDueRegistrations` for expiry work using the authoritative clock;
- `renameHandle`, `createOrganization`, `setMembership`, `createAutomated`,
  `transferOperator`, `deleteAccount`, `fenceOperator`, `reduceConsent`,
  `revokeSessions` and `resumeOperation`;
- `reduceClientScopes` and `resumeClientReduction` for bounded client reductions;
- `authorizeOperatorOpening` for a replayable native Access opening receipt;
- `openOperatorSession` for immediate composition of that workflow and Auth issuance;
- `handler(Request): Promise<Response>`, which adds strict `POST /signup` with
  `{ key, handle, email, password, turnstile_token }`. It verifies each token with
  Cloudflare Siteverify before registration work and delegates other routes to the
  guarded Auth handler. The handler also serves `POST /account-operations/approve`
  and `/account-operations/execute` when `AuthHostOptions.accountOperations`
  supplies the kernel `approve`, `resolveForCaller` and `admitGroup` ports (see
  "Public HTTP contract"); without them both routes answer 503
  `account_operation_denied`.

Sign-up validates the case-folded handle against
`^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$` before staging or calling Access: 3–64 ASCII
characters, letters or digits at both ends, and letters, digits, `_` or `-` inside.
Whitespace is refused without trimming. Both the workflow entry point and `/signup`
use the same Auth constant; a source-parity test keeps it equal to Access without a
runtime kernel import. Access owns reserved-name refusals and its audited governance
exception. Protected handle reservations pass the freshly resolved workflow context
to Access; public sign-up supplies none. Expected old handles retain lookup validation.

Production uses `await createAuthHost(options)`, exported from `src/index.ts` with
`AuthHostOptions` and `AuthHostConfigurationError`. Supply the migrated Auth
`database` pool, the existing service options, persistent Auth-only 32-byte
`stagingKey`, account-workflow `access` ports, and `turnstile: { secret }` for
Cloudflare Siteverify. `AuthHostOptions.turnstile.fetch` can inject the Siteverify
transport for tests. Without Turnstile configuration, `/signup` answers 503. Call
`await host.start()` before
serving `host.handler`; `host.service`, `host.workflows` and nonsecret `host.config`
are also exported. Call `await host.stop()` at shutdown. Repeated/concurrent starts
launch once, and repeated stops join the same shutdown. `host.start()` registers
the first-party client `login` with no scopes when that client is absent, and
leaves an existing `login` client unchanged. Repeated or concurrent starts
register it once. `createAuthService` does not register it. SIGINT/SIGTERM stop
DBOS before closing the product pool and any injected `systemDatabasePool`.

Before resolving, `host.start()` also registers the first-party client
`rezics-auth-account-operations` through trusted `registerClient` in
`create-or-match` mode. `@rezics/auth-contract` exports its nonsecret
`AUTH_PAGE_OPERATION_CLIENT_ID` and readonly `AUTH_PAGE_OPERATION_SCOPES`:
`organization: ['organization:create']` and `delete: ['account:delete']`.
Its ceiling is exactly their deduplicated union. An incompatible existing party
or scope set fails startup with `AuthHostConfigurationError`, code
`operation-client`, preserving the registry and native reduction fences.

The existing `POST /signin` (`email`, `password`, `client_id`, `scope`) and
`POST /signin/passkey` (`response`, `client_id`, `scope`, after its options ceremony)
accept one selected fixed profile after real authentication. Their sessions and
live proof tokens retain that exact client and scope. This registration supplies
no grant, managed-account deletion or security-setting authority, and never enables
cookie sign-in as the confidential `rezics-website` client.
Web owns the step-up consumer: retain the initiating account, exact pending operation
key and body, verify the returned account, and require normal confirmation plus
fresh caller-bound native approval. `return_to` is navigation only; it selects
neither client nor scopes. The native organizations platform gate remains mandatory.

Account management uses the separate native first-party client
`rezics-auth-account-management`, registered by the same trusted create-or-match
path. Its exact registration ceiling is `account:update`, `organization:membership`
and `account:manage`. `AUTH_MANAGEMENT_SCOPES` and `managementOperationProfile`
publish the selected live profiles: rename requests only `account:update`, membership
only `organization:membership`, and transfer/transfer acceptance only `account:manage`.
Native authentication materializes current consent; registration and navigation grant
no permissions. The fixed organization/delete client and ordinary login are unchanged.

`POST /account-management/profile` accepts only `{ accountId }` as a selection of the current initiating human.
The default host binds `trustedAccess.readRenameAccountProfile` from Kernel's `createNativeAccountBindings`;
the producer-owned private seam in `access/account-profile-source.ts` reuses `readEditableAccountProfile`, the same
source and actual native permission formula as `GET /v1/accounts/{accountId}/profile`. Auth signs the live proof for
native Access authentication; account equality and the exact management rename profile alone never authorize reading.
The response allowlist is `{ profile: { id, kind: 'actor', handle: string | null } }`, including handleless accounts.
The route requires same-issuer Origin, JSON, no query or bearer header and a current native human cookie session;
it revalidates that same proof after the source read. Every response is `private, no-store`. Missing bindings, failed
authority or malformed reads disclose no profile and remain recoverable unavailable in the page.
Decision: profile review accepts a current, possibly stale rename-profile session; approval retains fresh authentication.

`apps/auth/src/management-operations.ts` exports the closed `ManagementOperation`,
`loadManagementSession()`, `managementOperationProfile(kind)` and
`executeManagementOperation({ operationKey, operation, accountId })`. Here `accountId`
is the initiating human, not necessarily the managed subject. Both existing operation
routes accept this optional comparison field. When supplied, the host compares the
native fresh human's account, client and exact operation profile before obtaining an
Access token through `accessTokenForProof`; no browser proof or bearer is accepted.
Existing native approval resolution and workflow authorization still decide authority.
Transfer acceptance is approve-only: its complete result contains the real `reference`
and `expiresAt`, to be used as the source transfer's `acceptance`. It never executes.
Other complete results contain the native subject `accountId`. Refusal, step-up,
unavailable dependencies and uncertain execution are distinct typed outcomes.

Page owners supply the forms for `/account/rename`, `/organizations/members` and
`/operators/transfer`; the Auth page server and production triggers dispatch these
paths. On explicit submit, retain one immutable key and descriptor. If step-up is
needed, `storePendingManagementOperationStepUp(input)` and
`managementOperationStepUpUrl(operation.kind)` save and select the exact continuation.
Password/passkey login checks the returned native human and profile, rechecks the
saved body/key, and returns only to that kind's fixed route. Return does not approve
or execute. The page reads `pendingManagementOperationStepUpState()`, restores the
descriptor and key, resets its confirmation, and calls `executeManagementOperation`
only on a second explicit submit. It must reject a mismatched continuation using
`pendingManagementOperationMatches`, and clear it only on completion or explicit
cancellation. Awaiting, substituted or malformed continuations cannot execute.
Stale sessions require another step-up; approval expiry and current native checks
still apply. An unknown execution result is not final workflow/readback evidence.

`POST /account-management/operators/relation` is the private native source for the
existing transfer page. Its exact JSON body is `{ subjectAccountId: string }`;
success contains only `{ previous: { operatorAccountId, subjectAccountId,
reservationId }, expectedVersion: string }`. The reservation, operator and decimal
version come from the current native Account and nonterminal operator slot. Public
profiles and caller tuples never supply this evidence. No accounts are enumerated.
The source releases its first snapshot before Access prepares foreign authority,
then rechecks the exact source tuple/version and ordinary `account:manage` on the
actual operator in a final snapshot at the same native T. It also checks current
actor/floor, principal assignment, lifecycle and partition availability. Scope alone
does not authorize disclosure.

The default host mounts this read through the optional
`AccountOperationAccess.readOperatorTransferState` binding, or the independent
`AuthHostOptions.accountManagementReads` port. Supply the production
`createAccountManagementReadAccess({ pool, access })` from Kernel
`access/management-source.ts` as `accountManagementReads`, or copy its exact
`readOperatorTransferState` method into existing approval/gate ports. This leaves
the frozen native account-workflow composition shape and required callers intact.
Existing callers may omit the additive binding; the endpoint then answers 503
`account_management_read_unavailable`, never an empty successful result. The host
retains its management-client registration. It uses the real fresh-human proof and
exact transfer profile, obtains the Access bearer through `accessTokenForProof`,
and revalidates that same Auth session/account/floor/consent after the source read.
Tokens remain inside the trusted proof scope. The route requires POST, current
Origin, JSON, no query or bearer header, and the existing CSRF boundary. Responses
are `private, no-store`. Closed failures use 400 (shape/transport), 401 (session or
`step_up_required`), 403 (refusal or missing relation), 409 (changed source),
413 (bounded body), or 503 (unavailable source/binding). Refusals disclose no tuple.
The result supplies current readback only: destination acceptance and source
approval/execute keep their original immutable descriptor, operation key and
explicit confirmation requirements.

Native workflow requests resolve the complete original creation request before checking
out the copy writer's SDK transaction. `workflow-request-parties.ts` uses the shared
`creation-party-context.ts` `readApprovedCreationContext` helper and the exact
`@rezics/auth-contract` `NativeCreationContextRequest` and `NativeCreationContextResult`
through the native `readNativeCreationContext({ approvalReference, operationKey, operation })`
function. The original resolver checks the full operation, digest and key with its unchanged
current-T formula. Auth compares the available result's original reference, key, digest,
command prefix, operation kind and target client against that request and its resolved
approval binding. Historical, opening or absent provenance remains unavailable; neither
caller JSON nor an actor-only callback supplies it.

Only the frozen literal attribution is staged for the transaction: `actorAccountId`,
`actingHumanId`, `operatorAccountId`, `principalAccountId`, authenticated `sourceClientId`,
the original approval/key/digest/command binding and the native operation projection.
Actor and human are independent; the source client is separate from the operation's
target client. Explicit nulls mean the source proved that role inapplicable. Current native
`copyActors` supplies the existing human/initiator/delegate roles and actor version unchanged;
these must agree with the genuine source. No source read or foreign pool checkout runs while
the SDK client is held. The preselected organization target and existing digest command
prefix are resolved before checkout too. The snapshot conveys attribution, never cached
allow: approval, execution, protected steps and disclosure retain their current authority.
This is a consumer boundary, not producer, custody, native or participant completion.

The closed business-variant projection records subject, both transfer operators,
membership target, original target client and stage separately. Organization IDs use
the operation's existing preselected native key; automated subjects come from the
locked original stage. It captures target/source client owners under the existing
client locks. All original accounts and both clients pass the actual current erasure
guards before serialization, on the transaction that creates the request and SDK
handoff together. Any source, fence or SDK failure rolls both back. Workflow IDs,
business digests, operation keys and enqueue input shapes keep their original ABI.

`request_party_version` and `request_context_version` pin this projection. Indexed
actor, principal and source-client columns add the missing provenance. The versioned
native inventory below binds their erasure seeks to the original producer. Every original role and version is immutable on replay,
even in the creation transaction; current relations never refill a request. Existing
rows retain version zero and unknown pending provenance. Request scope reads only
original typed columns. A request locator does not establish SDK copy coverage.
The copy retirement transaction minimizes a private request through the exact native
registration closure or consumed non-stage result in `nativeRequestTerminal`, while
its existing copy work and roles still anchor SDK history cleanup. The SDK deletion
trigger uses the same native closure. Terminal SDK status or `terminal_at` alone
cannot retire the request. Missing original result consumption remains pending.

The two request producers are `workflows.ts`'s `runOperation` and
`reduceClientScopes`; the atomic source callback is in `erasure-copy.ts`. The Access
producer belongs to `services/kernel/src/access/native-account-bindings.ts`; this
slice leaves that producer and stage/provisioning composition to their owners.
`test/workflow-request-parties.test.ts` includes the deferred real-native producer
scenario and focused closed-projection cases. It supplies no fabricated context to
the native positive path and makes no final participant or native-suite completion
claim.

The native DBOS system schema is `auth_dbos` in the **same Auth database**.
`systemDatabaseUrl` defaults to the product pool URL; an override or injected
system pool must name that same database. The SDK creates and migrates its schema;
Auth's schema dump excludes only `auth_dbos`, retaining native credential tables.
Configuration errors have the name `AuthHostConfigurationError` and nonsecret
codes. Set `executorId` uniquely for each replica and retain that identity when
restarting it for native recovery. `maintenanceSchedule` is numeric UTC cron
(five or six fields), defaulting to once per minute.

The host registers account workflows and one maintenance workflow before one
Auth DBOS launch. The service-local `auth-maintenance` queue has concurrency one
across replicas; native scheduling, durable steps, recovery and history remain in
Auth. Every tick invokes one session-expiry batch (≤1000), one retention/CAS-guarded
signing retirement (≤1 hot key), and one verification-expiry batch (≤1000).
When due consent erasures exist, it also admits at most 100 erased accounts;
each admitted account's complete consent range is processed without a client cap.
Consent remains until five minutes and ten seconds after Auth deletes the account, covering the 300-second access-token lifetime plus margin.
The cleanup only removes consent for accounts whose Auth user row is gone and
takes each affected client's `auth-client:<client_id>` lock before deleting its
row. Due work remains for later ticks; live-account consent is retained.
Only counts enter step history. Backlog waits for another scheduled attempt;
automatic schedule backfill is disabled, and ticks perform no bootstrap upgrade
or all-account traversal. Kernel receives no Auth maintenance RPC, queue entries,
database credentials or keys. The kernel's single-worker rule concerns its own
shared queues. Ordinary `createAuthService` consumers never start DBOS.
`createAccountWorkflows` remains available for explicitly composed hosts and
isolated fixtures, including a separate native system database. The application
calls `expireDueRegistrations` when advancing its authoritative clock; that method
sends durable expiry messages to existing account workflows.

Registration arguments contain only an opaque stage reference. AES-256-GCM
staging binds encrypted credential input to that reference, account and normalized
handle. Purpose-separated HKDF keys protect encryption and credential binding.
Only the credential step decrypts; DBOS receives a nonsecret owner reference.
Auth credential installation and its idempotency receipt share one Auth transaction.
Pending accounts cannot establish sessions. A provisioned handle barrier precedes
activation; expiry terminalizes/fences the pending Access account before releasing
its exact claim and erasing its Auth owner. Terminal/completed stages clear ciphertext.

`AccountWorkflowPorts` consumes structural shapes of real Access command results.
Commands return native receipts; the coordinator journals their nonsecret values
and stable keys. `authorizeOperation` must resolve a durable approval to a currently
authenticated kernel context and check current authorization with the installed
Access formula before returning, including on workflow replay/resume. Approval
references are opaque, nonsecret references, never cookies or bearer tokens. All
workflow methods are trusted application APIs; public JSON cannot select account
identity, kind, epoch, operator or an authorization context. Only `/signup` is a
new public endpoint. A workflow failure remains durable. `resumeOperation` uses
the SDK's rewind API from the failed step, retaining successful Access barriers.

Handle publication uses the actual lifecycle exports `holdHandle`,
`transitionAccountHandle`, `bootstrapOrganizationHandle`,
`finalizeHandleTransition`, `redirectTransitionHandle` and
`completeHandleTransition`. A purpose/account/reservation/operation-bound hold
never expires merely because DBOS pauses. The account-anchor command checks
`account:update` through `accessCommandAuthorization` before receipt lookup,
conditionally changes the expected current handle and serializes outstanding
operations. Final claim, old redirect and completion are separate partition
commands. Old redirects retain the original 30-day interval. Trusted cancellation
uses `cancelHandleTransition` followed by `releaseHandleTransition`; its permanent
account-local terminal slot prevents delayed publication and stale releases.
`expireRegistration` and `releaseExpiredRegistrationHandle` provide separate
account-terminal and exact-reservation cleanup commands. Generic account patches
continue to reject handle changes.

## Evidence and remaining integration

`test/workflows.test.ts` is boundary evidence: deterministic Access receipts are
journaled fixtures, with real isolated Auth, Better Auth, JOSE and DBOS storage.
It does not implement Access policy. Every issuer deployment owns its migrated
fixture; the workflow tests never reuse the foundation deployment's global keys
or clients through `AUTH_TEST_DATABASE_URL`.

Kernel's `test/access/workflow-handle.test.ts` exercises real PostgreSQL lifecycle
commands. `workflow-handle-durable.test.ts` composes the workflow host with those
actual commands, real Auth credentials, JWT authentication and the merged Access
formula. It kills an executor process after credential/handle barriers, recovers
persisted DBOS history and loses command acknowledgements at every handle phase.
It checks native receipt replay, indefinite held reservations beyond the pending
TTL, organization owner grants, exact expired-registration cleanup and serialized
credential confidentiality. The original lifecycle and Auth outcome assertions
remain unchanged. Final application transport bindings and the original complete
lifecycle conformance driver remain an integration seam.

Membership coordination uses `reserveCoordination` on the member anchor,
`setMembership` on the organization anchor and `releaseMembershipCoordination`
on the member anchor after removal or cancellation. Release independently reads
the exact permanent terminal organization slot before checking out the member
connection, then deletes only the matching membership-purpose hold in one native
command. Active, absent, mismatched or nonterminal evidence denies. Operator
responsibility release remains operator-only. The existing monotonic slot is
sufficient; this release adds no schema or policy interval change.

`workflow-membership-release.test.ts` covers real PostgreSQL terminal evidence,
last-owner protection, delayed activation denial, exact-purpose cleanup, native
receipt replay and deletion eligibility. `workflow-membership-durable.test.ts`
binds actual member commands to DBOS, loses release acknowledgements and checks
recovery from persisted history. It also binds actual operator reservation,
relation, opening/consumption and transfer commands to real Auth sessions. Tokens
and cookies stay outside DBOS. Real consent and client reductions demonstrate
that previously issued JWTs deny at the next authoritative kernel account read.

`test/workflow-operations.test.ts` supplies additional boundary sequencing
coverage with its own migrated issuer database and separate DBOS system database.
It journals deterministic Access responses and exercises actual credential owners,
Auth erasure, consent and client configuration. It covers transfer/deletion failure,
bounded fanout and interrupted client reduction; it supplies no Access policy.
Final deployment approval resolution and the original lifecycle outcome driver
remain application integration work, including binding state suspension to Access
policy. `fenceOperator` provides the durable fencing fanout itself.

## Operated actor session opening transport

`/automated/open` is an additive Auth page and production fetch trigger. It uses
the existing `rezics-auth-account-management` registration with the exact
`opening: ['account:manage']` operation profile. The registration ceiling remains
the same three scopes. Ordinary sign-in, organization/deletion profiles, deployment
availability contracts and the shared Web AccountMenu are unchanged.

The closed protocol is:

```ts
// POST /account-operations/approve
{
  accountId: initiatingHumanId,
  operationKey: originalKey,
  operation: { kind: 'opening', operatorAccountId, subjectAccountId },
}
// -> { reference, expiresAt }
// POST /operator-sessions/open: the exact same body plus reference
// -> actual native SessionProof with genuine Set-Cookie headers
// { account_id, client_id, scope, authn_epoch, auth_time, amr: ['operator'] }
```

Both transports require current fresh human proof and the exact selected profile.
The browser reuses the shared management approval stage, including its immutable
snapshot and exact pending/session checks; only issuance and its result parser are separate.
Approval uses native Access approval; opening resolves the reference for that
current caller before invoking only `createAccountWorkflows.openOperatorSession`.
That existing workflow rechecks current operator authority, floors, consent and the
exact session-purpose opening, then Auth consumes it once. It returns Auth's HTTP
response verbatim, including native session cleanup on failed establishment. No
session, cookie or proof is a workflow result or DBOS payload. Missing host Access
composition answers 503. Generic execution explicitly rejects `opening` in both
the host and the browser helper.

Selection is private and explicit. An Origin-protected server function reads the
delivered `/account-management/operators/relation` native point source using the
current fresh human and exact opening profile. Missing native source disables
confirmation. Confirmation can name the actual subject and operator IDs from that
authorized tuple without inventing labels or operator kind. If the existing native
`/v1/accounts/{id}/management` projection also permits label disclosure, its exact
subject, operator, reservation and version must match before displaying its names.
The opening profile does not gain `account:read` for labels. URL roles or assumed
equality to the human supply no authority. Contradictory tuples disable confirmation. The
page explains the browser identity switch and names only the actual authorized
subject and operator. Step-up returns only to `/automated/open`; navigation and
reauthentication never issue a session. Confirmation is required again on return.

Immediately before the single issuance attempt the shared private pending record
is marked submitted. It contains only the original descriptor, human, key and
continuation phase, never the approval or private metadata. The approval reference
exists only in the ephemeral request stack. A lost or ambiguous response is UNKNOWN
and is never automatically replayed. Readback uses native `/session` alone and
displays a matching subject with operator authentication as the actual current
session, without claiming which request established it. It neither refreshes
cached metadata nor restores a cached human session. Another opening requires a
deliberate new key, fresh same-human sign-in, current metadata, new confirmation
and native authorization. Automated proof is kept separate from the human-only
management proof; displayed scopes are only the actual native receipt-bound scopes.

Focused fixtures are `test/operator-session-transport.test.ts` and the Auth pages'
`test/operator-session-opening.test.ts`. This transport adds no native authority,
credential writer, relation, permission evaluator or deployment proof.

## Operated actor creation transport

`/automated/new` is an additive Auth page and production fetch trigger. It does not
change route-admission contracts, add a menu link or claim deployment availability.
It uses the existing credentialless `createAccountWorkflows.createAutomated` path;
there is no new registration writer, handle allocator, account kind or actor session.

The actual Auth-host protocol is:

```ts
// POST /account-operations/approve
{
  accountId: initiatingHumanId,
  operationKey: originalKey,
  operation: {
    kind: 'automated',
    registrationId: '',
    operationKey: originalKey,
    operatorAccountId: selectedOperatorId,
    handle: normalizedHandle,
  },
}
// -> { reference, expiresAt }
// POST /account-operations/execute: same body plus reference
// -> { accountId } only, from the completed native workflow
```

Both calls require the same real fresh human and the exact existing separate
`rezics-auth-account-management` client with `['account:manage']`. They use
`withFreshHuman`, `accessTokenForProof` and native Access approval/caller resolution.
Access checks current operator authority, including organization membership, floors,
client/principal scopes and denials. Execute calls only
`createAutomated({ key: originalKey, authorization: reference, operatorAccountId,
handle })`. The native workflow creates the stage and supplies its registration ID;
the browser can supply only the initial empty registration ID. Access's existing
`creationBinding` verifies that stage against the original approved business request.
Owner impersonation, browser bearer input, credentials and extra fields are refused.
Unexpected or pending native results cannot become complete creation results.

The shared management discriminator currently omits `automated`. The exact additive
alias needed is `AUTH_MANAGEMENT_SCOPES.automated = ['account:manage']`, together with
`ManagementOperation`/`ManagementOperationKind` support for the native descriptor
above. The local typed adapters use the already installed `transfer` profile, which
has exactly those scopes. Shared active constants and the shared step-up engine are
unchanged. Explicit inline native sign-in selects only that profile and materializes
existing current consent; it never approves or creates. Missing registration or
native ports refuse availability rather than fabricating approval.

Review requires a private server adapter to the actual
`GET /v1/accounts/{selectedOperatorId}/management` read. It issues a native token
from the current Auth cookie only on the server, uses configured `KERNEL_ORIGIN`,
checks the initiating account and returns the selected native identity. Public
profiles and imported rows are not substitutes. The installed management read also
requires `account:read`; the creation profile remains exactly `account:manage`.
When the current session cannot read the target, or runtime configuration is absent,
review shows target unavailable. No read scope is added to the management ceiling.
A previously reviewed identity is presentation only: native approval and execution
recheck actual authority after profile sign-in.

The page explicitly confirms the exact operator ID, handle and initiating human.
It retains one immutable key and business body in session storage across lost
responses, reload and inline step-up. Reauthentication clears its transient password
and resets confirmation; only a second explicit submit may create. Each explicit
retry obtains current native approval for the unchanged binding. Navigation and
restoration have no native effect. A lost response stays uncertain; a closed native
`{ accountId }` is creation evidence, not a claim about a later public identity read.
No optional credential input is exposed, so no actor password enters page storage,
URLs, logs or a second staging path. All new actual workflow copies retain the
existing native owners; rollout, identity publication and erasure debt stay with
those owners.

`test/automated-account-transport.test.ts` reuses the existing native account-binding
fixture and names the approved creation acceptance, exact replay, foreign denial,
source/key/operator substitution and stale-profile cases.
`apps/auth/test/automated-account-create.test.ts` and the focused
`automated-account-create` stories cover confirmation, response loss, unavailable
identity, step-up and pending-result refusal. Story fixtures are presentation evidence.

## Account operation ports and ordering

The optional operation ports deny their feature when absent. They use the native
Access command inputs/results: `setMembership`,
`releaseMembershipCoordination`, `reserveResponsibility`,
`recordOperatorRelation`, `retireResponsibility`, `releaseResponsibility`,
`responsibilityPage`, `provisionManagementDefaults`, `tombstone`,
`redirectHandle` and `authorizeOpening`. `readAccount` supplies a current narrow
account observation before deletion. The coordinator projects that observation
before journaling it; private profile data stays outside workflow history.

`authorizeOperation` must bind each complete request to fresh authenticated
actor/client/principal context and its current Access approval. In particular,
transfer/deletion responsibility inputs come from the actual durable relation
receipt; they are never public account authority. An application must preserve
that approval binding across executor restarts and resolve it again on replay.
Fencing or deleting an account requires an administrator or another authorization
that remains valid for recovery. An approval reference can be refreshed without
changing the stored operation request.

Automated creation stages optional credentials using the same Auth-only encryption
as registration. It reserves operator responsibility before installing the
subject-local relation, then creates exactly one credentialless or password owner,
claims its handle and activates it. Human registration and organization bootstrap
can install the native management defaults as a separate command. Transfer
reserves the new operator, changes the subject relation (invalidating old relation
approvals), revokes Auth sessions, terminalizes and releases the old hold. It
never copies resource grants. Deletion commits the authorized Access tombstone
and fence before Auth erasure, then retires/releases responsibility and calls the
deletion handle step to permanently retire the account's current handle without
forwarding or reassignment. Native Access commands
continue to enforce holds, operator eligibility and last-owner rules.

`fenceOperator` first commits the operator fence, then enumerates native pages of
at most 64 responsibility reservations. Each subject fence and Auth revocation
is a separate DBOS step. It returns only after all pages finish. Failures preserve
committed fences and successful step history. The host exposes no fence-clearing
compensation. Fresh recovery remains bound to the resulting floor and receipt.

`authorizeOperatorOpening` obtains `authorizeOpening` using the authenticated
context and returns its opening receipt without consuming it. A current caller
replaying the same key, with the same or a fresh approval, gets the stored receipt
without repeating effects. `openOperatorSession` composes that workflow with the
existing `internal.openAutomatedSession`. Auth's trusted
`consumeAuthorization` binding must call actual `consumeOpening`; an adapter
cannot manufacture a consumed receipt. Cookies, headers and Auth's response are
never workflow arguments or results. The one-use native opening deliberately
fails closed at issuance if its acknowledgement is lost. Replaying the opening
workflow still returns its original receipt; a second issuance is denied.

Consent reduction commits the native account fence before Auth's
`internal.reduceConsent` transaction records its barrier and shrinks consent.
Client reduction first installs an Auth-only issuance gate with
`internal.beginClientReduction`. It conservatively enumerates every current Auth
credential owner, including owners with erased sessions but possibly live JWTs,
in pages of at most 64. Each account gets its own native fence before
`internal.finishClientReduction` changes client scopes/first-party status and
removes the gate. This conservative invalidation also fences owners of unrelated
clients; they require normal fresh recovery. An Auth outage keeps both the gate
and the Access barriers. `clientReductionPage` and `resumeClientReduction` resume
the persisted DBOS workflow; a pure Auth client-row mutation is never completion.

The forward Auth migration records only the issuance gate. DBOS manages its
system schema separately. Migration versions use actual UTC creation time and
apply without fabricated global ordering; previously committed filenames remain
unchanged.

## Principal assignment composition

The application binds `trustedAccess.readAssignment(requestedBy, assignedActorId)`
to `readAssignment(accessReader, requestedBy, assignedActorId)`, exported from
`services/kernel/src/access/delegation-commands.ts`. The reader returns the
structural `AssignmentProof`: `resolved` evidence with principal, actor, request
and validity, or `none`/`unresolved`. It checks the actual principal-created row,
assigned actor, current database time, revocation, and principal state/fence.
The principal creates that row through `createDelegationCommands(...).create`
using an actor returned by the real Access authenticator. Bootstrap rows without
creator provenance cannot support delegation tokens.

Final drivers use these existing entry points for the complete request:

| Boundary             | Composition                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Principal assignment | `createDelegationCommands({ pool, access, action }).create({ pool, deadline, actor }, input)`, with the principal's authenticated actor and ordinary delegation grant/scope.                |
| Issuance proof       | `AuthServiceOptions.trustedAccess.readAssignment(reference, actorId)` bound to the exported Access `readAssignment` reader; `readAccount` bound to the authoritative Access account reader. |
| Token issuance       | `service.handler` at `POST /token`, with the actor's real session cookie and `{ requested_by: reference }`.                                                                                 |
| Bearer verification  | `createAccess({ actions, auth: service.verifier }).authenticate(token, { pool, deadline })`, using only the public JWKS endpoint.                                                           |
| Resource execution   | `accessCheck` or `accessCommandAuthorization` with that verified actor; commands execute through `runCommand` with the actor, client and unchanged assignment reference in their basis.     |

Auth rejects a malformed reference before calling the port, verifies every
returned identity against the reference and cookie subject, and uses
`trustedAccess.readAccount(principalId)` for a further active actor/fence check.
The account adapter maps Access `minimumAuthnEpoch` to `authnEpoch`, preserves
`fenced`, and derives `automated` from `operatorAccountId`. Missing ports,
unresolved proofs and dependency failures deny issuance. Auth owns its separate
database and signer; it imports no kernel pool or permission SQL. No assignment
proof or principal identity is persisted in the Better Auth session.

The additional proof work uses the exact principal/request key in
`principal_assignment_pkey(route, principal_id, request_id)` and the principal's
`account_pkey(route, account_id)`, touching at most two Access anchors including
the actor. These point reads examine O(1) rows with logarithmic index-buffer growth
in relevant authority rows; they enumerate no assignments, memberships or resource
ACLs. This is an access-path bound, not growth measurement evidence. The existing
resource permission formula and its organization-candidate fanout remain separate
from assignment proof.

For verification, compose `createAccess` from `services/kernel/src/access/index.ts`
with the route action catalogue and `auth: { issuer, audience, jwksUrl }` from
`service.verifier`. Its public JWKS transport may use the ordinary HTTPS endpoint;
the integration fixture binds `fetch` to `service.handler`. Each authentication
re-reads the assignment through the same Access reader before returning the
unchanged `requestedBy: string | null`. A present malformed, unsupported, missing,
revoked, mismatched or unproven claim raises `AuthenticationError` with status 401
and challenge `Bearer error="invalid_token"`. Principal and organization evidence
is prepared before resource checkout. The existing resource formula checks actor
grants, token scopes and principal grants, including denials and time validity,
on the resource transaction. Commands retain client and assignment in their
receipt basis and digest.

Native OAuth and workflow adapters must retain these claims and proof ports.
An assignment reference grants no registered-client identity, client credential
proof or extra scope. Website integration must retain its exclusive
`media:complete` scope, confidential `private_key_jwt` issuance, PKCE, refresh,
revocation and person-as-sub contracts. These requirements remain the client
adapter's responsibility; delegation uses the existing registry, consent and
signer rather than introducing another issuance path.

`test/access/delegated-auth.test.ts` in kernel exercises the composition with
separately migrated Auth storage, native Better Auth credentials/sessions,
production principal assignment commands, public JWKS verification and real
resource commands. It covers independent actor/scope/principal denial, current
assignment and principal invalidation, direct automation credentials, and receipt
binding. Auth's existing boundary suites retain their independent issuer storage
and signing rotation checks.

## Cost

The cost evidence below was recorded with Better Auth 1.8.0-beta.2 and DBOS
5.4.6-preview; current dependency pins are in `package.json`. Each row identifies
its native entry point; helper checks do not stand in for extra handler or durable
wrapper I/O. Startup/schema migration, bootstrap and one-time legacy session
upgrade discovery/trimming are excluded. Unimplemented account-erasure participant
and terminal workflow steps have no runtime row.

Host startup adds one fixed operation-client registration under its existing
one-client lock. It performs exact-key reduction and registry reads; absence adds
the native registry and coverage inserts. A matching replay makes three selected-client
registry touches (lock, reduction read, client read) at 1/8/64 unrelated clients in
`test/auth-page-operation-client.test.ts`. Work is constant in total accounts,
clients and history, with logarithmic indexed access. It runs only at startup;
sign-in and operation paths retain the bounds below.

R counts examined relation rows, B shared-block accesses, and Q client SQL statements
including BEGIN/COMMIT and advisory locks; native FK/trigger work counts in R/B
without adding client statements. N is the relevant table/history population and
L is the sum of log(2 + cardinality) over touched tables. An indexed point probe
examines constant rows and logarithmic blocks; fixed index/constraint writes cost
O(L) blocks. Bounds assume ordinary vacuum maintenance, fixed row/crypto sizes and
no unbounded lock wait; they describe access paths, not timings or forced plans.
A, S, K, C and D count accounts, retained sessions, signing keys, clients and consents;
P, J, E, O, H, V and T count public credentials, assertion JTIs, effect receipts,
openings, recovery bindings, verifications and provisioning receipts. Lower-case s
is the selected owner's stored sessions, including expired ones, capped at 64.
Scope inputs use the service-creation known-scope bound (1,000 without a mounted
catalogue), ≤128 characters per scope and ≤16 KiB HTTP bodies; the standalone
current-consent reader validates at most 100 scopes per list.

`proof` includes native session/user reads, current Access evidence and exact
client/reduction/consent checks (3–4 Auth statements). Native joins become separate
SELECTs with `advanced.database.joins` unset and cookie/secondary caching disabled.
Credential inserts also use `account_pkey`, `account_userId_idx`,
`credential_owner_unique` and user FK probes; session inserts use `session_pkey`,
`session_token_key`, `session_userId_idx` and user/client PK FK probes. Each indexed
write maintains its fixed schema indexes. Trusted Access backing-store costs are
additional unless the cited series explicitly captures native Kernel bindings;
workflow rows include their stated native persistence. Rejections stay anchored;
identifier-wide invalidation and actual cascade/consent fanout keep their explicit
linear bounds.

| Operation                                                      | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Growth check                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session verification                                           | Cookie signature yields token: `session_token_key` SELECT → ≤1 session, `user_pkey` SELECT → ≤1 owner; `proof` adds client/reduction/consent below. Expiry is local; presented expired token adds snapshot SELECT + DELETE by token (≤1 row each). Seven-day lifetime, one-day native update age; `disableRefresh:true` suppresses ordinary refresh, while establishment-failure native lookup can UPDATE one session by token. Grow S (including expired rows), A, C, D; fix token, owner, scopes and expiry/refresh branch.                                                                                                                                                                                                                                                                                                                                                                                                    | R=O(1), B=O(log S+log A+log C+log D); Q=2 native lookup, 3–4 proof, 4 expired lookup/deletion, 3 native refresh (all constant).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `test/growth-sessions.test.ts`: “Session verification stays within its bound as S grows”                                                                                                                                                                                                                                                                                    |
| Access token issuance                                          | `/token`: native session/user point reads identify the client, then a shared client barrier, exact coverage/reduction checks, `proof` and client lookup. First-party issuance materializes one consent pair. Signing rechecks the singleton generation and seeks at most three live keys; no archive or token-table scan. This JSON `/token` path does not issue or rotate refresh tokens; the website form endpoint is separate, and `account.refreshToken` is unused. Grow unrelated S and archived K; fix live session, owner, claims, client/scopes and request count.                                                                                                                                                                                                                                                                                                                                                       | R=O(1), B=O(L), Q=O(1): constant rows/statements and logarithmic blocks, including barrier locks and signer refresh. Imported-key/claims work and JWKS slots are bounded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `test/growth-sessions.test.ts`: “Access token issuance stays within its bound as S grows”                                                                                                                                                                                                                                                                                   |
| Live-proof token                                               | `internal.accessTokenForProof` accepts this instance's immutable native human proof only inside its live `consumeAuthorization` callback (private O(1) identity/scope check; copies/foreign/stale fail before I/O). Shared native client barrier; one source-session PK read, one current Access human/state/fence/epoch point read, exact client/coverage/reduction/consent chain and materialization, ≤3 signer slots. Same `/token` API claims/ES256/JWKS, no delegation; expiry=min(300s, source lifetime). JWT stays in the trusted adapter call and enters installed Access via ordinary authentication; no HTTP route, DBOS/persisted token or effect grant. Grow unrelated accounts and other owners' native histories at 1x/8x/64x within cap64; fix selected neighborhood and one proof/sign operation.                                                                                                                | Constant rows/statements and logarithmic indexed blocks O(L) for one proof/sign operation. No session, verification or key-history scan. Bounded claims/ES256 CPU; no wall-clock growth gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `test/growth-session-proof-capability.test.ts`: “checkGrowth live proof signing uses constant native evidence at 1x/8x/64x; copies reject before I/O”                                                                                                                                                                                                                       |
| Scheduled maintenance                                          | One `auth_dbos` tick persists native wake/step outputs and invokes `session_expiry` admission b≤1000, signing singleton/live-slot retention CAS (≤3 slots, ≤1 retired key), and `verification_expiry_idx` admission ≤2000/deletion ≤1000. The indexed `auth_consent_erasure_due` gate conditionally adds one due-owner batch d≤100: user PK checks, each erased owner's entire consent PK range, one client advisory lock and exact pair DELETE per consent, then schedule deletion. Fix admitted b,d and c consents per due owner while unrelated/expired purpose and DBOS histories grow; separately vary c. No consent-client cap or drain of the due-owner backlog.                                                                                                                                                                                                                                                          | R=O(b+d(1+c)), B=O((b+d(1+c))L), Q=O(1+d(1+c)) plus a constant number of DBOS records. Consent work is linear in actual d×c, d≤100, rather than ≤1000 changes per kind. With b,d,c fixed: constant rows/statements, logarithmic blocks. Registration is constant work; backlog waits for later ticks.                                                                                                                                                                                                                                                                                                                                                                                | `test/growth-auth-schedules.test.ts`: “checkGrowth captures one fixed native durable tick as unrelated and expired purpose histories grow”. `test/growth-revoke-maintenance.test.ts`: “Maintenance tick with due consent erasure stays within its bound as consent and session history grows”                                                                               |
| Signing keys and JWKS                                          | Singleton generation + exact current/next/retiring kid seeks; sign/JWKS recheck generation. Imported material is cached at most 30s, refreshing generation changes immediately. At most three native ES256 keys; five-minute access/ID maximum + 600s recent-session logout hint + 30s verifier cache + 60s clock allowance retain keys for 990s. Auth-only `internal.signing` status/stage/rotate/prune use generation CAS and typed `signing_rotation_pending`; occupied slots throttle rotation. Retiring GC deletes one exact hot key, keeping immutable kid/material in cold archive. Upgrade requires stopped old binaries, renames legacy history without iterating K, and refuses startup for 690s when history exists before exact-key adoption. Grow history and unrelated Auth rows at 500 rows per scale unit; measure actual loading/signing/refreshed HTTP JWKS with native JOSE verification.                     | Hot R=O(1), B=O(L), Q=O(1), output/JOSE work ≤3 keys; no history iteration. Injection ≤3 exact identity seeks; rotation/GC change O(1) slot/generation rows (GC batch b=1). Constant rows/statements and logarithmic blocks in retained history.                                                                                                                                                                                                                                                                                                                                                                                                                                     | `test/growth-signing-retention.test.ts`: “signing loading and refreshed JWKS stay bounded as retired history and unrelated Auth rows grow”                                                                                                                                                                                                                                  |
| Native attempt rate limiter                                    | Installed Better Auth 1.8.0-beta.2 production native admission uses PostgreSQL customStorage.consume: one atomic upsert by auth_attempt_counter_pkey per charge, returning at most one row across service instances. Common 1x/8x/64x seed grows unrelated counter keys C, owners/credentials, clients with ready coverage, reductions, session/recovery history and expired verifications R; the subject's expired session neighborhood stays at its native cap of 64. Capture whole wrong-password (known/missing email), recovery-start and invalid-proof handlers through two fresh instances: three Origin rejections, twelve charges, shared 429 budgets, generic denials and unchanged epoch floor.                                                                                                                                                                                                                       | R=O(1), B=O(log C + log R) for the counter/client and expired-verification populations; Q=59 and 28 examined rows: 15 atomic consumes (12 native request budgets and three per-account mail cooldown checks) plus 44 other handler statements. Six transaction controls separately. Each request budget charge uses one upsert and returns at most one row. Sign-in failure/success: Q=7/15. Constant rows/statements and logarithmic blocks at fixed request count.                                                                                                                                                                                                                 | `test/growth-auth-rate.test.ts`: “checkGrowth measures whole own handler including empty bounded scans”                                                                                                                                                                                                                                                                     |
| Password sign-in                                               | Email: `user_email_key` SELECT + `account_userId_idx`/`credential_owner_unique` SELECT, at most one owner/credential; ID: one credential-owner seek. Native password verification, shared client barrier and exact coverage/reduction/consent probes precede establishment and `proof`. Session INSERT locks the owner and reads/evicts at most cap=64 oldest stored sessions, including expired rows. Grow unrelated A and S; fix owner, credential, client/scopes and own session neighborhood.                                                                                                                                                                                                                                                                                                                                                                                                                                | R=O(1+cap), B=O((1+cap)L), Q=O(1), cap=64; password work has fixed input size. Legacy owners must finish bounded upgrade pages before establishment. Constant rows/statements and logarithmic blocks at the fixed owner cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `test/growth-sessions.test.ts`: “Password sign-in stays within its bound as A grows”                                                                                                                                                                                                                                                                                        |
| Public-key sign-in                                             | One `auth_public_key_pkey(account_id,kid)` SELECT, local JOSE verification, one `auth_key_assertion_pkey(account_id,jti)` INSERT + user FK. Establishment reads one owner, checks client coverage/reduction/consent under the shared barrier, INSERTs one session with the cap=64 owner lock/oldest-row eviction, then runs `proof`. Grow A, S, P, J; fix owner/kid, assertion size, client/scopes, own sessions and one fresh JTI per attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | R=O(1+cap), B=O((1+cap)L), Q=O(1), cap=64; replay denial uses one key read and one conflicting INSERT. No assertion-history scan. Constant rows/statements and logarithmic blocks at the fixed owner cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `test/growth-sessions.test.ts`: “Public-key sign-in stays within its bound as J grows”                                                                                                                                                                                                                                                                                      |
| Auth barrier proofs                                            | Native session/consent point reads or native verification lookup and exact recovery consumption; one immutable purpose/account/operation receipt insert and point resolution, credential/consent CAS, and existing bounded session revocation. Digest binds the exact transition; no account/history scans. All new owner references lead with account_id in the unique index for erasure. Expiry index admits b+1 keys (one hasMore peek), locks/deletes at most b≤1000, with no drain loop. One seed grows same-owner proof/consent/recovery history and unrelated owners at 1x/8x/64x; valid/invalid requests and expired batch stay fixed.                                                                                                                                                                                                                                                                                   | Request: constant rows/statements and logarithmic O(L) blocks. Sweep: rows linear in admitted b≤1000, O(1+b), blocks O((1+b)L), Q=1. At fixed b, constant rows/statements and logarithmic blocks; locked prefixes remain bounded. Scheduling remains separate; expiry already denies.                                                                                                                                                                                                                                                                                                                                                                                                | `test/growth-barrier-proofs.test.ts`: “checkGrowth bounds actual ${kind} at 1x/8x/64x same-owner and unrelated history”                                                                                                                                                                                                                                                     |
| Clients and consent                                            | Issuance retains fixed client/coverage/gate/pair probes under the shared barrier; begin takes its exclusive counterpart. Durable gate, operation PK and `auth_consent_client_owner` keyset admit P≤100 affected owners plus one lookahead. Each owner changes one floor/receipt/cursor; fenced cleanup selects/deletes at most 100 sessions once per receipt (at most 64 for upgraded owners); retained legacy rows fail proof. Terminal completion uses exact seeks; DBOS pages hold ≤64 owners. Deployment backfill/drain stays separate. Default PostgreSQL plans and shared `checkGrowth` independently grow unrelated accounts/consents, client/operation/receipt/session history and affected owners at 1x/8x/64x, page P=8 fixed. Personal consent issuance is measured separately below.                                                                                                                                 | a=affected owners, P=min(100,a_remaining). Begin/completion O(L) blocks; page O(PL) blocks, O(P) actual changes and statements. Fixed P: constant rows/statements, logarithmic blocks. The unrelated-account P=8 owner page captures rows=11/11/11, Q=4/4/4 and B=9/9/9 at 1x/8x/64x. Full reduction visits the a matching owners, not unrelated A. Personal consent: see below.                                                                                                                                                                                                                                                                                                     | `test/growth-client-reduction-natural.test.ts`: “three scale native growth remains within derived affected-owner bound”                                                                                                                                                                                                                                                     |
| Personal consent issuance                                      | Same consent PK read gains a durable pending ceiling/reference; proof(reference) and receipt(receipt_id) use exact anchors. The source session resolves by primary key, and its owner is checked in the returned row. Publish proof+ceiling under the pair xact lock, release every Auth slot/client lock for one native Access call, then reacquire for revision/reference CAS and atomic receipt application. Cleanup ≤64 sessions. Signin, session creation/proof, token and live-proof issuance all check the ceiling, including after restart/expiry/GC. Shared captures include both transactions, pending issuance, live proofs and native Access barriers. Independently grow other owners, clients, same-owner other clients, pending rows and applied/expired proof history at 1x/8x/64x500; fix the selected pair.                                                                                                    | Constant rows/statements and logarithmic O(L) blocks at cap64. Two short transactions plus one external call; no owner/history fanout, global lock or planner/timing override.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `test/growth-consent-issuance.test.ts`: “checkGrowth captures complete native consent transactions, pending issuance, live proof and Access barriers at 1x/8x/64x500”                                                                                                                                                                                                       |
| Provisioning and owner creation                                | Exact receipt PK/account-unique seek and bounded native owner/credential reads; no stage/user-existence or hash scans. Trusted pending receipt metadata preserves registration/reservation, deadline and observed epoch; rechecked before commit/publication. One transaction writes owner, credential and immutable receipt; digest/locks preserve replay identity. Resolver/reference producer: one SELECT. Erasure seeks owner/credential referencing indexes; old unproven receipts remain. Shared seeds grow unrelated accounts, stale same-registration/reservation receipt/stage decoys and mismatched receipts referencing the same credential at 1x/8x/64x. Account-unique indexes forbid same-account receipt/stage history. Measure valid/absent/mismatched lookups, password/credentialless commits, replay and erasure; no timing or planner overrides.                                                             | Constant read/write rows/statements, logarithmic O(L) buffers; FK probes bounded. New evidence Q=9, replay Q=6 including BEGIN/COMMIT and proof read. Indexed proof erasure is linear in actual proof changes, O(kL) blocks, one DELETE.                                                                                                                                                                                                                                                                                                                                                                                                                                             | `test/growth-provisioning-evidence.test.ts`: “checkGrowth exact valid, absent and mismatched evidence ignores growing receipt/stage decoys”; “checkGrowth native idempotent password and credentialless commits have constant rows/statements”; “proof erasure uses referencing-key indexes as unrelated receipts grow”                                                     |
| Authorized account effects                                     | `consume`: human `proof` (twice for opening), constant subject/human Access checks and receipt validation, one `auth_effect_receipt_pkey` INSERT. `setCredential`: one indexed credential read, `owner`, one credential UPDATE or public-key INSERT/DELETE, optional bounded session revocation. `openAutomatedSession`: `owner`, client barrier/coverage/consent checks, capped native establishment and one `auth_session_opening_pkey`/receipt-unique INSERT + user FK. Grow A, P, E, O with human/subject, credential/client, receipt size and own sessions fixed. Destructive effects and establishment inherit cap=64; legacy owners fail closed until trimmed.                                                                                                                                                                                                                                                            | R=O(1+s), B=O((1+s)L), Q=O(1), s≤64 for destructive effects and establishment. Fixed cap gives constant rows/statements and logarithmic buffers; no global session-history scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `test/growth-sessions.test.ts`: “Authorized account effects stays within its bound as s grows”                                                                                                                                                                                                                                                                              |
| Credential stage/approve/apply                                 | Stage seeks `auth_credential_operation(account_id,operation_key)` or inserts one encrypted stage/receipt; `auth_credential_reference` resolves one effect. Approve verifies that stage and the selected credential version, then calls Access for exact approval. Apply locks the owner and stage, CAS-mutates one selected password/key row and commits one receipt result atomically with session revocation. Password replacement, remove-password and remove-key advance the Access floor and delete at most 64 sessions; add-key/first password do not. Replay revalidates current authority and returns the saved receipt result with replayed=true, without repeating mutation. Grow series=old-effects or unrelated-owners at 1x/8x/64x; fix the selected credential and destructive=false (add-key) or true (remove-key with 64 sessions).                                                                              | R=O(1+s), B=O((1+s)L), Q=O(1), s<=64. Unique stage/reference/receipt and credential keys bound each point read/write to <=1 row; the owner session cap bounds deletions. At fixed selected neighborhood: constant rows/statements, logarithmic blocks as E, A and P grow; trusted Access costs are separate.                                                                                                                                                                                                                                                                                                                                                                         | `test/growth-credential-effects.test.ts`: “credential effect growth stays fixed at 1x/8x/64x: ${series}, ${destructive ? 'remove-key with 64 sessions' : 'add-key'}”                                                                                                                                                                                                        |
| Account operation transport                                    | `/account-operations/approve` and `/execute`: bounded 16 KiB JSON, `withFreshHuman` native session/user proof and `accessTokenForProof` session/client/coverage/reduction/consent/signing seeks before native gate/approval resolution and workflow dispatch. Approval requires fresh authentication; execution uses `fresh:false`. Grow unrelated accounts and same-owner approval/workflow histories with one selected human, client, operation and fixed native authority neighborhood. The transport adds these reads even when dispatch is denied.                                                                                                                                                                                                                                                                                                                                                                          | Constant additional Auth rows/statements, logarithmic O(L) blocks for live proof and signing, plus the selected Access approval/gate and workflow operation costs. The native handler series includes those authorization/dispatch costs for the measured organization operation.                                                                                                                                                                                                                                                                                                                                                                                                    | `test/growth-account-operations.test.ts`: “Account operation transport stays within its bound as account and approval history grows”                                                                                                                                                                                                                                        |
| Session erasure                                                | Native INSERT checks the owner upgrade barrier and serializes the owner row, reads at most 64 stored keys (expired rows count) through `session_owner_oldest`, and evicts the oldest key atomically. Native revoke-all checks the same barrier, snapshots ≤64 and deletes via `session_userId_idx` under the owner lock. Credential/recovery/consent/erasure inherit this cap with Access first. Grow expired and unrelated histories independently; fix the selected owner neighborhood. Website token families use their own guards, not a session-history cascade. One-time legacy upgrade pages are deployment work, excluded here.                                                                                                                                                                                                                                                                                          | cap=64: rows O(cap), blocks O(cap L), Q=O(1). Constant rows/statements and logarithmic blocks at fixed cap, including native snapshots, triggers and deletion work. Legacy owners fail closed until upgrade pages complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `test/growth-bounded-sessions.test.ts`: “checkGrowth measures actual native insertion and revocation with independent expired and unrelated history”                                                                                                                                                                                                                        |
| Account erasure                                                | `eraseAccount` checks authoritative Access deleted/fenced state, then BEGIN, DELETE by `user_pkey` (native session-upgrade erasure trigger), one `auth_consent_erasure_pkey` INSERT ON CONFLICT with due time 310 seconds later, and COMMIT. Cascades seek credential/session, public-key/assertion, barrier-proof/recovery/establishment, provisioning and opening owner/reference indexes, plus any native owned client/passkey/protocol references. Let k count all matching cascade references, with ≤64 sessions for an upgraded owner. Personal consent has no account FK and is retained for delayed erasure. Grow unrelated owners/references with target k fixed; separately vary actual own fanout.                                                                                                                                                                                                                    | R=Θ(1+k), B=O((1+k)L), Q=4 including transaction control (two application statements). Linear in actual k; fixed k gives constant rows/statements and logarithmic blocks. Non-session fanouts remain uncapped. The cited cascade series includes own-fanout row assertions; its older Q=1 assertion predates consent scheduling.                                                                                                                                                                                                                                                                                                                                                     | `test/growth-erasure-indexes.test.ts`: “checkGrowth measures native eraseAccount cascades at 1x/8x/64x with fixed owner references”. `test/growth-consent-erasure.test.ts`: “consent erasure scheduling stays bounded as unrelated erasure rows and consents grow”                                                                                                          |
| Recovery start                                                 | One owner email unique read (`user_email_key`), one credential unique read, one native verification INSERT and one `auth_recovery_pkey(proof_hash)` INSERT + user FK; external delivery. The installed native `verification.create.after` hook captures the new verification PK, owner, token hash and original five-minute expiry in private live reset-call provenance. Failure deletes the newly inserted source proof by proof_hash, that verification by primary key (owner checked), and the per-account mail cooldown key so a failed send does not consume the mail budget; missing or mismatched provenance cannot mint/deliver a proof and never queries identifier history. `verification.disableCleanup:true` prevents request-time expiry sweeps. Grow unrelated and same-owner proofs plus duplicate identifier history at 500 rows per scale unit, 1x/8x/64x; fix selected owner, credential and failed delivery. | R=O(1), B=O(L), Q=O(1), independent of identifier/owner history m. Full failed-start native `checkGrowth`, including attempt admission and nested SQL: rows=7/7/7, statements=11/11/11, blocks=56/59/68. Cleanup is three exact-key statements (verification by primary key, auth_recovery by proof_hash, and the mail cooldown key), at most one row each; no history scan or Account floor change. Constant rows/statements and logarithmic indexed blocks in retained history.                                                                                                                                                                                                    | `test/growth-recovery-delivery.test.ts`: “checkGrowth captures full native failed recovery start at 1/8/64 with duplicate identifier and owner history”                                                                                                                                                                                                                     |
| Recovery completion                                            | Under a proof-specific advisory lock, seek/lock one `auth_recovery_pkey` binding and read one credential. Native latest lookup seeks one row through `verification_latest_idx(identifier,createdAt DESC,id DESC)`; request-time expiry cleanup is disabled. DELETE the exact verification PK with account/expiry checks, mark the binding consumed, publish/resolve one immutable barrier proof, then call Access to raise the epoch floor. A second transaction CAS-updates one credential, revokes at most 64 sessions and applies the proof/receipt. Grow other accounts’ and expired V at 500 rows per scale unit (1x/8x/64x); restore the same production-created proof, credential and session neighborhood between runs.                                                                                                                                                                                                  | R=O(1+s), B=O((1+s)L), Q=O(1), s≤64. At fixed owner neighborhood: constant rows/statements and logarithmic blocks as V grows. Exact native proof consumption does not erase identifier history or scan expired rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `test/growth-sessions.test.ts`: “Recovery completion stays within its bound as V grows”                                                                                                                                                                                                                                                                                     |
| Verification / expiry                                          | Native Better Auth 1.8.0-beta.2 find/consume uses the supported plugin-init/DBAdapter seam with its installed public Kysely adapter. Only the native identifier/createdAt-desc/limit-one request adds id-desc: `verification_latest_idx(identifier,createdAt DESC,id DESC)` seeks one row without sorting history. `verification.disableCleanup:true` prevents native request-time expiry cleanup. `internal.pruneExpiredVerifications()` uses `verification_expiry_idx(expiresAt,id)` to select at most 2000 ordered candidates, lock/delete at most B=1000 via SKIP LOCKED and exact TID keys in one statement. The native Auth maintenance schedule invokes one batch per tick; no request-time drain loop. Native token ownership, secrecy, expiry and one-use gates remain. Grow unrelated V, measured identifier history and expired rows together at 1x/8x/64x; B fixed.                                                  | Latest: R=1, blocks O(log V), Q=1. One expiry invocation: ≤2B candidates, ≤B deletes, R=O(B), blocks O(B log V), Q=1, including locked probes. Generic native identifier-wide invalidation remains proportional to matching history; recovery completion deletes one exact proof. Session revocation is capped at 64. At fixed B: constant rows/statements and logarithmic blocks; expiry work is linear in admitted B.                                                                                                                                                                                                                                                              | `test/growth-verification.test.ts`: “checkGrowth measures actual native latest queries at three scales of unrelated rows AND identifier history”; “checkGrowth measures one actual indexed expiry batch with fixed B=1000 at the same three scales”                                                                                                                         |
| Deleted-account consent erasure                                | Scheduling is the exact-key upsert in `eraseAccount` after user deletion. `hasDueConsentErasure` seeks the earliest due range. One `eraseDueConsents` transaction admits d≤100 due account keys through `auth_consent_erasure_due(due_at,account_id)` in the scheduled composition (the primitive accepts ≤1000). Each owner gets a `user_pkey` absence check, the complete account-leading `auth_consent_pkey` range ordered by client_id, a client advisory lock and pair DELETE per consent, and a schedule DELETE guarded by NOT EXISTS on the same range. A live owner only clears its stale schedule. Fix d,c while live/future schedules and unrelated consent history grow; separately vary c.                                                                                                                                                                                                                           | Scheduling adds constant rows/statements and logarithmic blocks. Erasure R=O(d(1+c)), B=O(d(1+c)L), Q=3+Σ(3+2c_i) for absent owners, including BEGIN/COMMIT/admission; linear in actual consent fanout, c_i≤c. No per-owner client cap. Fixed d,c gives constant rows/statements and logarithmic blocks, independent of live/future history.                                                                                                                                                                                                                                                                                                                                         | `test/growth-consent-erasure.test.ts`: “consent erasure scheduling stays bounded as unrelated erasure rows and consents grow”; “one fixed consent erasure batch stays bounded as live consent and future schedules grow”. `test/growth-revoke-maintenance.test.ts`: “Maintenance tick with due consent erasure stays within its bound as consent and session history grows” |
| Passkey sign-in and listing                                    | `/signin/passkey/options` creates one native verification challenge without an allow list; `/signin/passkey` consumes it, seeks `passkey_credentialid_idx`, updates one counter/last_used_at and uses capped session establishment/replacement. `GET /passkeys` adds human proof then the `passkey_userid_idx(userId,id)` range LIMIT 32. Fix selected credential, challenge, client/scopes, ≤32 own passkeys and ≤64 sessions; grow unrelated credentials and same-owner consumed effect receipts. Registration/removal use the separate row below.                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements and logarithmic O(L) blocks at fixed caps and request size. Listing examines ≤32 credentials; sign-in does not enumerate credential/effect history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `test/growth-passkeys.test.ts`: “passkey ${path} remains bounded as unrelated credentials and own consumed effects grow at 1x/8x/64x”                                                                                                                                                                                                                                       |
| Passkey registration and removal                               | `/passkeys/register/options` performs fresh human proof and native registration challenge/credential-exclusion reads. `/passkeys/register` consumes the challenge, seeks exact `(account_id,operation_key)` stage/replay and effect-reference indexes, then approves/applies one credential effect. `/passkeys/remove` stages the selected PK, revalidates last interactive credential, consumes the exact `workflow_approval_pkey(route,approval_id)` approval, advances the Access floor through `credential_floor_receipt_pkey(route,account_id,opening_receipt_id)` and deletes one passkey with ≤64 session revocations. Both Access points retain exact operation/effect binding and current-time approval validity. Installation checks the owner range LIMIT 32. Fix request bytes, owner, ≤32 passkeys and ≤64 sessions while unrelated credentials and own receipt/challenge history grow.                             | Required constant rows/statements and logarithmic O(L) blocks at fixed caps. The retained native attempt reported removal at 869/965/1061 rows and verified registration at 1036/1108/1180. Its full-key shared `core.receipt` read contributed 83/153/223 and 53/109/165 rows respectively; approval and floor receipt reads also grew. These results do not establish a current physical cause or successful bound. All six cases remain strict; full native acceptance is pending integration. Each invocation prepares a fresh native ceremony outside capture. Native challenge identifier-wide deletion is linear in duplicate matches; ordinary ceremonies have one identity. | `test/growth-passkeys.test.ts`: “passkey ${path} remains bounded as unrelated credentials and own receipts and challenges grow at 1x/8x/64x” (registration options, verified registration, registration replay, removal)                                                                                                                                                    |
| Exact current consent                                          | `createCurrentConsentReader.readCurrentConsent` uses one snapshot statement seeking `auth_consent_pkey(account_id,client_id)`, `auth_client_pkey`, `auth_client_coverage_pkey` and anti-seeking `auth_client_reduction_pkey`. Intersects stored consent, client ceiling and pending ceiling locally; each validated list has ≤100 scopes. Fix the exact pair and scopes; grow same-person other-client/history and unrelated rows. Invalid input does no I/O.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | R=O(1), B=O(L), Q=1: constant rows/statements, logarithmic blocks. Local set/filter/sort work follows the bounded scope lists; no consent refresh or history scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `test/growth-current-consent.test.ts`: “native exact consent cost stays fixed as unrelated and same-person other-client/history rows grow”; “durable consent point reader honors native pending reduction ceiling before Access floor and after lost acknowledgement, no extra statements or history scan”                                                                  |
| Consent and sessions GETs                                      | Both complete handlers include native human/session and Access proof. Consent GET adds exact client/coverage/reduction and consent-pair reads. Sessions GET reads the owner range using `session_owner_oldest` in reverse, filters expiry, orders newest first and returns ≤64, with ≤64 client-PK left-join probes. Fix owner neighborhood, selected consent/client and scopes; grow unrelated sessions, clients and consents separately. The native stored-session cap, including expired rows, bounds examined owner history.                                                                                                                                                                                                                                                                                                                                                                                                 | Consent: constant rows/statements, logarithmic O(L) blocks. Sessions: R=O(64), B=O(64L), Q=O(1) including proof; constant rows/statements and logarithmic blocks at the native cap. LIMIT alone would not bound expired owner history without that cap.                                                                                                                                                                                                                                                                                                                                                                                                                              | `test/growth-pages-reads.test.ts`: “consent read and sessions list stay bounded as unrelated ${axis} grow”                                                                                                                                                                                                                                                                  |
| Recovery-establishment evidence                                | `createRecoveryEstablishmentVerifier.resolve` anchors `auth_recovery_establishment_pkey(reference)` and lateral LIMIT 1 seeks of barrier reference, receipt PK, credential PK and recovery proof hash before owner/epoch predicates. Completion writes one establishment record in its credential/evidence transaction; expired barrier cleanup admits a fixed batch and cascades establishment by its unique reference. Fix selected account/proof/credential and cleanup limit; grow same-account consumed history and unrelated owners.                                                                                                                                                                                                                                                                                                                                                                                       | Resolve: constant rows, Q=1, logarithmic O(L) blocks. Complete: constant statements and rows at cap64; cleanup linear in admitted batch plus its unique establishment references, constant statements and logarithmic blocks at fixed batch.                                                                                                                                                                                                                                                                                                                                                                                                                                         | `test/growth-recovery-establishment.test.ts`: “native ${kind} remains bounded across same-account consumed history and unrelated owners”                                                                                                                                                                                                                                    |
| Session expiry pruning                                         | `pruneExpiredSessions` admits b≤1000 ordered `(expiresAt,id)` keys via `session_expiry`, then point-locks only those keys with SKIP LOCKED and deletes by session PK in one statement. No search beyond a locked admitted prefix. Fix b while expired/live session history grows; legacy trimming/discovery is one-time deployment work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | R=O(b), B=O(bL), Q=1. Linear in admitted b; constant rows/statements and logarithmic blocks at fixed b, including nested locks/deletes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `test/growth-bounded-sessions.test.ts`: “checkGrowth measures changing legacy history in separate bounded pages and indexed expiry batches”                                                                                                                                                                                                                                 |
| Website refresh rotation and replay                            | Form `/token` confidential admission reads the exact website client/reduction, verifies its bounded JWK set and consumes one assertion JTI. Refresh token hash seeks `oauthRefreshToken_token_key`; family PK guard, session PK, current owner/consent/Access proof and ≤3 signing slots precede native CAS rotation. Reuse revokes the exact family marker and advances the Access floor, with one recent-session upsert; no family token-history walk. Fix selected session, family, scopes and request bytes; grow same-family history and unrelated tokens.                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements and logarithmic O(L) blocks for rotation and replay invalidation, independent of retained tokens per family. The native handler series records rotation Q=28/R=30 and replay Q=18/R=16 at 1x/8x/64x. JWT/claims work uses fixed sizes; no promise of constant timing.                                                                                                                                                                                                                                                                                                                                                                                       | `test/growth-website-refresh.test.ts`: “checkGrowth keeps website refresh rotation constant as family history and unrelated tokens grow”; “checkGrowth keeps website refresh replay revocation constant without walking family history”                                                                                                                                     |
| Website protocol retention and durable sweep                   | `pruneExpiredProtocolState` runs five expiry-index statements: access tokens, refresh tokens, refresh families, client assertions and recent OIDC sessions. Each admits ≤2b candidates, locks/deletes ≤b≤1000 by TID, in dependency order. Optional `websiteMaintenanceModule` registers one maintenance-queue workflow with one replayable step; its native wake/dispatch/checkpoint persistence is included in the separate sweep capture. Fix b and durable step count; grow expired/live protocol and workflow history.                                                                                                                                                                                                                                                                                                                                                                                                      | Primitive Q=5, R=O(5b), B=O(5bL), linear in admitted b. Constant rows/statements and logarithmic blocks at fixed b, plus a constant number of durable workflow/step records for the registered sweep. No history-draining loop; module availability does not imply every host composes it.                                                                                                                                                                                                                                                                                                                                                                                           | `test/website-protocol-retention.test.ts`: “checkGrowth keeps one retention invocation constant in rows and statements as expired and live history grows”. `test/growth-revoke-maintenance.test.ts`: “Website maintenance sweep stays within its bound as protocol state history grows”                                                                                     |
| Auth workflow and request retention                            | SDK listing admits w≤1000 terminal workflows at a strict application/completion/creation cutoff and a sweep admits at most 60 batches. The default host retires each personal copy through its native result commitment/consumer, bounded exact artifact ledger, permanent SDK writer closure/deletion and raw absence probes. Missing, failed or live consumers stay pending. Only the two fixed technical maintenance workflows use direct SDK deletion. The request-retention trigger removes bindings by workflow PK inside native deletion.                                                                                                                                                                                                                                                                                                                                                                                 | Per personal artifact: ≤139 native rows/10 MiB under the writer caps, one fixed native result read and fixed raw-key verification statements, logarithmic indexed blocks. Total retirement follows admitted copies; it never derives readiness from age or terminal status. SDK listing retains its existing possible linear cost in an examined long-lived prefix before LIMIT; that retention admission cost is separate from the account-local exact erasure page.                                                                                                                                                                                                                | `test/growth-retention.test.ts`: “a full Auth retention batch stays constant as workflow and request history grow”; “a short Auth retention batch stays constant as workflow and request history grow”; `test/growth-erasure-history.test.ts`: “actual Auth copy creation, exact deletion and missing-custody proof stay bounded as unrelated native workflow history grows” |
| Website authorize, code exchange, revoke, logout and discovery | Authorize reads exact website client/reduction and native session/user/Access/consent proof, materializes one consent pair and writes one native verification code. Code exchange seeks latest code via `verification_latest_idx`, verifies confidential assertion/JTI and PKCE, rechecks exact session/client/consent and creates one refresh family/token plus signed claims. Revoke seeks refresh hash or verifies signed access, checks native client proof, upserts one recent session and advances the Access floor before native family revocation. Logout checks exact hinted/current/recent session and client redirect, then invalidates before session deletion. Cold discovery reads the exact client and ≤3 signing slots. Fix selected anchors, request scopes/bytes and admitted branch; grow client/session/grant/code/token-family history.                                                                     | Constant rows/statements and logarithmic O(L) blocks for the measured complete protocol branches, including cold metadata/signing. Family revocation marks one family rather than walking siblings; code identity is fresh and bounded. Generic duplicate-identifier verification deletion remains linear in matching rows.                                                                                                                                                                                                                                                                                                                                                          | `test/growth-protocol.test.ts`: “Authorize stays within its bound as client, session and grant history grows”; “Authorization code exchange stays within its bound as code and token family history grows”; “Token revocation and logout stay within their bound as token family and session history grows”                                                                 |
| Expired-registration release                                   | `expireDueRegistrations` reads pages of at most 64 due stages through the `auth_registration_stage_due` index, ordered and resumed by `(expires_at, registration_id)`, then seeks the partial automated-request registrationId index once per admitted registration. Each row sends both expiry messages or resumes its stored automated request, then performs the fixed expiry and release steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows and statements per admitted due registration; logarithmic blocks as finished stages, requests and workflow history grow. Total work follows the number of due registrations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `test/growth-registration-operator-workflows.test.ts`: “Auth expired registration release stays within its bound as stage, request and workflow history grows”                                                                                                                                                                                                              |
| Operator-session workflow composition                          | `openOperatorSession` resolves one native Access approval/opening receipt then immediately invokes Auth `openAutomatedSession`: human/session proof, exact receipt, subject/client/coverage/consent reads, ≤64-session establishment and one `auth_session_opening_pkey`/receipt-unique insert. Current production path does not enqueue a DBOS workflow. Fix one approval/operator/subject and capped session neighborhood; grow stage/request/workflow history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements and logarithmic O(L) blocks at fixed owner cap and approval neighborhood; no scan of retained opening/stage/workflow history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `test/growth-registration-operator-workflows.test.ts`: “Operator session workflows stay within their bound as stage, request and workflow history grows”                                                                                                                                                                                                                    |
| Human and automated registration workflows                     | Complete native Auth workflows stage by registration/request/account unique keys, persist one exact `auth_workflow_request` binding for automated creation, reserve/publish/activate through native Kernel Access, provision owner/credential/receipt and clear staging ciphertext. DBOS workflow IDs and step/event checkpoints are exact anchors. Fix registration input, selected human/operator and native binding neighborhoods; grow actual old human/automated stages, receipts and approvals, then replay the exact operations. Only implemented steps are counted.                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements and logarithmic indexed blocks across both Auth and Kernel for one human and one automated registration plus exact replay. Fixed password/input sizes and durable step count; no receipt/stage history traversal.                                                                                                                                                                                                                                                                                                                                                                                                                                           | `services/kernel/test/access/growth-native-account-bindings.test.ts`: “fixed native human and automated registrations and exact replay stay bounded as old receipts and stages grow”                                                                                                                                                                                        |
| Native workflow-proof ports                                    | `recordPending`, `pendingReference`, `recordAutomatedPending` and `automatedReference` seek/update the unique staging account with exact reservation predicates. `provisioningEvidence` joins the unique account stage/receipt and delegates exact receipt verification; `creationBinding` starts at registration PK with request-key/optional pair checks. Fix one selected pair and receipt; grow unrelated and old registration stages/receipts. These actual ports execute inside the cross-service registration series.                                                                                                                                                                                                                                                                                                                                                                                                     | Constant rows/statements per port (including delegated exact provisioning reads), logarithmic O(L) blocks. No JSON search, hash scan or stage/history traversal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `services/kernel/test/access/growth-native-account-bindings.test.ts`: “fixed native human and automated registrations and exact replay stay bounded as old receipts and stages grow”                                                                                                                                                                                        |

### Single-session revoke POST

- Touches: `/sessions/revoke` retains native human/session/Access and client/consent
  proof, then one exact `session_pkey` owner read for unknown/foreign concealment.
  The DELETE selects only `id=$1`; its scalar owner subquery separately reads that
  same primary key in the mutation's snapshot. Ownership is compared with the
  verified human, never request input or a cached owner. Native `(id,userId)`
  immutability preserves the guard through concurrent tuple rechecks; key reuse
  between statements is checked again. Concurrent disappearance remains a
  successful no-op after the initial owned lookup. Self-session cookie clearing
  stays local. Neither key operation admits an owner-history index predicate.
- Bound: fixed examined rows/statements/connections/output and O(L) indexed blocks,
  including all native nested work. At most one target is deleted; the mutation
  and its owner guard each examine at most one session row. No owner history or
  token-family traversal, including for pre-upgrade expired history beyond cap64.
- Growth check: `test/session-revoke-point.test.ts`, “native session revoke examines
  a fixed exact session neighborhood as the same owner expired and unrelated
  sessions grow at the original scales”, uses real native signin/proof, fresh
  physical targets after harness preparation, explicit spare warmups and every
  occurrence-linked native plan at 1/8/64. It preserves the 32-row handler ceiling,
  charges bytes/control work and applies measured-layout access-path checks.
  Native authority, concealment, current-cookie/proof and deterministic identity,
  expiry, disappearance and foreign key-reuse outcomes are in that same suite;
  `test/pages-consent-sessions.test.ts` retains the existing pages outcomes.

The scheduled consent bound is O(d×c) (often written O(B×C), B≤100 owners), with
no per-owner client cap. It bounds owner admission rather than consent changes;
the native due-tick series measures both retained-history and client-fanout axes.
Client reduction similarly follows affected consent owners rather than all accounts.
Account erasure retains personal consent for 310 seconds; delayed cleanup locks each
client and deletes all that erased owner's pairs, while live-account consent remains.

Signing/JWKS recheck the durable generation and ≤3 live slots on every call. Cold
archived keys are never enumerated; imported material refreshes immediately after
a generation change. Native verification's consume lock is process-local; recovery
uses a PostgreSQL proof lock, exact DELETE RETURNING and a durable consumed binding
for cross-instance replay. Assertion JTIs, effect/provisioning receipts, openings and
unconsumed recovery bindings have no scheduled retention; anchored operations remain
logarithmic in their totals. Barrier-proof expiry/cleanup and Auth workflow/request
retention are separate purposes.

The default host routes personal workflow retention through the same native
result consumer and exact copy retirement as account erasure. An expired or
terminal workflow with unknown custody, a live native consumer or no committed
result stays pending; retention time never supplies that missing proof. Only the
fixed technical maintenance workflows use direct SDK retention.

`Missing:` identifies implemented I/O with no matching native growth capture, and
is restricted to the explicit operation list in `test/cost-table.test.ts`.
Existing cascade-test statement assertions predate
the consent schedule; the current transaction bound above follows `eraseAccount`.

## Current private account identity

`POST /account-identity` with the closed JSON body `{}` returns exactly
`{ account_id, email }` for the current native human session. Every response,
including a refusal, is `private, no-store`. The request must carry the configured
issuer Origin, cannot be cross-site, and accepts neither a bearer Authorization
header nor account selectors, queries or extra fields. The ordinary service
handler supplies this read, so the default host composes it without another port
or Kernel permission.

The source is the installed Better Auth `user.email`, selected by the native
session's `userId` through `user`'s primary key. Native password provisioning stores
the login/recovery email there, while key-only owners can have null email. Native
`user.name` is synthetic or empty and is never projected. `emailVerified` is
independent: this display read makes no verification claim and does not expose
that flag. An absent address stays null; malformed native values fail unavailable.
There is no installed exact-current-account handle reader in this composition.

The service retains human/session, account floor, client coverage and current
consent admission, holds the existing native issuance guard, and rechecks the
same account, source session, client, scope, epoch, authentication time and methods
after the exact native read. Identity supplies display context only. `/session`
and all original approval, freshness, target-binding and mutation checks keep
their existing contracts.

Cost: one indexed exact-self `user` lookup, plus the existing constant native
session/client/consent checks before and after I/O. No enumeration, join across
homes, scans of account history, per-row requests or polling. Existing native
request body bounds and issuance guards apply. `test/account-identity.test.ts`
covers the closed projection, source semantics, privacy refusals and changes
while the native read is in flight; its execution is separate from typechecking.

## Ordinary native host assembly

The Auth application owns this assembly. Neither the membership worker nor the
pure `createNativeAccountBindings` factory constructs an Auth host or launches
DBOS. Migrate two separate databases first. Supply persistent reference, routing,
staging and signing keys from host configuration; keep Auth database credentials
and private keys out of the kernel worker. The host owns its Auth pools and
`auth_dbos` system schema; the caller retains the kernel pool.

This minimal assembly uses the production factories directly. Import paths are
relative to an application at the repository root. `actions` is the application's
existing action catalogue, including the actions its ordinary client requests.

```ts
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthHostOptions,
  type AuthService,
} from '@rezics/auth';
import type { Pool } from 'pg';
import { createAccess } from './services/kernel/src/access/index.ts';
import { createNativeAccountBindings } from './services/kernel/src/access/native-account-bindings.ts';
import { createAccountManagementReadAccess } from './services/kernel/src/access/management-source.ts';
import { createWorkflowApprovals } from './services/kernel/src/access/workflow-approvals.ts';
import type { LifecycleRequest } from './services/kernel/src/access/lifecycle.ts';
import type { ActionCatalogue } from './services/kernel/src/request/access.ts';
import type { KeyRing } from './services/kernel/src/tokens/seal.ts';

type Options = Omit<AuthHostOptions<LifecycleRequest>, 'database' | 'trustedAccess' | 'access'> & {
  kernelPool: Pool;
  authPool: Pool;
  actions: ActionCatalogue;
  routeKey: Uint8Array;
  referenceKeys: KeyRing;
};
export async function ordinaryHost(options: Options) {
  const { kernelPool, authPool, actions, routeKey, referenceKeys, ...auth } = options;
  let service: AuthService;
  const access = createAccess({
    actions,
    auth: {
      issuer: auth.issuer,
      audience: auth.audience,
      jwksUrl: `${auth.issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${auth.issuer}/.well-known/jwks.json`)),
    },
  });
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const approvals = createWorkflowApprovals({
    pool: kernelPool,
    access,
    actions,
    referenceKeys,
    creationBinding: proofs.creationBinding,
  });
  const bindings = createNativeAccountBindings({
    pool: kernelPool,
    access,
    actions,
    routeKey,
    referenceKeys,
    auth: () => service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
      barriers: createBarrierProofVerifier({ database: authPool }),
    },
  });
  const host = await createAuthHost({
    ...auth,
    database: authPool,
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    accountManagementReads: createAccountManagementReadAccess({ pool: kernelPool, access }),
  });
  service = host.service;
  const COMMANDS = {
    lifecycle: bindings.lifecycle,
    internalLifecycle: bindings.internalLifecycle,
    operators: bindings.operators,
    grants: bindings.grants,
    delegations: bindings.delegations,
  };
  await service.internal.registerClient({
    clientId: 'ordinary-import-client',
    firstParty: true,
    scopes: [
      'subject:create',
      'subject:batch_write',
      'source_fence:read',
      'media:import_from_url',
      'account:manage',
      'access:grant',
    ],
  });
  await host.start();
  return { host, access, approvals, COMMANDS };
}
```

Call `host.workflows.register({ key, handle, email, password })`, then use real
`POST /signin` and `POST /token` with that registered client. Access verifies the
ordinary API bearer with Auth's public JWKS. To create automation, obtain a native
`approvals.approve` reference for the exact initial descriptor
`{ kind: 'automated', registrationId: '', operatorAccountId, handle, operationKey,
authorization: 'approval-request' }`. Pass the same logical key, normalized handle,
operator and returned reference to `host.workflows.createAutomated`. Compose the
approval factory's optional `creationBinding` reader with the same Auth-owned
`createNativeWorkflowProofPorts` instance. A generated registration is admitted
only when that indexed reader proves its original descriptor and logical key.
Opening an operator session similarly requires an exact native `opening` approval;
`host.workflows.openOperatorSession` consumes the real opening capability, after
which `/token` issues a bearer whose subject is the automated account. Its public
operator marker comes from the actual native relation command.

`COMMANDS` exposes the composed native lifecycle, operator, grant and delegation
commands for private fixtures. Use these commands for setup and subsequent grants;
initial Global governance authority comes only from the bootstrap CLI. Ordinary
issuance itself needs no seeded Global grant. Client scopes confer no resource
grants. This assembly neither registers a website client nor grants its exclusive
`media:complete` scope.

Pending references are written only after the actual native command commits. A
crash before the Auth staging write replays that same command and stores its exact
receipt locator. The unique staging owner binds account and reservation immutably;
its deletion removes both pending references. Automated provisioning additionally
checks the original pending receipt, one exact relation receipt, current operator
and version, the immutable Auth stage and the current operator-management approval.
Ordinary person references keep their original transaction/provenance denials.
Auth's native provisioning receipt and owner/credential rows supply activation
evidence through exact unique-key reads; staging or user existence alone is never
a witness. The dedicated pending reader verifies the original epoch, registration,
reservation and expiry before forwarding receipt metadata to Auth. Public account
reads remain active-only.

Each protected step resolves a persisted native approval again, including cached
operation returns. Logical native command keys survive fresh approvals and process
restarts. DBOS stores nonsecret locators and outcomes; only encrypted Auth staging
contains registration credentials. Stop with `await host.stop()` before closing
the caller's kernel pool. Reuse the executor identity and persistent keys when
restarting the same host. An optional injected `systemDatabasePool` must belong to
the same Auth database and is also closed by the host.

The native suites use separate migrated databases, actual Auth routes and native
Access verification. Process-death tests interrupt pending-reference persistence,
credential provisioning, activation and operator-reference persistence. Growth
checks capture Auth, DBOS and kernel statements at 1x/8x/64x, including the bounded
receipt chain. Registration uses a fixed number of indexed independently anchored
steps, O(log R) per point operation, plus the existing bounded authorization formula
O((1+K)log G), K<=1000. No history search or cross-anchor held connection locates
proofs.

Recovery/credential workflow approvals, organization creation, responsibility
transfer, session revocation, operator fencing, consent and client management
remain separate adapter work and fail closed in the native approval adapter.
Ordinary native issuance does not establish the remaining whole-lifecycle,
permission or website/provider outcomes.

### Native current consent: usage, security and cost

`@rezics/auth/current-consent` exports
`createCurrentConsentReader({ database }).readCurrentConsent({ actorAccountId, clientId })`.
It reads one exact Auth-owned consent, intersected with the current registered
client ceiling. Missing consent/client/ready coverage or an active client
reduction returns null. First-party standing consent requires the native issuer's
actual materialized row; this reader performs no materialization or refresh.
Access epochs and caller timestamps do not replace this current fact.

`@rezics/auth/internal-consent` exports `createInternalConsentHandler` with the
Auth pool, `issuer`, `jwksUrl`, `audience` and `allowedServiceTokenIds` supplied
by trusted server configuration. Its only route is
`POST /internal/v1/consents:read` with exactly `{ actorAccountId, clientId }`.
Bind it on a separate private listener behind Cloudflare Tunnel, with no public
hostname, public Auth handler mount or diagnostic route. The JSDoc provides the
listener composition recipe; retain the pool in the existing Auth host.
This exact read is the narrow exception to the in-process internal-method rule
above; other internal effects remain in process.

Configure the existing kernel worker's service token in an Access Service Auth
policy. Verify `Cf-Access-Jwt-Assertion` against the configured Access JWKS,
issuer and sole application audience using RS256 and mandatory current expiry.
Cloudflare's [application token contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
defines service authentication by an empty subject and the Client ID in
`common_name`; the allowlist contains those Client IDs. Human subjects, provider
signing keys, cookies and bearer authorization cannot authorize this listener.
See also [JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
and [service token transport](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
Missing trust configuration fails startup. Runtime denial and unavailability are
sanitized, and every response is `private, no-store`. No credentials, emails,
other owners or history are selected or returned.

The same private listener can also serve the installed Auth Kind enrollment
participant at `POST /internal/v1/kind-consents:enroll`. Set
`AuthHostOptions.privateConsent` to the trusted Access `issuer`, `jwksUrl`,
`audience` and `allowedServiceTokenIds`. After `host.start()`, serve
`host.privateConsentHandler` on its own Tunnel-only listener; it is not mounted
on `host.handler` and returns 503 before host start or after shutdown. Host
start/stop gates the handler and owns the existing Auth pool and the one
`service.internal.kindConsentParticipant` instance. The listener does not make
a second participant or pool. Kernel keeps the exact JSON `{ input, deadline }`
and adds only the enrollment-specific `X-Rezics-Kind-Deadline` header with the
same original integer deadline. The header is resource/deadline input, never
service identity or admission authority. Auth reads and strictly parses it
before JWT verification or body I/O, requires canonical positive-integer text
and exact equality with the JSON number, and then fixes one cutoff at
`min(originalDeadline, arrival+3000ms)`. That cutoff bounds verification, body,
native pool checkout, transaction, response and rollback; there are no renewed
per-stage windows. Owned JWKS/body streams and the native connection are aborted
or cancelled at the cutoff. A detached raced promise is not used.

Enrollment request bodies stay bounded at 90,000 bytes for the 80,000-byte
canonical input; response bodies are bounded at 80,000 bytes. The JWT is limited
to 16,384 bytes, JWKS request to 4,096 bytes and streamed JWKS response to
65,536 bytes. Auth control input (URL, method and headers other than the
separately charged JWT), JWKS response headers and the fixed Auth response
headers share an 8,192-byte ceiling. The separate `/consents:read` route keeps
its existing fixed verification/body behavior and 16,384-byte body ceiling.

The canonical native Source bound is candidateKeys=1, nativeRows=2,
identityMetadataRows=0, emptySeeks=3, nativePoints=4, witnessKeys=3 and
statements=11; Access is keys=1, rows=2, emptySeeks=3, points=4 and witnesses=3.
Literal successful new enrollment uses BEGIN + timeout configuration + three
locks + frontier + current client/consent + existing consumer + INSERT + COMMIT
(10 statements). Duplicate enrollment stops before INSERT (9); closed-frontier
refusal stops after the frontier query (7); current-client refusal is 8. The
ceiling's 11 includes attempted COMMIT and ROLLBACK after a failure. A pool wait
executes no SQL. A failure or uncertain commit has no reusable actual charge,
so the caller retains its full reservation. The producer traces each literal
statement, lock, returned row, empty seek and JSON-serialized metadata result;
the native actual is tied to the exact input/result and can be consumed once.

For admitted input, `I = 128 + UTF8(accountId, clientId, route, ownerAccountId,
collectionId, preparationId, originId, requestedScopes)`. The native byte
ceiling is `I + max(2*JSON([])+JSON([currentRow])+JSON([insertRow]),
3*JSON([])+JSON([currentRow]),
JSON([])+JSON([currentRow])+JSON([existingRow]),
2*JSON([])+JSON([currentRefusalRow]), JSON([{ "?column?": 1 }]))`. Every
nonempty query result is the JSON array actually measured by `JSON.stringify(rows)`;
each empty query result is `JSON([])`. The current row maximum uses
`first_party=false`, `ready=true`, `reducing=false`, three maximum stored scope
arrays and the 19-digit signed-BIGINT revision ceiling. A current refusal uses
`first_party=false`, `ready=false`, `reducing=false`. The existing row maximum
uses `active=false`, two maximum stored scope arrays and a 36-byte UUID text
reference. The left-joined consent arrays and revision may be null; those
shorter forms are included by the array and 19-digit maxima. Each scope array
is bounded at 512 scopes of 128 ASCII bytes
(67,073 JSON bytes). A 1,024-byte visible identifier can be 1,024 backslashes,
which serializes as 2,050 JSON string bytes. The complete metadata-result path
maxima are 203,482 bytes for a new insert, 203,427 for a suppressed insert,
352,144 for a duplicate/inactive/refused consumer, 203,426 for a current
refusal and 16 for a closed frontier. Thus the maximum native result is
352,144 bytes before adding `I`; at maximum admitted identifier and scope
lengths, `I` is 72,832 bytes. This `max` accounts for mutually exclusive paths
without summing their rows. A suppressed `INSERT RETURNING` row is the
three-empty-result new path and commits an unavailable result.

Auth's verified actual adds the measured JWT, JWKS request/response and Auth
control bytes to the traced native work. Kernel's actual adds the measured
90,000-byte-bounded request body, 80,000-byte-bounded response body and
8,192-byte-bounded URL/method/explicit headers. Both Source and Access byte
reservations therefore add at most 272,400 transport/verifier bytes to the
native input-plus-metadata ceiling. Auth returns `{ result, work }` only when
the one-use native actual and measured verification work fit that declaration;
Kernel validates every axis and consumes its invocation-bound actual once.
Absent, malformed, late, dispatched-failure and repeated receipts leave the
full same-frame reservation spent; a retry uses the same consumer identity and
a new caller reservation. No parent allowance, ledger or child refund is added;
a consumer parent without this complete declaration remains unavailable.
This private transport does not implement Source invalidation/verification,
same-home adoption fences, restore recovery or consent-erasure receiving.

The Cost table derives the standalone exact current-consent reader and cites its
native growth series. The private listener adds one bounded HTTP request/response
per durable step; unauthorized requests execute zero SQL. No issuance, refresh,
mutation, delegation enumeration or consent cache participates.

## Website client

The website's backend-for-frontend (BFF) is the confidential, first-party OAuth
2.0 / OpenID Connect client `rezics-website`, exported as `WEBSITE_CLIENT_ID`. It
authenticates with `private_key_jwt` (ES256) and uses authorization code with
PKCE S256 and refresh-token rotation. A person's access, refresh and ID tokens
live only in the BFF's server-side session; the browser carries the website
session cookie and, briefly, an authorization code. The service mounts Better
Auth's official `@better-auth/oauth-provider` behind `service.handler`, with
native models mapped onto the existing single client registry (`auth_client`)
and consent authority (`auth_consent`). No second client store, consent store,
session system or grant engine exists.

### Registration and key rotation

Registration is a trusted, in-process deployment operation. There is no dynamic
or HTTP client registration:

```ts
await auth.internal.registerWebsiteClient({
  publicJwks: { keys: [websitePublicJwk] }, // public P-256 ES256 keys only
  redirectUris: ['https://rezics.com/auth/callback'],
  postLogoutRedirectUris: ['https://rezics.com/'],
  scopes: [
    'openid',
    'offline_access',
    ...[...mountedWebsiteActions].filter(([, action]) => !action.anonymous).map(([name]) => name),
  ],
});
```

`mountedWebsiteActions` is the trusted catalogue of mounted site features supplied
as `siteActions` when composing Auth. It includes `media:complete` and all mounted
protected site actions, including `account:read` with its self-revoking replay
formula and admitted `source_fence:read`, `source_fence:takedown` and
`media:import_from_url` features. Future mounted entries use this same data path.
Registration supplies no actor, principal or resource grant; a public-read floor
requires no scope. Production's configured audience, kernel `AUTH_AUDIENCE` and
the website's `resource` are exactly `https://api.rezics.com`, without a trailing
slash. Isolated tests use `https://api.rezics.test`.

- The website generates its private P-256 JWK and keeps it as a Worker secret.
  Deployment passes only `{ keys: [public JWK] }`. Each key needs a unique `kid`,
  `alg: "ES256"` and `use: "sig"`; private members, other curves or algorithms
  are refused. One to three keys may be registered.
- Redirect and post-logout URIs match exactly. Each list holds one to eight
  canonical absolute URIs without query, fragment or userinfo. A local
  deployment with an HTTP loopback issuer registers its own callback, for
  example `http://localhost:3000/auth/callback` and `http://localhost:3000/`.
  An HTTPS issuer refuses non-HTTPS redirects, so production has no loopback
  allowance.
- Scopes must include `openid`, `offline_access` and `media:complete`. When the
  composition supplies the trusted mounted action catalogue (`siteActions`),
  every other scope must be one of its actions. The deduplicated list is bounded
  by the known scope set described under client registration (1,000 entries
  without a mounted catalogue). Scope changes are additive;
  removing a scope is refused here and belongs to the client reduction workflow.
- The call is idempotent. It replaces keys and redirect lists, so rotate a key
  by registering both keys, switching the website, then registering the new key
  alone. It also writes the API resource row (the configured audience) and links
  the client to it.

`media:complete` is reserved for this client. Generic `registerClient` refuses
it and the `rezics-website` ID for every client, first party or not, and cookie,
key and operator issuance refuse both.

### Endpoints

All paths are relative to the configured issuer. These protocol routes are the
documented exceptions to the JSON and `Origin` rules of the public HTTP contract:
server-to-server OAuth calls send `application/x-www-form-urlencoded` bodies
without a browser `Origin`, and logout also accepts `GET`. Form bodies are at
most 16 KiB, every field may appear once, and unknown fields are refused.

| Method and path                            | Input / result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /.well-known/openid-configuration`    | Discovery: exact `issuer`; `/authorize`, `/token`, `/revoke`, `/logout` and `/.well-known/jwks.json`; `response_types_supported: ["code"]`; grants `authorization_code` and `refresh_token`; PKCE `S256`; `private_key_jwt` with ES256; `scopes_supported` from the registered client. Also served at `oauth-authorization-server`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /authorize`                           | `client_id`, exact `redirect_uri`, `response_type=code`, `state`, `code_challenge` (S256), `code_challenge_method=S256`, `resource` (the API audience), `scope` with `openid offline_access`, optional `nonce`, `prompt`, `max_age`. A signed-out browser is redirected to `/login` with the authorization query. A signed-in browser is redirected to `/step-up` with that query when the session does not satisfy `prompt=login` or when its `auth_time` is older than `max_age`. Resuming `/authorize` after a fresh sign-in, with that query minus `sig`, `exp` and `prompt`, issues a one-use code and `state` only to the validated URI. The ID token carries that session's `auth_time` and `amr`. Unrecognized query parameters are ignored; a repeated protocol parameter or a value longer than 8192 characters is refused |
| `POST /token`                              | `grant_type=authorization_code` with `code`, `redirect_uri`, `code_verifier`; or `grant_type=refresh_token` with `refresh_token` and an optional narrower `scope`. Both require `client_id`, `client_assertion_type`, `client_assertion` and `resource`. Failures return only an error code: 400 `invalid_request` for malformed requests, 401 `invalid_client` for failed client authentication, 400 `invalid_grant` for refused grants, and 400 `unsupported_grant_type`, `invalid_scope` or `invalid_target` for their respective checks. Internal or unavailable dependencies return 503 `temporarily_unavailable`. Every response is `no-store`. JSON bodies keep the existing cookie `/token` route                                                                                                                            |
| `POST /revoke`                             | RFC 7009 `token` and optional `token_type_hint`, with the same client authentication and `resource`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET` or `POST /logout`, `/logout/confirm` | OpenID Connect RP-Initiated Logout 1.0: `id_token_hint`, `client_id`, `post_logout_redirect_uri`, `state`. No client key is needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /login`                               | Login entry for the browser: sign in through `POST /signin` with the registered `login` client, then resume `/authorize`. A signed-in session that must authenticate again is sent to `/step-up` instead of `/login`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Client assertions are ES256 JWTs signed with a registered `kid`, with
`iss = sub = rezics-website`, `aud` exactly the configured issuer identifier (not
the token endpoint URL), `iat` not in the future, a lifetime of at most 120
seconds and a nonempty `jti` of at most 128 characters. The native provider
records each `jti` once, so a replayed assertion fails across processes and
restarts.

A successful token response is `{ access_token, token_type: "Bearer",
expires_in: 300, refresh_token, id_token, scope }`. The access token is the
existing five-minute API JWT (`typ: at+jwt`, `aud` the API audience): `sub` is
the authenticated person, `client_id` is `rezics-website`, and `authn_epoch`,
`auth_time` and `amr` come from the authenticated session. The ID token has
`aud: rezics-website`, the same `sub`, `auth_time`, `nonce` when sent and a
session-bound `sid`; it carries no profile or email, and the API verifier refuses
it as an access token. The refresh token is opaque and stored only as a hash.

Every code redemption and refresh rechecks the current Access state, epoch and
fence, the native session, the registered client scopes and consent; missing or
unavailable evidence denies. A refresh cannot add scopes, change client, subject
or audience, or outlive its session. Token failures follow the mapping above;
other website paths return HTTP 400 `invalid_request` for refusals and HTTP 503
`temporarily_unavailable` for internal failures. Responses never echo tokens,
codes or assertions or add error details.

Revocation and logout run the Access-first invalidation port before reporting
success, so JWTs minted earlier fail kernel's next anchored account read. Logout
keeps ten minutes of non-authenticating recent-session evidence so an expired
`id_token_hint` for a recently ended session is still accepted, then ends the
real Better Auth session and clears its cookie.

Limitations: only the authorization code and refresh token grants exist; there
is no implicit, client credentials, token exchange or dynamic registration.
`refreshTokenReuseInterval` is zero, so a refresh retried after a lost response
counts as reuse and revokes its family. Access tokens are JWTs, so revocation
relies on the Access floor rather than on token rows.

### Refresh families (provider patch)

`patches/@better-auth%2Foauth-provider@1.8.0-beta.3.patch`, registered in the root
`patchedDependencies`, fixes a provider defect: reuse detection did not
linearize with rotation. A rotation revoked its parent, then inserted the child
in a separate write. A concurrent replay, even in another process, deleted the
client/user refresh history (a request-time scan) between those writes, and the
child stayed usable. The patch header names the defect; drop the patch once
upstream ships an equivalent fix.

With the patch, each authorization grant has one `oauthRefreshFamily` row keyed
by the code's stored identifier, which every rotated token carries as
`authorizationCodeId`. The code grant creates the family before consuming the
code. Rotation locks the family row and performs the parent compare-and-swap
and child insert in one transaction on the bound native adapter. Only adapter
calls run inside it, so hooks and signing never hold its connection. The
refresh grant re-reads the presented token under the same lock before issuance
work, so a replay that races a rotation waits and is classified as reuse. Reuse,
a lost compare-and-swap, code replay and revocation revoke the family
permanently by exact key (RFC 9700 section 4.14.2); token rows stay
authoritative and expire lazily. The website layer refuses a revoked family
before native work and, when its request revokes a family, also runs Access
invalidation with reason `refresh-replay`.

```sh
bun run --cwd services/auth scripts/probe-native-refresh.ts
```

The probe owns a disposable database through `testDatabase`, registers the
client through `registerWebsiteClient` and runs the native provider in two
processes with `pool.max=1` over loopback HTTP. It pauses one rotation just
before its child insert, replays the parent from the other process, resumes the
rotation, restarts the replay process and presents the child. It requires the
child to fail: it passes with the patch and fails on the unpatched provider,
where the child refresh returns HTTP 200. `--observe-native` instead asserts
that race. The probe prints only statuses and counts.

The Cost table records complete website refresh/replay work and its native growth
series alongside the other protocol handlers. Session logout does not enumerate
token history: the provider's optional front/back-channel notification hooks are omitted because this sole native client
has no such delivery registered. Native RP logout still deletes the actual session
and expires its cookie. Access-first deletion raises the floor, and native token
admission requires the same live session; expired physical rows wait for retention.

`internal.pruneExpiredProtocolState(batch)` removes at most one batch (1 through
1000, default 1000) of expired access tokens, refresh tokens, refresh families,
client assertions and recent logout evidence per invocation. Removing a family
never revives a token, because the provider refuses tokens of a missing family.
The Cost table derives expiry-index admission and distinguishes the primitive
from the registered durable sweep, with a native growth citation for each.
Register `websiteMaintenanceModule` from `@rezics/auth/website-maintenance` with
the existing kernel worker. It registers one durable step and one minute schedule
on the existing `maintenance` queue, with no backfill and no second SDK launch:

```ts
import { websiteMaintenanceModule } from '@rezics/auth/website-maintenance';

const work = await composeWork([...KERNEL_WORK_MODULES, websiteMaintenanceModule(auth.internal)], workerOptions);
await work.launch(); // the existing single kernel worker owns launch/shutdown
```

The trusted port invokes Auth's primitive in its existing process/pool; it is
never a public endpoint. Each activation handles one batch per kind and yields
remaining history to later ticks. Only counts enter DBOS, and failures are
sanitized. `website-maintenance.test.ts` exercises actual dispatch through kernel
composition, with an isolated migrated database and real DBOS storage.

`website-client.test.ts` covers discovery, registration, code, PKCE, refresh
rotation and replay with two people. `website-logout.test.ts` covers revocation
and RP-initiated logout: refused cross-person, hintless, forged and
unregistered-redirect requests, then a matching hint that ends the real session.

`website-security.test.ts` additionally exercises hostile registration and
assertions, independent PKCE and client proof failures, restart-safe JTI replay,
missing consent and Access outages, concurrent code/refresh reuse, rotation with
revocation, code redemption with logout, native browser confirmation and expired
recent-session hints, including `pool.max=1`. RFC 7009 revocation of an API JWT
uses the same native confidential proof admission, then the existing Access floor;
the adapter reports success only after that floor commits.

## Workflow history retention

The Auth host refuses startup unless `AUTH_WORKFLOW_RETENTION_DAYS` is a whole
number from 7 through 365; absence defaults to 30 days. Auth maintenance registers
`auth.workflowRetention.every-10-minutes` (`*/10 * * * *`, UTC, no backfill) on its
existing single-concurrency maintenance queue. It operates only on application
`rezics-auth-accounts` in `auth_dbos`, without launching another executor.

Each run fixes one cutoff and deletes at most 60 batches of 1000 terminal
workflows (`SUCCESS`, `ERROR`, `CANCELLED`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED`).
Both `completedBefore` and `endTime` receive cutoff minus one millisecond because
the SDK comparisons are inclusive. Running work and work completed exactly at
or after the cutoff remain. Input/output payloads and child enumeration are
excluded. After DBOS creates its system schema, the host installs a delete
trigger: each deleted status removes its `auth_workflow_request` binding by
primary key inside the same SDK transaction. A failure rolls both back; retries
cannot strand bindings. Product migrations define the trigger function without
requiring the DBOS schema to exist during migration.

The Cost table records the full/short native batch series and its fixed-batch,
retained-child and long-lived-workflow qualifications.

### Erasure cursor deployment

Quiesce Auth issuers and account workers before applying the ordinal migration.
Run `AUTH_DATABASE_URL=… bun services/auth/src/erasure-cursor-cutover.ts` from the repository root until
it returns `done: true`. Each committed page writes at most 99 native keys plus
one checkpoint, or translates one cursor through indexed predecessor lookups.
The singleton `auth_erasure_cursor_cutover.completed_at` is the durable completion
marker required by subsequent erasure drains. An empty installation records it
in the migration. Restarting the deployment step resumes its last checkpoint.

Start the ordinal writer and worker version together after completion. Native
writes refuse an incomplete deployment; legacy cursor columns are renamed and
cleared as their rows translate, and legacy worker completion is refused.
Legacy DBOS reduction pages are refused before owner effects; a versioned,
deduplicated replacement resumes from the acknowledged ordinal saved at cutover,
including after executor restarts. User and consent-owner ordinals are sequence values on their native rows, indexed
with their actual owner keys. Deleting a native row removes that binding; no
separate identity mapping survives it. Retained consent has its own ordinal
because consent can outlive the user until its delayed drain completes.

### Workflow ID reuse audit

Retention removes execution history, not native command receipts or approval
expiry checks. Reusing an old ID does not restore an expired authorization:

- `accounts.registration`: the original native handle reservation and pending
  commands replay their receipts with their original deadline. Provisioning and
  activation enforce that deadline. Expiry requires the matching pending account;
  a completed active account fails that check before Auth erasure. An already
  expired registration replays expiry/release receipts and idempotent erasure.
- `accounts.client-reduction`, including `:page:` continuation IDs: the original
  approval expires within 300 seconds. Native progress is keyed by operation ID,
  records its cursor and completion, and refuses changed inputs. Owner barriers
  and cleanup receipts also retain their original keys.
- `accounts.operation`: automated registration, organization creation, rename,
  membership changes, operator transfer, deletion, operator fencing, consent and
  authorized session revocation revalidate native approvals (at most 300 seconds)
  before effects. Native commands use the approval's stable command prefix and
  retained receipts. Delete/revoke continuations require the exact native
  allowlisted operation and independently expire within 300 seconds; they cannot
  be recreated by workflow ID alone. Historical
  callback-only unapproved revoke paths use `wf:<ID>:<phase>` native keys;
  production bindings refuse unapproved operations.
  Operator session opening and transfer acceptance do not start a DBOS workflow.
- `accounts.membership`: the shared registrar reauthorizes reserve and new publication;
  native authorization expires independently of DBOS history. Every positive Realm operation reserves a fresh
  generation, including role confirmation and rejoin. Its registered publication step first recovers an exact
  committed source proof mechanically, without needing a lost bearer or publishing again. Registered `finalize`
  consumes proof after publication; compensation commits `cancel` before finalization, then uses the original
  `terminalize` and `release` steps and receipt keys for authoritative inverse removal. Realm work refuses missing
  protocol wiring. These steps use `wf:<ID>:<phase>` native keys and bind the original input. Stable inverse
  reservation and generation have separate lifetimes; replay cannot spend a later generation. Ordinary leave,
  organization and operator authorization/order remain unchanged. Terminal release carries the exact reservation
  and terminal proof. This registrar runs in the composing caller's executor; Auth retention never visits kernel's
  system schema/application. Access documents the migration and stopped-old-writer reconciliation barrier.
  Cost: constant durable steps and point commands per operation; native rows/blocks/connections/output, including
  nested DBOS and proof work, are measured at 64/512/4096 in the kernel's Realm transition growth acceptance.
- `auth.maintenance.tick`, `auth.workflowRetention`, and the separately composed
  `accounts.website-protocol-expiry` schedule intentionally repeat bounded,
  idempotent pruning primitives. Signing pruning uses its generation compare and
  swap. Reusing a scheduled ID only performs another bounded maintenance pass.

Fresh approvals for the same actor and logical operation retain the same native
command prefix. The permanent native approval-binding receipt refuses changed
business input or principal assignment. DBOS history retention therefore does
not discard the effect authority or allow a second effect for that logical key.

## Source diagnostic emission

`src/diagnostics.ts` owns the nonpersonal source allowlist adopted by
[external custody](src/external-custody-contract.md#source-admission-and-actual-receiving-lifecycle).
Each output is exactly `{ code, operation, severity }`, with closed primitive enums.
Membership step failures use `membership_<step>_failed` and `membership.<step>`
for the static steps `reserve`, `publish`, `terminalize`, `release`, `finalize`
and `cancel`. Recovery start failure uses `recovery_start_failed` / `recovery.start`.
Invalid untyped emitter inputs use `diagnostic_input_rejected` / `diagnostics`.
No error message, stack, cause, SQL parameters, identifiers, request context or
credentials enter these outputs. The membership wrapper retains its existing
thrown step error, disabled retries and compensation/denial ordering; HTTP and
recovery error responses retain their existing behavior.

The actual Better Auth instance inherits `BetterAuthOptions.logger.log` from
`betterAuthOptions`: native logger calls project to `better_auth_diagnostic` /
`better_auth`, retaining the existing warn threshold. The Auth workflow host
sets `DBOSConfig.logger` and its copy writer's `DBOSClient.create({ logger })`
to the same source policy: `dbos_diagnostic` / `workflow_runtime`. Each delegated
SDK call emits once at its native `debug`, `info`, `warn` or `error` severity.
DBOS custom loggers receive all levels regardless of `logLevel`; this adapter
retains those calls, including error counts, and ignores every message/metadata
argument. No console interception or external receiver is installed.

These hooks close only their actual delegated emission paths. The pinned Better
Auth core's `createAdapterFactory` export (`@better-auth/core/db/adapter`,
`dist/db/adapter/factory.mjs`) still directly calls `console.error(error)` on a
fallback-join failure and `console.log(stack)` on an unapproved supplied create
ID. Neither uses `options.logger`; debug-adapter logging also constructs its own
logger. The shared-runtime/Better Auth integration owner must route those actual
calls through the existing instance logger. The core's `@better-auth/core/env`
module logger also falls back to its default logger outside endpoint context;
Auth's instance configuration cannot certify that foreign fallback. Browser
client diagnostics are outside this server source closure.

DBOS's installed `DBOSConfig.logger` and `DBOSClient.create` cover their delegated
runtime and database diagnostics (including migration warnings). Optional
`TelemetryCollector` / `TelemetryExporter` direct console emissions and the
`ConfiguredInstance` decorator warning bypass that hook; the shared-runtime/DBOS
owner must supply equivalent source routing there if used. Foreign hosts that
register Auth membership steps own their DBOS configuration and must compose
the logger policy on their existing instance. Auth does not replace their runtime.

Old or external diagnostic copies, collectors, rotations, archives, exports,
replicas and backup erasure remain unknown/pending with their receiving owners.
This source change adopts no retention exception, copy-erasure certificate or
Auth participant acknowledgement. Durable native workflow error/result custody
remains governed separately by the existing erasure contracts.

## Native metadata privacy contract

[Native metadata privacy and creation custody](src/metadata-privacy-contract.md) owns the adopted field
classification, whole-field legacy disposition, exact proposed personal-party columns, producer/consumer
retirement, indexed native bounds and source-interface handoff for client contacts, client/resource metadata
and private creation records. It is a specification with native boundary evidence, not a delivered personal
metadata API. Generic registration and website registration remain mechanical trusted configuration writers.
New personal metadata stays closed until its source-approved subject/context and shared-copy custody are adopted.
A recorded owner never proves absence of other people; JSON, address, handle and ciphertext searches cannot
supply attribution. Unknown creation/release witnesses remain pending until their actual source consumers retire.

### Historical configuration disposition

`internal.scrubMetadataConfiguration(store)` implements the adopted whole-field disposition for
`auth_client`, `oauthResource` and `oauthClientResource`. Each native maintenance tick runs one separately
committed page per store, through separate count-only DBOS steps. A page admits two raw primary keys, reserving
the rest of the 48-key ceiling for existing old/new erasure and native role guards, exact-row inspection and
the deployment checkpoint. SQL returns keys and presence booleans only; it never returns or parses historical
JSON, addresses, handles, labels or claims. Locators are bounded to 1 KiB and returned control data to 64 KiB.
An oversized key returns `locator-too-large` without its bytes and holds that store's boundary. Other stores
continue independently. Native fence and writer-version refusals stay pending through their existing owners.

`auth_metadata_scrub` stores only store, writer version and the last committed raw key. Empty tails wrap to
revisit pending rows after source replacement. Payload changes and the boundary commit or roll back together;
there is no ready bit, completion flag, coverage certificate or participant acknowledgement. Clean rows avoid
rewrites. This deployment pass neither discovers people nor infers ownership from a linked client.

The client pass removes contacts, arbitrary metadata outside the sole native website consumer, provider
name/URI/icon/terms/policy, software identifiers/versions/statements and unproven `display_name`. Resource and
link metadata are removed independently, including resources shared by living clients. Unproven resource names
become the inert empty string; resources are never deleted by this operation. IDs, ownership, first-party and
scope ceilings, redirect/logout URLs, JWKS and other protocol-authority fields remain under their existing commands.
Legacy provider `referenceId` stays precisely pending because this slice has no source command retiring that
authority. Native website metadata and resource `customClaims` also stay pending rather than changing token
authorization through a maintenance write.

The website admission read blocks historical metadata, provider references and custom resource claims before
the provider consumes them. The existing `registerWebsiteClient` transaction replaces metadata/claims for its
actual configured audience and reasserts the real `REZICS API` constant alongside its existing validated keys,
scopes and exact callback configuration. A failed replacement rolls back all of those fields. Unknown resources
remain independently pending; registering one audience never certifies any other resource or historical copy.

Native configuration triggers suppress new unsupported free-field writes, including raw provider/import SQL.
They preserve existing consumer-used inputs until the actual source replaces them. Unsupported replacement
claims, references and metadata are never adopted; clearing a consumer-used value requires its actual source
command. Presence checks and assignment preserve opaque originals without JSON comparison or traversal. No
personal metadata producer is enabled. The trusted deployment `registerClient` command supplies the actual
application label, never a `safe` assertion; callers must supply application constants without person-derived
interpolation. Its transaction binds the exact configured client and label to field-specific writer provenance.
Website resource provenance similarly binds the exact resource and service constant. Copying a label or setting
the provenance column directly supplies no provenance. Exact `create-or-match` replay still preserves the existing
row. Client/session/inventory reads withhold historical unproven labels before the scrub reaches them.

`test/metadata-config-scrub.test.ts` covers previous-schema historical rows, whole-field disposal, independent
shared resources, resumable rollback, bounded raw locators, native writer guards and actual website replacement.
Shared/provider archives and histories still require their own supported disposition and custody. None of these
native pages proves final erasure, closes the personal-contact/source gap or supplies Auth participant completion.

## Native erasure and custody

The existing deletion operation accepts a durable `auth_erasure` obligation after
its trusted deleted/fenced account read. The original account and epoch floor,
applicability, phase and independent raw-key cursor live in the Auth database,
outside DBOS. The recovered `erase-auth-owner` step joins the same obligation.
Default maintenance redrives one unfinished native page without a session or a
fresh approval. No production Auth module imports the kernel.

Every native page requires the deployed ordinal v2 completion marker. A page
selects at most 48 keys, returns at most 1 KiB per key, and checkpoints with its
mutations. An owned client is selected and fenced under its existing lock;
subsequent pages hold only that client lock. Access tokens, attributed protocol
rows, refresh tokens/families, sessions, operating openings, recovery proofs and
establishments, effect receipts, provisioning receipts, credentials, assertions,
registration stages, coverage, reduction progress and client resources drain
before their parents. Native DELETE guards independently refuse user/client
cascades through remaining children. Authorized surviving password credentials
and unrelated clients are retained.

Producer-side typed columns associate reset/WebAuthn/OAuth verification, refresh
families, website client assertions, operating sessions/tokens and native stages.
These are written in the artifact's native transaction.
Provisioning receipts inherit creator/operator roles from their uniquely bound
native registration stage in the credential transaction, and retain that stage's
release witness until activation or release is terminal. Native workflow producers
pass the actual stage key; a locked point read refuses provisioning if erasure has
already removed that stage. Native account and client
fences reject late issuance, recovery and reduction writes; minimal client replay
fences survive metadata deletion. Verified-account recovery counters keep exact
native HMAC-key associations, including retired secret generations. Anonymous
transport counters are never assigned by IP address.

User deletion writes the original `clock_timestamp() + 310 seconds` consent
cutoff once. Website access/ID token lifetime is 300 seconds; the native signing
and verifier limits accept no additional leeway. The extra ten seconds therefore
covers the composed maximum. Retries retain the original cutoff. Each due page
selects one account and one client, takes that client's lock, removes its consent,
and checkpoints on the same transaction. Only actual residue absence removes the
marker and persists completion, including the final page. Live-user stale markers
are discarded without changing live consent. Sleep holds no connection.

Native request rows have typed subject/human/operator/client/stage locators. The
default deletion caller and maintenance scheduler compose the same native consumer
continuation. Its held key and pending reason checkpoint before the Auth connection
is released; foreign source commands finish before another connection is acquired.
Neither a session nor a renewed approval supplies mechanical release authority.
Confirmed deletion first commits its permanent Auth obligation, then finishes the
original source responsibility releases and deleted-handle redirect under that
same committed continuation before waiting on native Auth pages. A registration's
source deadline can outlive the continuation; waiting does not renew its authority
or postpone those already authorized source consumers.
The pinned SDK's workflow patch preserves the old step order for existing
histories. An old continuation that already expired before its source release
remains refused; this path never restores its former authority.

- Registration records its original workflow/activation keys before source work,
  and its actual operator reservation when that command returns. Erasure removes
  ciphertext and credential digest while retaining this release witness. A lost
  activation reply consumes the private `OriginalLifecycleResultPort` reader's
  actual committed result without invoking activation or transient provisioning
  evidence. The exact original stage, provisioning receipt, reservation and
  activation key form its `OriginalLifecycleRequest`. Auth releases its checkout
  before the reader, then independently reacquires its erasure/obligation and
  stage/receipt locks and compares the original bindings before recording the
  existing terminal activation proof from the returned outcome. The producer's
  native transaction, epoch and position describe the original source command;
  Auth's consumption commits in a separate transaction. Otherwise the
  existing source expiry command decides whether its original thirty-minute
  deadline is due. Only actual expiry, handle release, operator retirement/release
  and child Auth obligation acceptance establish release completion. Full native
  proof retains those exact reservation bindings and returned results until the
  LAST original stage, provisioning receipt and workflow request is deleted.
  Stage deletion alone does not retire the request's exact binding reader.
  Indexed final-reader checks run in each deletion transaction, including the
  ordinary SDK request-retention trigger. Expired proof then retains only its
  existing `(store,key)`, JSON `binding: null` and `result: {outcome: 'expired'}`.
  Permanent original native expiry/release commands and operator slots still
  refuse old writes; no new stage, receipt or request can reuse that proof key.
  Existing exact-key request/receipt replay may finish while its original row
  remains. The minimal skeleton supplies no authorization or source outcome.
  Unknown source/release/responsibility returns retain the original witness and
  the existing `native-stage`/`native-release` pending branch, never a success.
  Completed/expired timestamps alone cannot close a registration consumer.
  Activation drops its handle, reservation and operator links after the same
  final-reader boundary, retaining only `[registrationId, workflowId,
  activationKey, accountId]` and the exact actual activation result. The original
  result reader remains usable after transient provisioning evidence expires,
  without renewing its deadline or supplying caller disclosure/session authority.
  Missing, imported, minimized or mismatched originals remain
  `native-stage`/`native-release`; the actual current account state never
  reconstructs an activation result. The retained
  actual result must not be nulled to pretend that missing reader is delivered.
- Credential consumers lock the actual receipt under the existing permanent
  account/client fence. A real committed CAS result is retained with its original
  operation, effect reference, digest, subject, floor and opening receipt. An
  uncommitted effect receives a terminal refusal only while that permanent fence
  excludes every later credential writer. Proof, physical witness removal and
  checkpoint share the same transaction. A source identity fence prevents receipt
  reuse after cleanup. Credential application takes the client/role admissions
  before its source-row lock, matching erasure's producer order. Surviving
  credentials are never reapplied or removed on behalf of an erased client owner.
- Recovery consumes a lost committed result through the producer's
  `readRecoveryResult(reference)` composition and actual private original-result
  port. The producer derives the original operation key from Auth's establishment;
  Auth independently compares the account, receipt, establishment and floor with
  that returned outcome. Both lifecycle consumers validate the original native
  partition, epoch, position and transaction ID before recording a proof. No
  checkout spans the foreign read. Recovery reacquires the same erasure obligation
  lock as activation, then locks and compares its exact six-field establishment
  binding, original Auth floor and receipt. Its existing terminal proof records
  `{outcome: 'released', sourceResult: original.outcome.value}` in the consumer's
  separate transaction, without invoking `completeRecovery` or reading current
  account state as proof. A missing, imported, minimized or mismatched original
  retains the establishment and `native-release` pending state even after account
  deletion. Only a still-active fenced source may use the ordinary live completion
  port, which keeps its existing authenticated establishment and expiry checks.
  No source lifetime or user/session disclosure authority is renewed. This supplies
  no retention exception for creation descriptors, request JSON, handles or
  approval business payload.
- Reduction retains the original operation, delivered ordinal page and count of
  acknowledged owners. The permanent erased-client obligation admits only that
  existing gate. Continuation uses each original page/owner source key, its actual
  barrier and the existing bounded session cleanup/completion primitives. The
  source floor invalidates remaining sessions; the native page eagerly removes at
  most one. Native finish and request terminality commit together. A disappeared
  delivered owner without acknowledgement leaves a precise count gap pending.

Credential proof is one point operation per raw receipt, with the original page
transaction and checkpoint. Other consumer pages admit one outer locator within
the 48-key budget, reserving space for its proof, indexed final-reader checks and
nested continuation work, including reduction's existing eight-row ordinal batch.
Ordinary pages also reserve child and client seeks. Only one held consumer is
continued per page. Locators stay within 1 KiB each and 64 KiB total;
there is no workflow-history search or account-map fanout. The native consumer
growth acceptance measures proof, trigger work, cleanup, transaction and checkpoint
at 256, 1024 and 4096 unrelated stages, effects and native request histories with
constant rows/statements/output and logarithmic blocks using the shared harness.
The real source-expiry acceptance waits for Access's actual deadline; it never
backdates source state or removes a responsibility hold to make deletion eligible.

### Remaining producer and composition gaps

This composition has **no terminal Auth erasure acknowledgement**. Its final state
remains pending, including after native work and the original consent cutoff:

- Kernel shared-history still needs its own producer/minimizer closure after
  consuming the separate Auth-local completion fact described below. No shared
  global ACK is awaited by either Auth phase.
- Historical opaque protocol rows and historical role fields lack a deployment
  proof when their original typed source custody is unavailable. The native role
  deployment below classifies supported sources; opaque/null or ambiguous old
  attribution stays unknown. Ordinal v2 completion alone is never role coverage.
- Client contacts, arbitrary resource/client metadata and legacy request or encrypted creation bindings still
  lack runtime complete person attribution. The [metadata privacy contract](src/metadata-privacy-contract.md)
  adopts their exact field disposition and minimal native proposal: bounded typed contacts, source-projected
  actor/human/operator/principal/client roles, whole-field legacy scrub and real consumer retirement. Source
  context projection, contact-subject approval and shared-copy recorder interfaces are explicitly missing;
  no shared type/export or personal writer is claimed delivered. Ownership is never inferred from JSON,
  addresses, handles or ciphertext.
- Client contacts, arbitrary resource/client metadata and legacy request or
  encrypted creation bindings do not have complete typed person attribution.
  Ownership is never inferred by searching JSON, handles, email or network address.
  Shared workflow delegated-principal roles now come from the resolved native
  assignment through `copyActors`, before enqueue.
- A stalled registration on a surviving subject can still require its native
  release consumer's stage witness. That lifecycle must supply a terminal proof
  before the witness can be removed; history deletion is not such a proof.
- An unfinished credential-effect witness for a surviving subject remains pending
  when an associated account or client is erased. Its native consumer must supply
  a terminal-refusal proof; a missing user or shared-history deletion cannot
  substitute for that proof.
- Unknown historical registration bindings, lost operator-reservation identities,
  unresolved delivered reduction owners and unknown native requests remain pending.
  Their surviving release witnesses are not discarded or called complete.
- Ordinary live activation/recovery still resolve their current Auth evidence
  before command replay. Mechanical erasure consumers separately use the private
  original-result reader described above for genuine lost committed results.
  An absent original result or source capability retains the exact stage,
  provisioning or establishment witness; elapsed time, current account state and
  workflow terminal status cannot reconstruct that result or authorize a new effect.
- External delivery-provider diagnostics/logs and backup restore deletion replay
  are specified by the [external custody and restore contract](src/external-custody-contract.md).
  Its source inventory, owner allocation, admission, proof and rollout are adopted;
  native Access point/feed discovery and durable live consumption now bind
  restored Auth import and isolated reconciliation as described above. Actual
  receiving adapters and independent physical isolated-restore readiness remain
  open. Native acceptance is deferred until integration; fixture callbacks do
  not establish provider deletion or restore safety.

The native marker deliberately has no `erased`, `none` or acknowledged outcome.
A missing native user cannot change persisted applicability to `none`. These gaps
are implementation/integration findings, not a new specification or a claim that
elapsed credential lifetime completes erasure.

### Native role producer deployment

The existing `auth_copy_coverage.native_covered` field is the native role coverage
authority. `erasure-coverage.ts` inventories 27 native stores: user and client;
opening, session, verification, refresh family/token, access token and assertion;
recent OIDC session, barrier and recovery establishment; registration stage and
provisioning receipt; credential account, passkey, recovery and effect receipt;
workflow request, public key, key assertion, account-attempt association, consent,
client reduction/progress/coverage and client resource. Signing keys, public
resource definitions and anonymous transport buckets are system data; a verified
account's counter uses its exact `auth_attempt_account` association. Permanent
erasure/copy/consumer progress retains its existing technical replay contracts.

The Auth-owned pool installs producer version 1 on each checked-out connection,
before composing the signer, issuer or workflows. Release resets the version
before making the socket reusable. Deployment locks the fixed native store set
in one order, drains in-flight writers and commits a permanent armed fence. An
old writer, including a transaction/lease queued before that cut, cannot insert,
update or delete native records afterward. Migration and startup retain unknown
custody for old rows removed before classification. Restart uses the committed
deployment checkpoint; it does not infer coverage from a newly empty table.
Old producers lock the admission row without waiting, so a pre-cut repeatable-read
snapshot fails serialization instead of admitting a writer through stale state.
A fresh installation closes under that same drained and armed cut. SDK nested
request cleanup is admitted only for its exact ready, retired native copy.

Default native redrive reconciles one store per transaction, four tuple locators
per page, reserving space for exact source/fence reads within the 48-key and
64-KiB budget. Partial indexes select only unclassified rows. Classification and
the store checkpoint commit together; retry does not retain a personal traversal
cursor. Known direct typed account records and reset/WebAuthn verification
attribution are resolvable without decoding old payloads. Session/opening,
verification/family, proof/establishment and stage/receipt associations use only
their existing exact native source keys. Missing sources and historical client
ownership without a captured owner remain unknown: today's client owner cannot
prove yesterday's owner and is never installed as its historical role. Missing
sources preserve every existing positive typed role. Historical stage/request bindings without the complete
source actor projection also remain unknown. Store/reason markers persist after
expiry or physical removal; there is no historical JSON or identity search.

Producing transactions snapshot client-owner and source-client-owner separately
from subject, acting human and operator. Copied source roles retain the source's
snapshot when its client moves. Approved stage/request producers additionally
commit initiator and delegated-principal roles from the actual `copyActors`
projection; provisioning receipts inherit them from their exact stage. A foreign
host without that projection, or provisioning without an original native stage,
remains usable with unknown coverage. These paths do not gain a new authority
capability. New native reset, WebAuthn and authorization-code formats are labelled
at creation; only the pinned anonymous discoverable WebAuthn challenge's explicit
empty account field has a known account-free shape. Historical null is unknown.

The existing native erasure phases consume these role-first indexed columns;
surviving subjects keep unrelated credentials and clients. Request roles drain
after user deletion so the original deletion consumer can finish. Native phase
completion means known native work drained; complete inventory/local-copy proof
still requires the coverage authority. Known copy retirement proceeds even while
unknown coverage or proof publication is pending. Default recovery needs neither
the original caller nor final participant acknowledgement. Consent retains its
original 310-second cutoff. Version-zero role coverage keeps its existing historical
recovery. Later phase inventories preserve completed old phases instead of
restarting them; older completion markers cannot publish all-role proof.
Raw client/contact metadata, foreign committed-result
recovery, external sinks and universal shared history retain the separate gaps
and owner contracts above; this deployment does not claim a terminal Auth ACK.

### Native phase inventory upgrade

`erasure-role-upgrade.ts` freezes the deployed inventory: phase 0 owns client
traversal, subject phases 1–75 have literal store/role identities, 76–78 drain
key assertions, public keys and counters, and 79–87 drain original request roles.
Its 22 client subphases retain their original raw keys and ordering. Phase 88
was the old native EOF. The closed adapter maps every old cursor identically,
including an in-flight client and raw boundary; old EOF now starts appended
coverage. Unknown versions, out-of-inventory phases and oversized boundaries
refuse. `native_phase_version` versions interpretation, not custody evidence.

One ordinary native page upgrades its obligation and checkpoints its source
probes or actual work in the same transaction. No account list or bulk cursor rewrite is needed. The
permanent obligation retains applicability, barrier/T, source handoff, committed
user deletion and the original consent deadline. A completed old obligation is
scheduled only for missing inventory; neither its completed phases nor its
original tail timestamps are reset. Restore replay uses the same literal phase
interpretation and independently checks that its current tail finished.

The migration drains native writers and installs database-enforced page/producer
version guards. The Auth-owned pool tags each new lease with both the original
role-producer version and the phase-producer version and resets both on release.
An old lease in another pool/process remains refused after activation. Deployment
EOF, an empty native table and an older `native_completed_at` cannot supply a
current native or shared-copy completion proof.

Native phase inventory 3 preserves all 89 saved v1 identities and the 22 client
store subphases. Inventory 2 remains separately defined: positions 88/89 were
unavailable creation/request placeholders and 90 was done. They are never
interpreted as inventory 3 role seeks. A v2 placeholder or done marker resumes at
the first missing creation boundary with an empty new raw boundary; its original
cursor is retained in immutable `auth_erasure.native_phase_upgrade`. A v1 EOF
also starts its new role at an empty seek boundary while retaining that saved
EOF evidence; the identity adapter itself preserves the old cursor. Earlier
positions, raw keys, client boundaries, applicability, barrier, T, user deletion
and the original consent deadline remain unchanged. Old completion markers cannot
certify these additional roles.

`NATIVE_CREATION_PARTY_PRODUCERS` in the original `creation-party-context.ts`
module binds the actual `createStage` projection and its exact provisioning copy.
Positions 88–93 drain stage actor, human, native opening operator, principal,
target-client owner and source-client owner; 94–99 drain the corresponding
receipt roles. These remain distinct from creator, target operator, initiator,
delegate and subject in the saved inventory. The original version-1 creation
guard validates source bindings, snapshots owners under client locks and refuses
historical refill. The generic no-stage provisioning ABI stays version zero and
records permanent missing-source custody. That original path supplies the
missing-coverage restart case without manufacturing a source witness.

`NATIVE_REQUEST_PARTY_PRODUCER` in the original `workflow-request-parties.ts`
writer binds actor/principal at 100/101; done is 102. Consent keeps client
position 22, request source-client is 23, and stage/receipt target/source-client
seeks occupy 24–27. All use the existing leading-role indexes and native consumer
retirement. The empty-client guard checks every added child. Current requests
carry party/context/actor version 1; the original historical version-zero ABI
remains pending and invalidates coverage instead of acquiring inferred roles.
The existing native request terminal reader also recognizes a fully versioned
non-stage operation only after `finishCopyResult` commits its exact native return
digest and `completeCopy` consumes that return. A terminal timestamp or SDK status
alone remains insufficient. Registration still requires its exact activation or
expiry proof. Producer registration supplies no completion, receiving claim or ACK.

No v2 cursor independently proves the new creation roles drained. Its request or
done position can reach the first request phase only after the native deployment
is drained, actual creation guards report no unknown source custody, and twelve
bounded leading-role seeks prove the account's new creation ranges empty under
its fence. That upgrade uses a separate ordinary page within the same budget.
Otherwise it starts the first actual creation phase. Original placeholder raw
boundaries are never used to seek a new role. Unknown creation custody stays at
the first missing boundary when no known creation row can advance; known rows
still use the ordinary native drains. A current fully classified deployment can
advance normally. Neither old done nor deployment EOF alone certifies it.

Native role seeks project bounded raw locators only, take the same client locks,
and reserve guard/child/checkpoint work within the 48-key/64-KiB page. Nested
consumer stores admit one locator; ordinary pages shrink with their declared
child/client guard seeks. Oversized counter locators also stay pending. No
payload search, owner-population walk or enlarged nested page is introduced.

### Native shared-copy custody and proof publication

`erasure-copy.ts` installs an Auth-owned recorder on the pinned SDK's real
`auth_dbos` tables after native schema compatibility probes. Transactional
`DBOSClient.enqueueInTransaction`/`sendInTransaction` commit exact work, complete
typed account roles and actual copies together. Registration and account workflows
include operating-human, initiator, operator, member, previous operator, delegate
and client-owner roles supplied by native inputs/approval context. Client-reduction
pages keep transient owner IDs inside their native step and carry independent
ordinal boundaries; child creation records its exact parent and native progress
locator. The last actual native consumer records an exact, bounded result
commitment in `auth_copy_work` outside DBOS, atomically with the native operation
terminal marker. Registration and reduction verify their original native source
keys, bound atomically with the actual SDK copy at creation, before recording it.
Native source cleanup cannot remove that exact handoff identity.
`completeCopy(database, workflowId, result?)` consumes the actual SDK return and
compares it with that commitment. Caller consumption precedes private disclosure,
so a lawful disclosure denial cannot strand native retirement. Default history
recovery invokes the same consumer for a lost caller, without a caller retry or
reopening an approval/session. SDK SUCCESS only guards a nonblocking result read;
a missing commitment, failed/live return, mismatch or unmapped copy stays pending.
No private result or exception is retained in the native commitment.

An execution has at most 139 native rows and 10 MiB: three status/input/output
rows, 60 operation rows, eight event keys, 64 event-history rows and four messages.
A status is at most 4 KiB; another artifact is at most 64 KiB including SDK
bookkeeping. The recorder refuses undeclared streams, incomplete roles and budget
overflow before the native write. Erasure uses eight exact locator keys per page
and one execution per minimization unit. `sdk-retirement-fence.ts` binds the SDK
owner's actual `DBOS.retireWorkflow(workflowID)` and
`DBOS.getWorkflowWriterFence(workflowID)` in this same Auth runtime and database.
Its receipt type comes directly from the installed SDK's original
`WorkflowWriterFence` export. Missing methods, native migration/coverage, malformed
receipts or any generation other than the producer's closed generation `2` stay pending before
request retirement or physical deletion. Method presence alone proves no closure.

`eraseCopy` first locks the original copy generation, exact roles and native source
mapping. Its producer commitment and actual caller/recovery result consumption must
already exist; live or historically unclassified request consumers remain pending.
The Auth parent continuation link stays unchanged across retirement; transactional
`DBOSClient` enqueue does not stamp that link into the SDK's native parent column.
An original erasure-source workflow additionally requires its exact applicable
obligation's accepted, discharged and published source facts. Deadlines, SDK status
and current account state cannot supply these facts. The native obligation retains
its original floor, kernel version/time and continuation/receipt identities.

The SDK retirement body joins all native writers, including old executors, and
revokes their execution token without cancellation. Auth releases its recorder lock
before that supported call, whose transaction also touches the recorder, then
reacquires it and revalidates the same original custody and bounded artifacts.
The returned `{workflowID,generation,closureID,closedAt}` must exactly match a genuine
native reread. Auth persists only generation, closure UUID and closure timestamp
beside the existing workflow ID in `auth_copy_work`, atomically with local retirement
and before request minimization. These fields and the original source key, result
commitment and result-finished timestamp are immutable. No payload, error, stack or
data hash is stored as fence evidence.

Only then does supported `deleteWorkflows([workflowID], false)` remove history.
Every existing exact physical family probe must be empty, and a post-delete native
reread must still match, before `absent` is recorded. Cancellation after closure
would itself be a forbidden writer and is never attempted. Lost replies resume
from the same permanent native receipt, including after physical deduplication
deletion. The SDK owns its guards, permanent control identity and backup custody;
Auth adds no SDK SQL or second maintenance runtime. Default history and retention
use this same primitive and retain precise pending codes in receiving progress.
Unknown old copies or native rows preceding the creation cut remain pending;
no scan attempts to infer their account roles. Native/source proof, final Auth or
shared-history participation, root completion and external backups remain independent.

The focused native binding cases are in `test/sdk-retirement-binding.test.ts`.
They require producer-first package integration and deferred native execution;
source registration and local typing establish neither native coverage nor Goal
completion. `test/sdk-retirement-fence.test.ts` requires eligible, genuinely consumed
registration retirement and exact receipt persistence across physical deletion and
idempotent retry. Unknown mapping and living histories remain pending and present;
genuinely missing capability still refuses retirement.

`AuthService.internal.consumeAccountErasure(accountId, receiptId, workflowId)` is
called by the actual `erase-auth-owner` step, in its SDK context, after the real
committed continuation authorization. The native obligation writer commits source acceptance atomically with its
obligation/progress under the producer fence, separately from the final validated
native transfer. Acceptance alone emits no witness and
blocks native cleanup. The native transfer preserves the original kernel
version/T and continuation/receipt identity in the existing `auth_erasure` root;
exact replays do not reopen the discharged source dependency.

The default maintenance host independently redrives the early native-consumed
witness and later local-copy completion through `TrustedAccessPorts`:
`readAuthErasureBarrier`, `readAuthErasureSource`,
`recordAuthNativeConsumption`, `recordAuthHistoryCompletion`. A missing capability
is unavailable/pending. Publication failure leaves the permanent phase pending
for default redrive and does not abort the other already-authorized source
releases. Final completion additionally requires the kernel's matching earlier
native-consumed fact. Pending-registration expiry retains separate native
cleanup semantics and emits no active-account barrier proof. Explicit older
separate-store workflow hosts retain their SDK behavior but have no Auth-local
coverage cut or completion proof.

The kernel sees only the immutable technical tuples through the fixed Auth-only
binding. Auth imports shared types from `@rezics/auth-contract`, never kernel
runtime modules or a kernel pool. Local completion and submission progress live
outside DBOS, so final purge, executor loss and lost replies cannot erase them.
Neither proof phase is an Auth/shared-history participant ACK. Kernel's own
producer/minimizer closure remains necessary; Search cleanup remains undelivered.

## Selected organization member command state

`POST /account-management/organizations/member` accepts only
`{ organizationId, memberAccountId }` and returns only
`{ organizationId, memberAccountId, membership: null | { role: 'owner' | 'member', reservationId: string } }`.
The selection is not authority. This private no-store read uses a current human
session with the exact management `organization:membership` profile, strict Origin
and JSON/CSRF checks, and the native membership mutation formula on that exact
organization. It neither requests `account:read` nor changes the generic management
list's separate `account:read`/`account:manage` privacy policy.

The closed native declaration lives in
`services/kernel/src/access/management-membership-source.ts`:
`readOrganizationMembershipCommandState({ pool, access, clock? }, actor, selection, { deadline })`.
`createManagementMembershipAccess` supplies the trusted Auth port
`readOrganizationMembershipCommandState({ human, organizationId, memberAccountId, deadline })`;
the default native bindings append it to `trustedAccess`, and the default Auth host
consumes it there. Auth's signer and native Access bind the live proof; an absent
port returns 503. The point returns the reservation actually installed by the current
native role transaction and verifies its exact member-side coordination provenance.
An incomplete or failed source is unavailable, never null membership. No holder
enumeration, private profile, operator reservation or synthetic version is returned.

Selected-member actions capture this current reservation before constructing their
immutable descriptor and operation key. Reauthentication requires another submit;
retries retain the descriptor/key, and native acknowledgement remains separate
from fresh selected-member readback. Existing native ownership, last-holder,
reservation and command CAS checks remain final authority.

## Selected automated creation operator

`POST /account-management/automated/operator` accepts exactly `{ operatorAccountId }`
and returns exactly `{ id, kind: 'actor' | 'organization', handle, displayName }`
or null. This same-origin JSON, private no-store command-precondition read uses
`withFreshHuman` and the exact management `account:manage` profile (the existing
local transfer-profile alias). Its local `AutomatedOperatorAccess` port is
`readAutomatedCreationOperator({ human, operatorAccountId, deadline })`; the
native binding authenticates the actual Auth-signed live proof. Missing native
composition answers 503. Selection and returned labels are never approval or
creation authority. The existing credentialless native creation writer, fresh
approval/execute checks and shared opening profile remain unchanged.

### Native creation parties

New registration stages bind the preselected account, normalized handle, original
request and source context before encrypting credentials. Automated creation uses
only the trusted optional `workflowPorts.readNativeCreationContext` runtime port;
`creation-party-context.ts` consumes the original producer types exported by
`@rezics/auth-contract`. Missing producer, historical provenance and
unavailable opening provenance produce distinct unavailable reasons. Approval
resolution remains the authorization boundary at its existing source timing.

`creation_context` stores the exact native projection, including original approval,
operation key/digest, command prefix and permission target. Independent indexed
actor, human, principal, target-client and source-client columns preserve its roles.
`erasure_native_operator_id` records the source operator relation independently of
`erasure_operator_id`, which continues to identify the creation's target operator.
Existing creator, initiator and delegate attribution still comes from `nativeActors`
and `copyActors`; it is not reconstructed from the new projection. Client-owner
snapshots come from locked native client rows. No contact writer, ordinary session,
permission or client expansion is introduced.

Public human self-registration has a native preselected subject and credential
binding but no authenticated approval actor, opening human/operator, delegated
principal or producer client. Those approval roles are inapplicable and null.
A separate source version distinguishes this from historical missing provenance.
The new request binding participates in AES-GCM AAD and the credential HMAC. Old
AAD remains unchanged; old rows are never decrypted or backfilled to discover roles
and cannot receive new encrypted credentials or native provisioning receipts.

Provisioning locks the exact stage before writing either credential model. Its
receipt copies all source roles and scope from that same row in the credential
transaction, for both password and credentialless automation. Native triggers
reject immutable-source drift and admit every known role/client through existing
erasure fences. The historical generic provisioning adapter with no native stage
remains explicitly unknown, without a fabricated native source or complete role
claim. Unknown old custody stays pending. Attribution never certifies consumer
retirement; original release, activation, reservation and provisioning identities
and deadlines remain authoritative. Phase-inventory upgrades and terminal-proof
minimization are separate owner integrations.

## Organization deletion review

`POST /account-management/organizations/deletion-review` accepts exactly `{ organizationId }`, with the issuer
Origin and existing JSON/CSRF bounds, no bearer or query. The default host consumes `readOrganizationForDeletion`
from the native trusted bindings. Auth's live cookie proof retains exactly the account-operation client's
`account:delete` profile; the same proof is revalidated after native I/O. Review permits an older authentication
so approval can request its existing fresh step-up; review neither approves nor executes a command.

The private producer reuses the native management account/role source and `readManagedAuthActions` deletion ENTRY
formula, without the generic endpoint's `account:read` scope, public attribution, or member inventory. It compares
native identity, lifecycle, human floor, role and home epochs after released permission preparation. Only the
selected organization identity and the server-bound initiating human reach the browser. Approval and execution
retain their independent current checks, original command/key and uncertainty recovery.

Decision: unrelated organizations return hidden, missing/inactive sources return missing, current authority refusals
return denied, and failed or changing native reads return unavailable; none discloses an organization identity.
The page uses its existing localized denial text for hidden results. Cost is two bounded two-account snapshots,
two role points, native management ENTRY preparation/checks, and constant Auth session checks; no inventory or polling.
