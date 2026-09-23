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
returns 503 when it cannot reach the configured dataset. `POST /v1/works` is
the first authenticated product command. It accepts the fixed
`metadata-only-v1` profile, a title and an acting subject with an Account bearer
token and `Idempotency-Key`. The Account issuer must match discovery exactly.
The Access database must have migrations 001 and 002 plus an admitted principal,
subject, representation, grant and `work:create:root` gate. The graph control
record must have the matching data and routing epochs. Startup does not create
or migrate authority state. The route has one Work profile and one scope; wider
deployment still requires the remaining revocation and recovery qualification.

The primitive validates a complete small Work/MainVersion candidate with the
[fixed profile](../../model/README.md), stages content-addressed immutable payloads
and manifests, then sends one conditional update through Fuseki's text wrapper.
The update writes current heads, revision anchors, an operation receipt, sequence
and outbox batch together. It looks up its own receipt after the update, including
after an ambiguous response. An unmatched guard stays pending; it is never treated
as success merely because Fuseki accepted the SPARQL request.

The [Access admission migration](migrations/access/001_admission.sql),
[claim/seal migration](migrations/access/002_claim_and_seal.sql) and
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
token to create and replay a Work, then checks sign-out denial on replay.
The tested scope is Work creation only. Grant mutation commands, restart/restore
reconciliation and the wider claim/strong-revocation profiles remain required
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
Account/Access/Main/Fuseki HTTP path. A 202 response carries an opaque operation
reference and instructs callers to retry the identical request and key. There
is no operation-read endpoint yet. Success carries public Work/MainVersion
references and source position; Problem Details omit private IDs.

The [Access test evidence](tests/evidence/2026-09-24-access-admission.xml) records
the local PostgreSQL register/replay/deny/closure checks, including competing
registration/closure and claim/strong-closure orders. It qualifies only the
first one-scope gate behavior;
the complete IAM07 and IAM10 outcomes remain pending.

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
