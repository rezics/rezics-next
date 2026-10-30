# Auth external copies and restore custody

This is the owner contract selected for Auth's remaining delivery, diagnostic and
restore surfaces under [account erasure](../../../docs/deletion.md). It specifies
adoption; it does not announce a provider, deployed backup system, new runtime
export or terminal Auth acknowledgement. Native progress already exists in
`auth_erasure`; external custody and restore admission do not. The executable
future cases are [external custody](../test/external-custody-contract.test.ts) and
[restore erasure](../test/restore-erasure-contract.test.ts). Missing producers fail
explicitly rather than supplying a mock deletion certificate.

## Inventory from the current source

The repository supplies an injected host, not a production deployment manifest.
No production mail vendor, log collector, backup destination, replica topology or
restore operator is configured here. That limits what can be certified; it does
not establish absence of historical copies. Inventory each actual deployment
before opening these writers. Do not mutate secrets or provision resources to
satisfy this specification.

| Surface and writer                                                                                              | Actual copy / receiving and retention consumer                                                                                                                                                                                                                         | Custody finding and allocation                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service.ts:deliverRecovery`, `recovery-delivery.ts:send` through `AuthServiceOptions.recoveryDelivery.deliver` | The injected callback receives account ID, email, reset token, expiry and a URL containing account ID/token. It returns `Promise<void>`. Auth writes `auth_recovery` and Better Auth `verification` first; failures remove only their exact native proof/verification. | Auth owns admission and exact delivery binding. The deployment's mail adapter owns queue, message, recipient, diagnostic, bounce, retry and vendor copy locators. There is no installed provider SDK or receiving erasure/result API. A resolved callback proves neither no copy nor deletion.                           |
| Better Auth reset callback error handling in `service.ts` / `recovery-delivery.ts`                              | Callback failures are sanitized to `Recovery delivery failed`; background start failure emits the constant `Recovery start failed` to `console.error`.                                                                                                                 | Sanitization prevents forwarding the mail error's contents. It is not coverage for all Better Auth logs or downstream capture. Auth owns structured emission; deployment owns stdout/stderr collection and all retained copies.                                                                                          |
| `better-auth.ts`, `service.ts`, native OAuth/passkey plugins and their logger                                   | Better Auth has its own diagnostics; no complete typed per-role log-copy recorder or sink configuration is composed.                                                                                                                                                   | Treat personal error/SQL/request context as possible until a source-side allowlist proves it cannot be emitted. Never index diagnostics by searching names, email, IP or JSON.                                                                                                                                           |
| `workflows.ts:start`, DBOS SDK diagnostics                                                                      | Auth sets `logLevel: 'warn'`. SDK console/error/cause metadata can carry workflow context. The host does not configure an external telemetry receiver.                                                                                                                 | Warn level is not minimization. DBOS/shared-runtime owner supplies actual emission hooks; Auth supplies typed roles; deployment supplies collector segment/object/version and deletion proof. Optional SDK telemetry is not evidence it is deployed.                                                                     |
| `workflows.ts`, `auth_dbos`                                                                                     | Registration, recovery, command/workflow inputs, step results/errors, messages, events and queue state are durable native copies. `auth_workflow_request` holds some exact request and role bindings.                                                                  | Shared-history owns actual durable-copy recorder/handoff/minimizers. Use supported SDK cancellation/deletion after native consumers settle. No callback intent or external log receipt substitutes for this separately open gap.                                                                                         |
| `retention.ts`, `maintenance.ts`                                                                                | Terminal Auth workflow history sweep uses `DBOS.listWorkflows` / `deleteWorkflows(ids, false)`; default 30 days, allowed 7–365, at most 60 batches of 1000. Native request retention trigger shares the SDK deletion transaction.                                      | Age-based history retention is not account erasure, log deletion, proof of backup expiry or bounded deletion of arbitrary workflow children. Keep its existing limits and native-consumer order.                                                                                                                         |
| `turnstile.ts:verifyTurnstile`, host public registration                                                        | Cloudflare Siteverify receives challenge token, configured secret, optional sanitized edge IP and a random idempotency key. Its result is bounded to 8192 bytes with a 5-second deadline.                                                                              | Actual external disclosure; no receiving erasure port exists here. Anonymous pre-registration transport evidence is not attributed to a future account by IP, name or token search. Deployment must inventory vendor diagnostics; any actual typed account-associated copy needs custody. The secret is never a locator. |
| Auth PostgreSQL public tables, `auth_dbos`, `auth_signing_key`, encrypted registration/effect stages            | Native stores contain credentials, protocol/session/consent data, workflow payload and temporary encrypted secrets. WAL, replicas, snapshots, dumps and operator exports can copy them if infrastructure enables those paths.                                          | Database/deployment owner inventories every enabled receiving target, WAL archive/replica lineage, snapshot and derived restore image. No production retention/restore controller is delivered. Auth owns replay and issuer admission on an isolated restored database.                                                  |
| `host.ts` database identity and startup, `scripts/database.ts`                                                  | Host requires the system and product pool to name the same Auth database. The dbmate dump is schema-only and excludes `auth_dbos`; check/compiler databases are fixtures.                                                                                              | These are not a production backup inventory, data restore hook or independent deletion authority. Kernel and Auth remain separate credentials/stores.                                                                                                                                                                    |
| `erasure-native.ts`, `consent-erasure.ts`, fixed native host continuation                                       | Permanent `auth_erasure` stores account, first accepted epoch barrier, applicability, coverage, native phase/checkpoint, original consent due/completion and pending reason; client replay fences also survive.                                                        | Reuse this progress and native producer locks. Current record has local `accepted_at`, not Access's immutable T/obligation tuple. Restoring a snapshot before its insertion loses it unless the receiving lifecycle below runs.                                                                                          |

Inventory is finite and owner-specific, not a generic ownership graph. Include
outbound reverse-proxy/access logs or database diagnostic exports only where the
actual deployment enables them; their absence from this repository is unknown
custody, not an invented new provider or claim of zero copies. Browser notices
are not email in first scope. Already delivered recipient-controlled mail cannot
be recalled by deleting provider storage; state this boundary in the inventory
without certifying that the recipient erased it.

## Authority and custody states

Access's permanent `access.erasure` is the source: exact route, account ID,
version and `at` (T), plus its deleted/fenced current account and epoch floor.
The selected future trusted point result adds
`erasure: { route, accountId, version, at }`, with canonical UTC `at`, to the
existing deleted/fenced account result. This is a required adoption, not an
existing field/export. Auth's integer `barrier` is the captured native authentication floor; it is not T,
a new deletion request, or a replacement source obligation. Preserve both the
source tuple and the native floor. Neither a restored `accepted_at`, wall clock,
new approval nor workflow completion supplies missing source authority.

For each admitted sink generation and account role, distinguish:

- **No configured writer:** a statement about this process/configuration only.
  Historical, removed, retired and in-flight routes remain unproved.
- **Sealed zero data:** owner-bound complete coverage of every producer/version,
  route and receiving copy class, with writer admission closed at the erasure
  fence and no prior or late applicable copy. Only this proof can supply `none`.
- **Unknown custody:** coverage, destination, locator, receiving result or closure
  is missing or unavailable. Keep the obligation pending with the exact boundary.
- **Retained copies:** actual locators exist or a send has an ambiguous result.
  Preserve positive applicability forever; erase/minimize and verify each copy.
  Completion after deletion is `erased`, never a later claim of zero data.

Null callback/configuration, missing native user/row, a 404 from an unbound sink,
TTL, callback resolution and elapsed token lifetime establish none of the sealed
zero-data conditions. Applicability is monotonic and survives crash, retirement,
restoration and history deletion. Auth's final outcome still needs every role,
native cleanup, original consent delay, shared-history handoff and trusted final
acknowledgement composition. External pending cannot be hidden by the earlier
`shared-copy-custody` pending reason.

## Source admission and actual receiving lifecycle

Auth owns the producer transaction and typed role bindings (subject, acting
human, operator, client owner, and other roles only when the actual source knows
them). Serialize admission with the existing permanent account/client erasure
locks. Never infer an owner from address or search a payload. A source copy needs
an erasure disposition before the writer version opens.

For recovery, extend the actual `deliver` boundary with a nonsecret stable
`deliveryId` equal to the newly captured verification row ID, bound to account and admitted
sink generation. Persist the intent and exact role locators with the native
verification/proof producer transaction, before invoking the adapter. The
current after-create hook is provenance, not an atomic external-copy recorder;
its separate proof INSERT does not implement this requirement. Keep token, URL,
email, password, secret and their identifying hashes out of custody progress.
Retries of the same delivery use the same identity; a new legitimate reset has
its own identity. This selects an adapter extension, not a new mail feature.

The actual deployment adapter must bind `deliveryId` to its provider namespace,
region/tenant, queue/message key, recipient-copy key, diagnostic key and immutable
version where present. Record child retries, webhook receipts and exports at
creation in that owner's native store. A provider without an idempotent request
or exact lookup keyed by the original identity cannot close an ambiguous send;
do not resend under a new identity and call the earlier copy absent.

The source-to-receiver protocol is:

1. Commit an admitted intent under the native fence, with sink generation,
   producer version and bounded typed locators. There is no external I/O while
   holding the Auth transaction/connection.
2. The receiving owner admits the same identity under its own erasure fence,
   commits its actual copy and locator atomically, or preserves an unresolved
   attempt if its provider cannot give a committed result. Durable acceptance
   alone is not deletion. Bind the returned result to the original request.
3. On erasure close source admission, seal the finite admitted producer/routing
   coverage and drain exact receiver locators. A pre-T intent reaching a closed
   receiver creates a late item; it is either refused with proof that no copy was
   made or its actual copy is erased. A post-T producer cannot mint a fresh send.
4. Delete/minimize using the receiving owner's supported native SDK/storage API.
   Verify irreversible removal of all versions, queues, diagnostic copies and
   derived copies covered by that locator. Versioned object delete markers,
   scheduled deletes and cancellation of a send are not physical erasure proof.
5. Commit the verified result and late-item resolution in permanent native
   progress. Lost replies re-drive the original identity. Crash after remote
   deletion but before checkpoint re-verifies that same copy; a missing result
   does not turn it into zero data. Keep replay refusal after payload removal.

Structured Auth diagnostics should emit only an adopted nonpersonal allowlist of
error code and operation kind. No request body, cookie, authorization header,
reset token/URL, email, SQL parameter, free-form error/cause or account ID belongs
in that stream. If a diagnostic actually needs personal context, the real writer
must record its typed account roles and exact receiving segment/record/version
before admission; it cannot rely on a generic stdout callback certificate.
Collectors, rotations, compressed archives, replicas, exports and provider
support copies remain the receiving owner's inventory. Mixed segments must
remove the selected personal fields/copy through supported rewrite/delete,
preserve unrelated living records and bind proof to the replacement generation.
If that API does not exist, report that precise sink pending. Do not invent a
provider erasure operation, legal schedule or success response.

## Bounds and permanent proof

Extend the existing native progress, not a second engine. An Auth external page
admits at most 48 raw locators, each at most 1 KiB and at most 64 KiB including
progress/results. One store/role/sink generation per page; strict keyset seek by
its owner index and immutable ordinal/key. Reserve room for child locators and
checkpoint as native consumer pages already do. No OFFSET, history discovery,
JSON/name scan, provider-wide listing or parent cascade through remaining data.

An attempt performs at most one receiving call after releasing the connection,
with a 5-second timeout and a 64-KiB response ceiling. Persist its continuation
before dispatch; on transient failure retain the original identity, error code,
attempt count and next due time. Retry delays are 1, 2, 4, 8, 16 then 60 seconds;
at most one attempt for that held key per scheduled maintenance tick. Exhaustion
of a process or SDK recovery budget never closes custody. Ambiguous, wrong-sink,
oversize, unauthorized or unsupported responses remain pending for repair, not
success; do not loop through them in a page. Any real adapter requiring different
bounds must adopt them before opening, within the existing whole-step limits.

At fixed selected neighborhood, database statements/rows and output remain
constant and indexed blocks logarithmic as unrelated accounts and old attempts
grow. No Auth connection spans receiver work, a wait or a kernel read. The
source obligation and all terminal coverage/proof are outside DBOS history.
Indexed existence checks of open copies/late items hold completion; do not count
or scan a whole provider inventory to decide it.

Permanent completion carries only the source obligation tuple, captured native
floor, immutable applicability, inventory/producer/sink coverage version, sealed
boundary, minimal receiving copy identity/version and verified disposition/proof
reference, completion time and unresolved reason. Finished progress drops role
payload and temporary association keys when consumers no longer need them;
retain only the minimal nonsecret replay identity needed to reject old writes.
A proof reference must resolve to the owner-verified irreversible result, not a
boolean supplied by an arbitrary callback. Do not retain email/token/body,
secret material, original error text or a hash standing in for erased payload.

Retention exceptions, if adopted, name the actual store/copy class, exact fields,
purpose, restricted access and original expiry, along with source obligation and
owner proof. No Access/Auth audit/security payload currently has such an
exception. Do not invent external legal retention choices. If a provider retains
diagnostics without proving erasure or an adopted exception, report pending.
Backup expiry is a separate outstanding state. Neither one permits silently
changing Auth's empty retained acknowledgement or claiming final completion.

## Restore admission and replay

A copy inventory entry must bind database identity, source cluster/timeline,
backup/snapshot/WAL range, capture point, storage namespace/key/version, replicas,
restored/derived images and the owner that can irrevocably remove them. Include
historic signing key generations and encrypted stages as actual copied payload;
this contract adds no encryption model or per-account key destruction claim.
Retention time passing is not storage deletion proof. Replica lag, a snapshot
before T and a restore from an older lineage must be represented explicitly.

The independent surviving authority is the existing Access permanent obligation,
not a second Auth ledger in the same backup. The database/deployment owner must
prevent normal traffic, issuer startup, scheduled workflow recovery, mail/log
writers and replica promotion before restore reconciliation. Auth alone cannot
guarantee this through `createAuthService`, which currently has no restore hook.
Keep restore targets isolated and unreadable until the following completes:

1. Bind the restored database/copy generation to its actual inventory entry and
   verified capture boundary. Source Access must be current and independent of
   the restored Auth snapshot. If Access is also restored, recover its permanent
   obligations through all committed confirmations first; without a verified
   surviving source boundary keep both closed. An older consistent pair of
   snapshots is not proof that later deletions never happened.
2. The Access owner supplies a bounded, resumable committed-obligation feed for
   the fixed Auth participant, plus exact per-account obligation resolution.
   Reconcile through a source-owned sealed high-water boundary; subsequent
   confirmations use the same live producer fence/feed before traffic can race
   cutover. Do not enumerate all living users or read kernel SQL from Auth.
3. Import/verify the immutable source route/account/version/T and original floor
   into native Auth progress under its account lock. Existing bindings must
   match; disagreement refuses admission. Preserve original applicability and
   first consent due time from surviving evidence. The database owner must retain
   recoverable committed native progress (including the tail after the snapshot)
   independently of that restored image, using its existing PostgreSQL recovery
   facilities. This is not a second Auth ledger. Access supplies its obligation,
   not Auth's private checkpoints or database credentials. `accepted_at` in the restored
   database cannot replace T. Never overwrite a source obligation with an empty
   restored inventory, reset completed source state or generate a new approval.
4. Redrive exact native children, held source consumers, shared-copy handoffs,
   external copies and late writes from the restored data before releasing its
   personal data. A completion marker carried in a snapshot proves only that
   generation: it cannot skip payload reintroduced by a different restore. Bind
   restore cleanup progress to the restored copy generation while keeping the
   same immutable deletion and permanent client/account replay fences.
5. Keep the original 310-second consent/source authority rule: consent is never
   removed earlier than its original due time, and it is not delayed another
   310 seconds on restore/retry. If the original due evidence is unavailable,
   admission stays closed pending exact recovery; do not backdate or guess it.
   Source registration/recovery/reduction authority remains its original
   receipt/deadline; restore cannot renew a 30-minute source hold or authorize a
   credential effect. Stale sessions, refresh tokens, client assertions, signing
   generations and workflow retries must fail against the same current fence.
6. Record the source boundary, restored generation, completed replay checkpoint
   and closed writer admissions durably. Crash at any stage resumes the same
   generation and barrier. If source/receiver/proof is unavailable or the copy is
   wrong, keep serving and issuance closed. Only release the restored generation
   after required replay and live fence/feed cutover, with unrelated living
   account data unchanged. Outstanding isolated backups still appear separately
   as backup expiry outstanding; restoring one repeats this lifecycle.

There is no account restore and no maintenance RPC to bypass this admission.
The deployment owner owns physical isolation and backup custody; Access owns
current-T/source authority; Auth owns native replay and issuer fences; shared
history owns DBOS copy minimization. No Auth process receives a kernel pool,
private reference key or kernel credential. A final coordinator status is not a
backup, replica or provider certificate.

## Adoption and rollout boundary

The precise missing interfaces are:

| Owner / current surface                                                                                             | Required adoption (not a delivered export)                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access / `packages/auth-contract/src/index.ts:SharedAccessPorts.readErasureAccount`, native Access bindings         | Current result is `AccessAccount`, containing state/fence/epoch but no source route/version/T. Supply exact permanent obligation resolution and the sealed, bounded Auth obligation replay feed and its source floor binding. Original Auth due/checkpoint recovery belongs to the database owner, not a new Access database read. Per-account polling cannot discover deletions absent from an old Auth backup. |
| Auth / `startNativeErasure`, `auth_erasure`, `host.ts` startup                                                      | Persist immutable source tuple beside the native floor; bind restored generation/checkpoints without replacing the original obligation. Compose admission before any handler, DBOS recovery, issuer or writer opens. Existing local progress/locks/consent pages remain the implementation primitives.                                                                                                           |
| Auth + Better Auth native producer / `recovery-delivery.ts` hooks and `AuthServiceOptions.recoveryDelivery.deliver` | Atomic intent/typed copy locator, stable `deliveryId` and verified receiving result binding. Current `Promise<void>` has no custody/result/erasure boundary. The pre-existing in-memory callback test fixture cannot certify external copies.                                                                                                                                                                    |
| Actual mail and diagnostic receiving owners                                                                         | Actual sink identity, generation/copy inventory, fence, exact result recovery, bounded delete/minimize/verify API and retained-copy/exception disclosure. No vendor or universal sink API is selected by this repository.                                                                                                                                                                                        |
| Shared-runtime / Better Auth and DBOS diagnostics                                                                   | Source emission allowlist or atomic typed personal-copy hook, including error/cause and stream forwarding. Warn level and generic stdout interception do not establish closure.                                                                                                                                                                                                                                  |
| Shared-history / Auth DBOS producers                                                                                | Actual supported atomic durable-copy recorders, bounded locator handoff and native minimizers for all message/result/input/step forms. Do not copy shared-history SQL or replace the SDK.                                                                                                                                                                                                                        |
| Database/deployment / restore orchestration                                                                         | Real backups/WAL/replicas/exports inventory, independent surviving source boundary, isolated restore lifecycle wired to Auth bootstrap, recoverable committed native progress beyond the old snapshot, irreversible deletion verification, and admission fencing of all old/new issuers and collectors. There is no deployed restore implementation or source API here.                                          |
| Accounts composition / `TrustedAccessPorts`, coordinator status                                                     | Trusted final Auth acknowledgement after all prior obligations, and separate external/backup outstanding disclosure. No synthetic ACK, `none`, readiness flag or permanent-unavailable placeholder fills the boundary.                                                                                                                                                                                           |

Roll out owner-native indexed storage and atomic producer recording while writers
are quiesced; record every enabled and retired destination generation and reject
old writer versions. Prove coverage of pre-existing custody through actual owner
records, not a production payload scan. If that cannot be established, retain
unknown custody and keep final completion closed. Start the adopted receiving
and source versions together, replay exact existing obligations, verify an
isolated before-T restore and failure recovery with actual adapters, then open
writers/traffic. Record operator adoption and remaining external conditions in
the owning runbook without credentials. This specification does not publish or
operate any resource.

Native tests below freeze observable outcomes with real PostgreSQL fixtures,
actual Access deletion where needed and the existing native page/crash
primitives. Cases needing an absent producer/receiver/restore orchestrator fail
at an explicit named adoption boundary; no skipped test or in-memory provider
certificate is treated as acceptance. The specification is complete while those
implementation and infrastructure adoptions remain open.

Source inspected: the files named in the inventory; `test/support/erasure-native.ts`
and `test/recovery-delivery.test.ts`; the reference index and DBOS
`search-worker-outcome-harness/dbos-transact-ts/src/{dbos.ts,system_database.ts,telemetry/logs.ts}`
at the index's revision `980dc55095f445b189aecb59e7f3334345179f65` (MIT).
SDK deletion is per workflow and optional child expansion is separate; neither
that API nor SDK logging supplies external custody or a restore authority.
