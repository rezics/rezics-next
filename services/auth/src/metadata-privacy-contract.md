# Native Auth metadata privacy and creation custody

This is the Auth-owned source contract for client contacts, client/resource free fields and private creation
records. [Accounts](../../../docs/accounts.md) owns account policy and [deletion](../../../docs/deletion.md) owns T,
all-role erasure, shared-copy custody and allowed skeletons. This document adopts the disposition and proposes the
minimal native changes below. It does **not** add a runtime API or claim producer coverage, an Auth acknowledgement
or shared-type adoption. The current source lacks the ports called out in the availability table.

## Job and boundary

A person can be a client owner, contact subject, creator, acting human, operator or delegated principal without
being the credential subject. Deleting any of them must find and minimize their private copies without destroying
a living subject's credentials or an unrelated operator's resources. A current client owner is one known party;
it is not evidence that nobody else occurs in a value. Encryption changes disclosure, not custody or erasure.

Use the existing Auth database, native party columns, client/account fences, `auth_erasure` phases and consumer
continuations. These are privacy attribution roles, never new permission roles. There is no metadata authorization
service, identity graph, second reverse-index service, erasure engine, generic cleanup callback or coverage boolean.
All normal admission still uses current Access authority at its authoritative T. Erasure admission uses the existing
permanent obligation after the source fence. A source release never waits for Auth's final acknowledgement.

## Observed producer inventory

These are actual source surfaces, not inferred schemas. An absent producer is a closed surface, not a delivered
feature. All proposed native role columns below carry existing Access `account_id` values, never email/handle IDs.

| Native store and fields                                                         | Current producer and facts it actually has                                                                                                                                                                                                 | Current custody gap                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth_client.client_id`, `first_party`, `scopes`, `display_name`                | `service.ts` / `internal.registerClient`: trusted deployment input, existing client lock, scope validation and reduction gate; host startup registers `login` and the dedicated Auth page operation client                                 | No authorized person/owner context; this method cannot accept personal metadata or establish personal ownership                            |
| `auth_client."userId"`, `contacts`, `metadata`, other provider free fields      | Physical Better Auth schema; generic registration does not write these. Native tests/imported historical rows can contain them. Dynamic/unauthenticated registration and key rotation are disabled by `websiteProvider`                    | `"userId"` proves only the recorded owner. No contact-subject or foreign-person custody; arbitrary JSON is not a role manifest             |
| Website client keys, redirect/logout URIs and native protocol configuration     | `website.ts` / `registerWebsiteClient`, one fixed `WEBSITE_CLIENT_ID`, validates public JWKS and exact URIs, uses existing client lock                                                                                                     | Trusted application configuration only; no personal metadata writer or party-context port                                                  |
| `oauthResource` including `name`, `metadata`, `customClaims`                    | Same website transaction upserts configured API audience, constant `REZICS API` name, configured allowed scopes and 300-second access-token TTL                                                                                            | Resource has no `userId` or native personal-party columns; owning a linked client does not establish exclusive resource ownership          |
| `oauthClientResource` including `metadata`                                      | Same website transaction inserts the exact client/audience link; no metadata input                                                                                                                                                         | Indexed `clientId` drain exists; no foreign metadata-party scope                                                                           |
| `auth_registration_stage`                                                       | `workflows.ts` / `createStage`: preselected `registrationTarget`, normalized handle, original logical request key; AES-256-GCM credential envelope, HMAC credential binding; approved automation records creator and operator              | Client, acting-human and delegated-principal context is not projected from the native approval; old rows can lack creator/operator context |
| `auth_registration_stage.creation_binding`                                      | Automation's typed business descriptor: kind, generated registration identity, operator, handle and logical operation key; the authorization reference is removed. `createNativeWorkflowProofPorts.creationBinding` reads this exact stage | Legacy descriptors are opaque; this reader is an equality/binding check, not complete person classification or a retired-consumer proof    |
| `auth_provisioning_receipt`                                                     | Credential transaction inherits creator/operator and exact stage locator from the locked native stage; binds original account/registration/reservation/epoch/deadline                                                                      | It cannot invent missing stage parties or replace a missing original source result                                                         |
| `auth_workflow_request.request`, `digest`                                       | Native workflow request producer stores business input and typed subject/human/operator/member/previous-operator/client/stage locators                                                                                                     | No delegated principal projection; historical unknown requests remain pending; a typed locator is not custody of DBOS's copies             |
| DBOS input, output, error, step output, events/history, messages, queue records | SDK transactions create actual durable copies, sometimes after the source transaction or during replay                                                                                                                                     | No atomic shared-history recorder/minimizer and supported closure verifier are composed by Auth                                            |

Current protocol attribution is distinct: `erasure-attribution.ts` decodes only pinned, typed reset/WebAuthn/code
producer formats at creation; session/opening/token triggers copy known native roles. Keep this behavior. It does
not permit scanning arbitrary metadata, old verification bodies or ciphertext to recover roles.

## Adopted field dispositions

### Mechanical configuration

Retain the least application configuration necessary to operate a living client/resource: exact IDs, first-party
flag, validated scope set, enabled protocol switches, grant/response/application types, public verification keys,
configured API audience and bounded service-controlled endpoint URIs. `display_name` and resource `name` may be
retained as service labels only when their trusted producer supplies application constants, with no user-derived
interpolation. Current `registerClient` validates length, not that semantic restriction; it must not be advertised
as a personal-label writer. Existing free labels without producer provenance use the legacy disposition below.

A syntactically valid URL or JWK can still carry personal information. Do not treat arbitrary URI paths, query,
`kid`, `jwksUri`, software statements, claims, `referenceId`, icon, policy or terms fields as automatically public
or person-free. Website URIs already disallow userinfo, fragments and query. Only configured service endpoints
and bounded, validated public key material belong in the mechanical path. An owner-specific endpoint/label needs
an adopted typed producer and its full native party scope before release. Public-client secrets remain secrets
and use the existing client drain; they never become retained skeleton fields.

### Disclosure at current T

Mechanical discovery/consent responses expose only their existing configured fields. A future contact read needs
current native authorization for that exact client and must check all stored party and producer-client fences
before selecting the value; ownership or an old approval is insufficient. An erased related party's contact is
unreadable at T while physical cleanup continues. Do not add contacts, private descriptors or arbitrary metadata
to discovery, consent, profile, token claims, exceptions or logs. Auth retains no new public profile authority.
Historical fields without complete typed custody are unavailable to personal readers, even for a living owner,
until the adopted scrub or typed source replacement completes. Reassert service-controlled labels from actual
configuration before exposing unproven historical labels. Closing only a writer does not satisfy the read fence.

### Contacts and other personal metadata

`auth_client.contacts` is not a source of identity truth. A new personal contact must be one typed contact value
for one explicitly identified subject, with the full context below. Validate an address only as an address; never
resolve it to an account. Do not store free-text notes or a list of people in that value. An external person with
no native account/verified source binding cannot be assigned a surrogate account or attributed to the client owner;
this contract closes that contact writer until an owning source adopts such a binding. It does not invent an
external-person identity service.

Arbitrary `auth_client.metadata`, `oauthResource.metadata`, `oauthClientResource.metadata`, `customClaims` and
software statements are not admitted on a personal writer. A typed product-specific field may be added only with
its source-defined meaning, all parties, bounded payload, indexed disposition and consumer retirement. Merely
wrapping arbitrary JSON in `{ ownerId, value }` is insufficient. A value involving several people needs separate
source-owned typed records for those people; an unconstrained `relatedAccountIds` list is not complete evidence.
Configured scope lists are mechanical vocabulary, not JSON personal metadata.

The selected minimal proposal is a native contact child relation, not JSON contact arrays and not a generic
metadata sidecar. Resource/link metadata stay closed to new arbitrary writes. This keeps the existing provider
models and single client authority; no second store of canonical client configuration is introduced.

### Historical opaque values

Auth adopts **whole-field purge** of historical contacts and free metadata/labels whose complete parties cannot
be established from the original typed source. This is an owner disposition, not a claim of non-personhood or
all-role emptiness. Purge the whole value, including archives and shared copies. Do not inspect or retain a
redacted sample, hash of contact values, original JSON, email, handle or ciphertext as audit evidence.

Historical scrub is a bounded deployment operation over independent raw primary keys in each actual store; it is
not account discovery. It sets `contacts`, arbitrary `metadata`, unproven free labels/claims/statements to null
(or removes a row whose entire purpose is private), preserving only proven mechanical configuration.
`oauthResource.name` is NOT NULL: replace an unproven label with the inert empty string, or with the actual
producer's proven service constant; never delete a shared resource to evade that constraint. If a
consumer still uses a value, block that consumer and retire or replace it through its owning typed command before
scrub; do not silently mutate authorization inputs. No age or security-retention exception applies. A deployment
checkpoint records store/version/raw-key boundary only. Final full coverage additionally requires old writers
closed and supported custody of copies; the checkpoint alone is no proof flag.

Historical creation/request values differ: a release consumer may still need an exact reservation/activation
witness. Null ciphertext and credential digests immediately under an actual erasure fence. Keep only the exact
still-needed typed witness, restricted to mechanical continuation, until the original source commands retire it.
If source identity or consumer completion cannot be established, keep the obligation pending, with a bounded raw
key and precise reason. Do not null its last witness merely to satisfy a test. Once consumers retire, purge the
private descriptor, request, handle, approval/pending references, business digest and role links; minimize any
terminal result/proof under deletion policy too. Whole-field purge cannot stand in for source retirement.

## Exact native party scope proposal

These fields are **proposed native columns**, not exports currently present in `@rezics/auth-contract`. The
Access/native composition owner must explicitly adopt projection of its verified context before implementation.
Use a closed typed result, not `Record<string, unknown>` and not caller-supplied account fields:

```ts
// Proposed private composition result; no public request may construct it.
type NativeMetadataContext = Readonly<{
  ownerAccountId: string | null; // locked current native client owner
  actorAccountId: string | null; // verified actor, not automatically a human
  actingHumanId: string | null; // source-proved human behind an opening
  operatorAccountId: string | null; // exact native relation used by this command
  principalAccountId: string | null; // resolved current assignment's principal
  clientId: string; // authenticated native issuer client
  approvalReference: string | null; // original typed native approval locator
  commandKey: string; // original stable command identity
}>;
// Subject is verified by the specific source command, independently of owner.
type NativeContactWrite = Readonly<{
  clientId: string;
  contactId: string; // opaque independent key; never the address
  expectedRevision: bigint;
  subjectAccountId: string;
  address: string; // single bounded contact; no free notes
}>;
```

Null is allowed only when the specific typed producer proves that role inapplicable (for example, service
configuration has no acting human), never because a port was absent or a historical column was null. On a new
personal write, missing required context refuses before any native/shared copy is created. A caller's contact
subject must match an actual source-approved contact command; permission to manage a client does not authorize
claiming that an unrelated person supplied an address. No current Auth source supplies that contact command.
Do not release a contact endpoint by pretending `registerClient` provides it.

| Stored field                 | Exact authority                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_account_id`           | Client's locked `auth_client."userId"` at this write, checked with current Access state/fence; a deployment-config client may have no personal owner |
| `actor_account_id`           | Native resolved approval's authenticated actor, or real Auth session for an adopted self-service command                                             |
| `acting_human_id`            | Real session-opening/native approval context; do not assume every actor is human                                                                     |
| `operator_account_id`        | Current source operator relation and version bound by that approval, independently of actor/owner                                                    |
| `principal_account_id`       | Current `readAssignment` resolution for the verified actor's assignment, matched to original approval and command basis                              |
| `subject_account_id`         | Exact source contact subject or preselected registration target; never parsed from payload                                                           |
| `source_client_id`           | Native authenticated producer client, distinct from the target client receiving metadata                                                             |
| `stage/receipt/workflow key` | Actual native producer locator; no search for a matching workflow input                                                                              |

Roles may coincide but must not be collapsed on write or omitted from discovery. A role change does not rewrite
the parties of an existing copy. Replacing a contact creates the new revision with its own current context while
retiring the old value and its copies. Revocation removes the old value, not just its authorization. Owner transfer
cannot turn the old owner's attributed data into a new owner's anonymous configuration.

## Minimal native schema and caller changes

This is a concrete proposal, not an applied migration. Use real current UTC migration timestamps when implemented;
do not install a future-dated placeholder migration for this specification.

1. Keep `auth_client`, `oauthResource` and `oauthClientResource` as the only configuration authorities. Add a
   monotonic `metadata_revision bigint` to the client for compare-and-swap and old-writer fencing. Purge the old
   free personal JSON columns under the disposition above; prevent new personal writes to them. Provider defaults
   may remain null for compatibility. Do not make `auth_client_coverage.ready` a metadata-coverage certificate.
2. Add `auth_client_contact` with primary key `(client_id, contact_id)`, revision, `address` (at most 254 UTF-8
   bytes), `subject_account_id`, and the six native context locators above (`owner`, `actor`, `acting_human`,
   `operator`, `principal`, `source_client`). Use explicit columns, no JSON role list. The row also binds the
   original stable command key/approval locator while its consumer needs them. Bound a client to at most 16
   current contacts under its existing lock. The encoded composite client/contact locator is at most 1 KiB in total; every other service locator has the same 1 KiB bound. Address
   validation/subject proof belongs to the adopted producer, never to erasure.
3. For `auth_registration_stage`, add `erasure_actor_id`, `erasure_human_id`, `erasure_principal_id`,
   `erasure_client_id`, `erasure_source_client_id` and a typed original approval locator. Keep existing
   `account_id`, `erasure_creator_id`, `erasure_operator_id`, release keys and reservation fields. Creator is the
   creation actor, not implicitly the credential subject. New encrypted stages bind the context and target in
   their immutable native request binding as well as the existing AES-GCM AAD/credential binding. Decryption is
   only for ordinary credential use; erasure reads no ciphertext. Do not decrypt/backfill legacy envelopes.
4. Provisioning receipts inherit **all** stage roles from that exact locked row in the credential transaction;
   add missing actor/human/principal/client/source-client columns with the same semantics. Copying just owner or
   creator is insufficient. A stage disappearing or changing binding makes provisioning refuse/roll back.
5. Add `erasure_principal_id` and any missing actor/source-client column to `auth_workflow_request`. Enumerate
   typed roles for each actual operation variant, including both sides of transfer, membership and automated
   creation, before storing `request` or handing any input to DBOS. The source operation's native context supplies
   these roles. Strip business payload after terminal consumer release, even if the DBOS history still exists.
6. Keep `creation_binding` only as the existing typed automation descriptor until its native reader and replay
   consumers can retire it. Do not add a second encrypted binding store. Its exact stage/operation/target/
   reservation equality checks remain required. Move only still-needed mechanical fields to explicit native
   columns, then remove the private descriptor after source retirement. The retirement proof itself must be
   minimized: today's `auth_native_consumer_proof.binding/result` can still contain handles and source business
   results. It is not a permanent retention exception.

For each new account-valued column create a leading-role B-tree `(role_column, independent_raw_key)` (contact:
`(role_column, client_id, contact_id)`). Keep the exact contact parent index and add `(source_client_id, client_id,
contact_id)` for producer-client drain. Stage, receipt and request client indexes lead with the corresponding
client column and raw key. Add the same finite roles to `initialRoles`, native store phases and residue probes in
`erasure-native.ts`; reuse that obligation's applicability/cursor, not another coverage table. Index nullable roles
consistently with the query predicates. Add exact source/child indexes before adding deletion guards. An FK alone
neither bounds a cascade nor discovers a foreign role.

### Native phase upgrade

Adding role entries changes the current array-derived phase numbers in `erasure-native.ts`. Do not splice them
into a deployed inventory and reinterpret saved progress. The implementation must version the finite native
phase inventory, translate each existing phase to the same store/role and preserve its independent raw boundary
in a bounded deployment page. Existing user-deletion/consent tail states retain their actual committed status and
original cutoff. Append missing-role discovery under the same obligation/barrier; a prior `native_completed_at`
is not coverage of those roles. Such obligations must become schedulable for the newly required phases without
resetting their finished old phases, applicability or T. Reject old producer/page versions before this cutover.
The ordinal v2 marker still protects existing consent cursors; it does not prove metadata-role coverage. No
account-ID cursor, full owner rewalk or new completion flag substitutes for this translation.

### Write, replace, rollback and replay order

The following is proposed internal control flow, not a callable exported function:

```text
resolve native authorization at current source T for this exact business command
project actor/human/operator/principal/source-client from that verified context
validate typed contact subject, values, input bounds and original stable command
acquire existing client and account-role admissions in the native producer lock order
  (all distinct role keys in deterministic order; no new lock namespace)
point-lock target client; reject disabled, erased, stale owner/revision or reduction gate
revalidate the exact current source binding; reject stale issuer/assignment/operator
CAS native revision and write payload + every typed party column in one transaction
record every actual shared copy through the owning shared-history creation boundary
commit only the admitted native result; replay returns its exact immutable result
```

Cross-database authority cannot be made atomic by holding an Auth connection while calling Access. Use the
existing source authorization/fencing and committed-effect handoff protocol: source permission and immutable
command identity first; Auth admissions check permanent fences before copy commit; late cross-store copies use
the participant's late-item protocol. A pre-read of Access followed by an unguarded Auth write is insufficient.
Until that composition is adopted, the personal writer remains closed. Ordinary trusted mechanical configuration
continues through its current method with no invented authorization callback.

Every native insert/update guard checks all old and new role fields plus target and source client fences before
replacement. Keep stable raw keys/revisions; reject role reassignment without a new authorized revision. Commit
payload, roles, retirements and checkpoint atomically. Rollback must leave no value, changed revision, orphan
party record or shared locator. A failed source command creates no Auth copy; a lost reply replays the exact
source key and native result, never a new approval's business descriptor. Reusing a command key with changed
subject/owner/parties/value refuses. Revoked/expired principals and old issuers cannot be replayed to create a copy.

`registerClient` retains its original API and all current invariants: fixed first-party decision, normalized
scope-set validation, reductions only through `reduceClientScopes`, and `create-or-match` exact party flag and
scope-set match without metadata replacement. The dedicated Auth page operation client remains first party with
exactly `organization:create` and `account:delete`; it gains no client-management/contact permission. The website
client retains its separate confidential key/PKCE/resource binding and exclusive `media:complete` admission.
Contact-party attribution grants no scope, session, credential, consent, client identity or source permission.

## Discovery, erasure and consumer retirement

For a deleted party, seek the finite native role indexes directly. Each role uses its own raw-key boundary under
the existing `auth_erasure` barrier; no OR scan over payloads, owner enumeration, email lookup, handle search,
account-id cursor, JSON traversal or decryption. For contact composite boundaries, use client/contact raw keys,
not subject IDs. Delete/minimize the selected contact value and all copied role links together. A source-client
owner erasure fences that client, drains every affected native copy, and preserves living subjects' independently
authorized credentials. A shared API resource survives an erased linked client; remove only the link/private
payload for which that client was the custodian. Do not disable or delete another client's resource as a shortcut.

A contact-subject erasure clears the contact even if the client owner/operator/principal lives. An actor/human/
operator/principal erasure likewise retires its attributable private revision; keep the unrelated mechanical client
and independently valid contacts. If a consumer still holds that exact revision, retire it before unlinking the
last locator. Foreign producer context is needed for this decision; `"userId"` alone cannot find it.

A registration erasure first removes ciphertext and credential digest, then continues the original source
activation/expiry, handle release and operator responsibility release through `erasure-consumers.ts`. Preserve
only the witness those commands require. A current living operator is not an excuse to retain an erased creator's
private descriptor. A client-owner erasure must not apply a surviving subject's staged credential: the existing
native fenced-refusal/committed-CAS consumer determines its actual outcome. A committed effect is never applied
again. Source rollback or missing result keeps the original held key pending, not successful by elapsed time.

Retire source and consumer in this order:

1. Close old personal writers, including legacy provider/import SQL paths. Deploy typed producer guards and role
   indexes before accepting new private values. Enumerate each deployed writer version; there is no inferred
   historical coverage from the presence of the newest code.
2. Transfer/settle every exact native consumer, preserving its original command/result boundary. Registration,
   recovery and reduction continue under the existing native obligations. Unknown source results stay pending.
3. Purge unclassified free payload through the adopted whole-field disposition; purge retired request/binding
   payload and minimize source terminal proofs. Record copied artifacts at their actual creation transaction, and
   resolve late items after their minimization commits. Do not discard source locators before durable handoff.
4. Prove indexed absence/minimal skeletons in every role and producer-client scope, then remove children before
   parents with actual empty-child guards. Preserve the permanent erased-client/subject replay fences.
5. Complete bounded delayed consent using the original 310-second cutoff. Neither metadata cleanup nor a new
   deployment can shorten/reset that original safety delay.
6. Native completion still waits for missing history-copy custody and trusted fixed-Auth composition. Wait for
   the supported producer handoff/closure only, never shared history's global acknowledgement. There is no Auth
   `none`, ACK or `ready` shortcut in this slice.

The final least-payload skeleton is the existing obligation/barrier, immutable applicability, phase/coverage
version and terminal progress marker, plus the client/subject replay-refusal identities needed to prevent reuse.
No contact value, human/operator/principal relation, handle, request digest, original approval, encrypted payload,
source business result or former owner-to-resource association remains just for diagnostics. A temporary release
witness is removed when its consumer finishes; it is not a new retention class. No independent proof flag certifies
that JSON happened to be safe.

## Physical bound

The existing stricter Auth page ceiling remains: at most 48 examined/admitted native raw keys per page, 1 KiB per
locator and 64 KiB total returned control data. The deletion policy's generic 100-key allowance does not enlarge
Auth's bound. One transaction visits one store/role or client/store; an additional party means a fixed number of
phases, not an owner/account-history scan. Charge admission locks, nested guards, child probes, proof/minimizer
work, source reads, mutation, checkpoint, control/output bytes and rollback. Contacts admit at most 16 current
rows per client, but erasure still pages by the selected role; do not load every client to find one person's row.
Do not return addresses or encrypted envelopes in erasure progress.

For ordinary contact mutation the input bound is one contact, six fixed context roles and one client (at most 16
contact keys for cap enforcement under its lock). Reads/mutations are constant examined rows/statements and
logarithmic indexed blocks in unrelated account/client/history populations. Historical scrub admits at most 48
primary keys and bounded column output; never return or parse all historical payload to classify it.

Existing consumer pages reserve space within 48: registration/provisioning/recovery admit 44 outer keys; reduction
admits 38 including its eight-row source batch. Extend those budgets for any new native role/child probes before
shipping; do not merely add queries while retaining the old ceiling. Release Auth's connection before foreign
service calls, sleeps, another client or another page. A fixed returned LIMIT without bounded nested physical work
is not evidence. Global scrub is finite resumable deployment work; per-person discovery is only indexed roles.

## Actual ports, missing interfaces and ownership

| Boundary                        | Actually available now                                                                                                                               | Exact change still required; owning scope                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mechanical client configuration | `AuthService.internal.registerClient`, `registerWebsiteClient`; existing locks/reduction/fences                                                      | Auth owns typed contact relation/writer, guards, old-field disposition, native role indexes and erasure phases; neither method currently accepts private metadata/owner context                                                                                                                                                                                                      |
| Current principal resolution    | `TrustedAccessPorts.readAssignment(requestedBy, assignedActorId)` returns typed `AssignmentProof`; `/token` verifies current principal/actor binding | Access/native composition must adopt a verified metadata/creation context projection carrying actor, actual opening human, operator, principal, issuer client and original stable approval/command identity. `actorAccountId(context)` alone cannot supply it                                                                                                                        |
| Approved creation               | `authorizeOperation`, `actorAccountId`, `stableCommandKey`, `approvalBinding`; native approval stores actor/client/requested-by basis                | Access owns projection of that basis and source contact-subject command semantics; packages/auth-contract owns any explicitly adopted shared types. No `authorizeMetadata`, contact approval variant or context export exists today                                                                                                                                                  |
| Stage/provisioning binding      | `NativeWorkflowProofPorts.creationBinding`, `pendingReference`, `provisioningEvidence`; immutable stage/receipt relations                            | Auth must persist all missing roles before encryption/request/copy creation and propagate them in the same native transactions; do not cast the current descriptor to a new shared interface                                                                                                                                                                                         |
| Actual source results           | `activate`, `expireRegistration`, responsibility release; `completeRecovery` when composed                                                           | Access owns a read/replay boundary for the exact committed activation/recovery result even when original transient provisioning/establishment evidence has expired. Bind original source command, account/reservation/floor; never authorize a new effect. The current activation path validates transient evidence before replaying its receipt                                     |
| Native retirement               | `registrationTerminal`, `nativeRequestTerminal`, `closeCredentialConsumer`, existing consumer continuations                                          | Auth owns minimizing private terminal proof bindings/results after their last native consumer; existing proof rows are not deletion-policy exemptions                                                                                                                                                                                                                                |
| Shared durable copies           | `runWorkflowRetentionBatch` uses supported SDK list/delete for terminal histories; request-retention trigger follows SDK deletion                    | Shared-history/DBOS owner must expose supported atomic copy recording/minimization and producer closure for **actual** workflow input/status output/error, step output/error, event/history, message/queue creation. Bind physical locator, artifact kind/version, all source parties, barrier and late-item resolution. No such Auth-importable recorder or closure verifier exists |
| Final participant result        | Native `auth_erasure` obligation and delayed-consent progress                                                                                        | Accounts composition still needs the trusted fixed-Auth participant port after full native/shared custody. This contract supplies no synthetic completion export                                                                                                                                                                                                                     |

These are fixed implementation handoffs, not an open research list or optional alternatives. Runtime shared-type
changes require their explicit owning adoption. Missing foreign context/result/recorder interfaces are reported
as missing, not implemented locally by copying Access SQL or patching SDK tables from Auth. The private contact
writer stays closed until its source semantics and shared-copy custody are composed; mechanical configuration
and native erasure continue through their actual existing ports.

## Native outcome handoff

`test/metadata-privacy-contract.test.ts` and `test/growth-metadata-privacy-contract.test.ts` are native source
boundary evidence for this specification slice. They use real registration, native Access approvals/deletion,
actual encrypted stages, client/resource producers and the existing erasure pages. Historical payload fixtures
exercise unknown provenance; they never seed coverage, terminal consumer proofs or an erasure outcome. Their
positive claims are restricted to available behavior. In particular, observing a native pending obligation is not
proof that proposed contact-party scope already exists.

The runtime implementation must extend those scenarios through its adopted producer, without removing these
boundaries, and deliver the following outcomes:

| Scenario                                                               | Required outcome                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment registration / exact replay                                 | Exact first-party and normalized scope-set match preserves metadata; mismatch/reduction refuses atomically; Auth page client retains its original two scopes                                                                                               |
| Website registration / replacement                                     | Real keys/redirects/resource/link update atomically; arbitrary injected metadata is not adopted; the API resource remains shared configuration                                                                                                             |
| Owner, contact subject, human, operator and principal all distinct     | Native source-approved contact records every real role before copy creation; delete each role independently, clear that private revision, retain unrelated client/configuration and living subjects                                                        |
| Foreign related person with another owner                              | Direct role-index discovery finds its contact/stage/request/copies without visiting the owner population; missing source context refuses, not assumed empty                                                                                                |
| Erased client owner / living credential subject                        | Client and its private copies retire; staged credential closes through actual CAS/fenced refusal; living password and independent sessions/clients remain usable                                                                                           |
| Replace and revoke contact, transfer owner                             | Revision CAS and original command replay are exact; old private values/copies/party associations retire; new authorized revision has its own complete current context                                                                                      |
| Stale issuer, assignment revoked/expired, changed command replay       | Refuse before copy commit at current source T, preserve original immutable result/binding, create no orphan native/shared copy                                                                                                                             |
| Encrypted automated creation, distinct human and organization operator | Subject/creator/operator/source client/principal are typed independently; never infer from decrypted email or descriptor; creator erasure clears secrets while real release witness stays pending                                                          |
| Ambiguous legacy contacts/metadata/creation                            | Whole free-field purge after consumer retirement, or exact safe pending for unknown release witness; no account roles invented from strings, JSON or ciphertext                                                                                            |
| Source failure and native transaction rollback                         | No fabricated successful result; native revision/payload/roles/checkpoint roll back together; original key retries without duplicate effect or custody loss                                                                                                |
| Fixed-page native growth                                               | At 256/1024/4096 unrelated clients, links, stages and histories, selected role/client page charges all native work, constant rows/statements/control bytes and logarithmic indexed blocks; include same-owner history separately for new contact revisions |
| Source/consumer closure and skeleton                                   | Last source result is real; no private result/descriptor survives retirement; original consent cutoff retained; missing shared-copy handoff or trusted participant port remains pending                                                                    |

Acceptance evidence for the new private writer must originate at that real writer, not direct insertion of proposed
party columns, fixture-created terminal proofs, fake source callbacks or a seeded coverage truth. Direct fixture
writes are appropriate only for historical unknown input and unrelated growth populations. No test may repair a
source deadline, release an operator hold, install an erasure cursor or disable an immutable guard to obtain a pass.

## Source evidence read for this contract

Repository source: Auth schema, `service.ts` client registration, `website.ts` registration/resource/link producer,
`website-provider.ts`, `host.ts`, `workflows.ts` staging, `native-workflow-proofs.ts`, `erasure-attribution.ts`,
`erasure-native.ts`, `erasure-consumers.ts`, `retention.ts`; shared `packages/auth-contract/src/index.ts`; Access
`native-account-bindings.ts` and `workflow-approvals.ts` actor/principal/approval projection boundaries. Native
fixtures and erasure/consumer/website/growth suites supply the available workflow surfaces.

Read-only reference source: `.reference/INDEX.md` in the main checkout, and
`.reference/search-worker-outcome-harness/dbos-transact-ts/src/system_database.ts` at the indexed
`980dc55095f445b189aecb59e7f3334345179f65` revision (MIT): workflow-status/input transaction, operation-output
recording, notifications and event/history transactions. These show why an Auth request locator or pre-enqueue
intent does not cover the SDK's actual durable copies. No reference implementation is copied or modified here.
