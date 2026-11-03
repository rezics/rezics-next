# Edition draft creation growth

## Operation and source

This binds the Content Cost row **Edition draft creation** to
[`growth-edition-draft.test.ts`](../../services/kernel/test/content/growth-edition-draft.test.ts) and its
[private composition](../../services/kernel/test/content/support/growth-edition-draft-fixture.ts).
The inspected retained source is `d50464392475ae4a76362a7ed0bb1e9646126501`, the controller-bound base.
The brief's earlier inspection at `e21850110a75d916451a03711b9035610db998bf` is not the source binding.
At the retained base the owning Cost row still declares no growth claim; the focused edition tests have no
three-scale creation series. Existing immutable-source and selected-association behavior is retained.

Authority: [Content Done-when 1 and 5 and Acceptance](../goals/content.md), and
[fixed authored editions](../../services/kernel/src/content/README.md#fixed-authored-paid-editions).
The slice ends at committed draft creation. Creator candidate projection, publication, Commerce and delivery
are outside its measurement boundary.

Decision: use one fixed two-post native ancestry and a small canonical body at every scale; produce all selected-source
history through native conditional HTTP revision commands, and seed only unrelated pressure outside observation.

## Native composition

`createNativeContentSystemWithWriteRateOverrides` starts the existing native Auth host and account workflows,
registers ordinary client scopes, provisions actors through native registration/sign-in/consent, and gives them
parent creation permissions through native governance HTTP commands. The private fixture reuses its production
Access instance, keys and accounts. It bootstraps the bundled definition release, then mounts `createKernel` on
the shared growth observer's pool. No permission evaluator or source reader is replaced. The Auth consent reader
is mounted on the same native Auth database. The larger ordinary write-rate fixture capacity admits history setup;
it changes no growth-classifier budget or assertion.

HTTP creates the ConceptScheme, associated Concept, Space, public Realm, board scheme, published board,
protected thread/root, and protected reply. The reply is the selected source. A native conditional revision changes
the head and its associations before any draft measurement. The old revision remains the only enrolled source,
with its original SHA256, SPDX licence, writer and target Concept. The newer head's Scheme association is a
refused selection for the original revision. A template draft is also created through the native HTTP command.

The actual measured operation is `POST /v1/contentEditions` with a fresh quoted idempotency key and exactly
`{ postId, revisionId, targetSubjectId }`. The production HTTP command owns receipt and outbox writes. The
existing Auth runtime is running; no default worker is required to commit this draft, and no worker completion
is included or claimed. An instrumented pool with capacity one requires the kernel to release each home before
checking out the next. Native Access and authentication remain inside each request.

## Independent pressure

Each series has a fresh isolated native system. Scales are exactly 256, 1024 and 4096, with the harness's unchanged
warmup/repetition policy. Setup and incremental growth run outside the measured callback.
Native Auth reissues the same ordinary scopes outside observation during long history setup and before measured
repetitions; each observed HTTP request still authenticates its real issued credential.

| Axis                                       | Population at scale N                                                                                                                               | Fixed selection                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Unrelated editions and source posts        | N unrelated threads, posts, revisions and pointer-only editions in the source route, cloned from native template row shapes by admitted `seed`      | Original source history has two revisions; ancestry has two posts                   |
| Retained selected-source revisions         | N native conditional revision commands after the original, retaining N+1 source revisions and their genuine write bases/receipts/events             | Old revision, body, licence, subject and two-post chain                             |
| Unrelated subject and Access grant history | N unrelated subjects, N retained revisions of a dedicated unrelated subject, and N expired grant intervals on an unrelated parent-creation resource | Selected Concept, board Scheme, source history, current grants, scopes and ancestry |

Noise grants retain the complete shape of a native parent-creation grant and use disjoint historical intervals;
they confer no current read permission. Unrelated edition rows remain in `content.edition` and unrelated canonical
bodies remain in `content.revision`. No body store is introduced. Selected resources, source revisions, editions,
initialization grants, receipts and events are never seeded using SQL. Footprint assertions distinguish each axis
and verify source post/history counts. Administrative reads are not part of measured work.

## Capture and assertions

`checkGrowth` captures native examined rows, shared hit/read blocks, plans and statements for the entire HTTP
request. It applies constant rows/statements and logarithmic blocks with its existing series classifier, default
slack, settling, catalog accounting, transaction closure and backend handling. `assertGrowthAccessPaths` rejects
executed sequential scans above the shared tiny-relation allowance. No planner setting, metric subtraction,
DTO-row counter or reduced Access capture replaces the native counters.

Driver observations assert repeated exact source/write-basis reads with the pinned route/post/revision/partition/
subject parameters and native canonical-body hash validation. The captured statement boundary includes released
subject, board, Realm, Space and account/fence reads; ordinary thread/post/revision ancestry; native Access;
edition insertion; owner initialization; receipt and outbox. Repeated creator-home checks require preparation and
final validation. The structural owner bounds remain one source and subject, at most 33 posts and a canonical
body at most 2 MiB, O(H log N) plus existing Access. The fixed two-post example does not measure the 33-post
or maximum-body envelope.

After observation, native rows and metadata must agree on the old source/digest/licence/subject/creator and draft
revision 1. Owner initialization must have type `content.edition` and exactly the native `content.edition.owner`
role for the creator. The exact native creation receipt must share the edition transaction, and its outbox position
must contain one `com.rezics.content.edition.created.v1` event with the returned draft identity. No publication is
inserted. The selected revision's full canonical fields remain unchanged as the head/history grows.

Separate full native captures cover replay with no new effects, a missing target field (400), a foreign association
present only on the newer head (404 `not_found`), a nonexistent subject selection (404), and another account's
creation refusal (404). A one-shot driver fault after the actual owner-role insertion raises native `overloaded`
(503, retryable), requiring rollback of edition, initialization, grants, receipt, outbox, write basis and home position.
The same key must then succeed through the real command as its allowed control. Draft byte reads and the other
account's ordinary protected-source read remain refused. Full selected source/ancestry grant rows must remain
unchanged. The narrow owner metadata grant is not source permission. Native source revision creation uses the
current route's 200 response; older focused edition tests' 201 expectations are not copied into this fixture.

## Execution limits

The native setup prerequisite currently fails with `error: record "new" has no field "scopes"` (PostgreSQL
`42703`) in Auth's `auth_kind_consent_writer_guard()`, PL/pgSQL line 88. Its client-configuration condition
references `NEW.scopes` while the trigger's current record has no such field. The failure is inside the unchanged
native Auth composition, before Content resources or growth captures exist. Repair belongs to that Auth guard's
owner; this acceptance must not replace registration, consent or grants to get past it. All four scenarios stop
in setup, so no operation assertion or growth verdict has been reached.

These are authored acceptance assertions and source reasoning, not measurements. No assertion result or growth
verdict is claimed by this document. Test output emits the shared report with native metrics/statement attribution,
axis footprints, and separate raw native command/replay/refusal/rollback captures if execution reaches them.
An infrastructure exit or incomplete series proves no clause. The controller owns admission, eventual execution
of `bun run --cwd services/kernel check test/content/growth-edition-draft.test.ts`, and integration verification.
The owning README and existing consumer tests remain unchanged; this document does not register proof or
promote the Cost row. An exposed native assertion defect belongs in a subsequent owning implementation brief.

Source reading was limited to the named edition tests and owning sections, native content fixture, edition
command/store/routes and source preparation, existing growth observer/classifier/seeder and a native point-command
growth example, supporting Content schema constraints, Goal authority and required workflow instructions.
