# Creator edition inventory growth

## Binding and execution limits

Source inspected: `d50464392475ae4a76362a7ed0bb1e9646126501`, the clean bound base. The brief's earlier
`e21850110a75d916451a03711b9035610db998bf` inspection is not this attempt's source revision. At this base the
[owning Cost row](../../services/kernel/src/content/README.md#cost) explicitly has no growth run, and
`test/content/edition-index.test.ts` has focused native outcomes but no `checkGrowth` series. The private paths
named by this claim were absent. The missing-measurement premise holds; it is not an executed failure.

This binding exercises [Content Done-when 1 and 5 and Acceptance](../goals/content.md). The added test calls
`GET /v1/accounts/{accountId}/editions` through the real kernel. It covers only the existing native Edition
inventory. There is no body DTO, ownership count, Commerce eligibility or historical completeness assertion.

Decision: use five independent axes and four separate page series, with a fixed examined limit of two and
fixed two-post source ancestry; deep and terminal cursors come from native HTTP pagination during setup.

The authored assertions below are eventual acceptance code, not measurements or reached assertions. The
controller defers native/browser/acceptance launch and owns admission and integration. Type checking does not
establish a growth clause. No measurement, passing growth verdict or promotion is claimed in this document.
The eventual owning command is:

```sh
bun run --cwd services/kernel check test/content/growth-edition-inventory.test.ts
```

## Native composition

The private fixture composes `createNativeContentSystemWithWriteRateOverrides`, production Access and native
Auth registration, client consent and credentials. A fresh native account supplies an independent expired-grant
history recipient. Creation permissions originate in the native fixture's governance workflow. The measured
kernel uses the real current-consent reader and the existing receipt keys; authentication forwards its application
database work to the observed pool. Native author credentials renew during setup without changing viewer, client or scopes. Native Auth's separate service database and JWT/JWKS transport are outside
these application SQL metrics. No permission evaluator or consent decision is replaced.

Subjects, a Space, public Realm, board, thread and reply are created through supported HTTP commands. The
reply's fixed canonical body, licence and original subject association supply each exact pinned Edition.
Edition creation uses `POST /v1/contentEditions`; publication and withdrawal use the native lifecycle commands.
Only the producer's response supplies selected bindings. The fixture reads the committed command receipt,
uses `readBatch` to obtain its event envelope, and enqueues that envelope into `composeWork([registerContent])`.
It awaits `content_creator_edition` by the registered `effectWorkflowId`, never calls the effect directly and
never inserts selected candidates. The observer's checkpoint is the only relay setup SQL. Registration remains
complete; projection internals have no inventory counters or claims.

Command receipts, native effect execution and worker bookkeeping are the **setup command/worker envelope**,
outside the measured GET. Their cost is not asserted constant or included in the inventory result. The existing
native fixture's write-rate override admits setup volume; growth classifier budgets, sampling, planner settings,
Access limits and source bounds are unchanged.

## Independent axes and pages

Each axis/page pair gets a fresh native composition. `checkGrowth` uses `[256, 1024, 4096]`, default repetitions
and warmups, constant examined rows/statements and logarithmic shared blocks, with the shared classifier and
its ordinary uncertainties. No baseline registration or new gate is added.

| Axis               | Native or admitted setup pressure                                                                                  | Fixed selected work                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Creator candidates | Exactly scale native-created, registered-effect-enrolled Editions of this creator                                  | Limit two; source ancestry, body, licence and scope                  |
| Unrelated homes    | `seed` adds scale creator-home rows for unrelated creators, including the selected exact home and other partitions | Four native selected candidates; no selected row is bulk seeded      |
| Source history     | Native revision appends with fixed body and subject association                                                    | Four pinned Editions keep their original revision IDs                |
| Subject history    | Native terms PATCH appends alternate labels on the original subject                                                | Four Editions, exact subject ID and source ancestry                  |
| Access history     | Governance HTTP grants add scale nonoverlapping expired platform grants to a separate native account               | Viewer, scopes and source permissions; expired grants confer no read |

The source and subject axes exercise retained history of the selected native source and original subject.
After source erasure, further source-history pressure uses an independent native control source: the erased
selected source cannot accept revisions. This hidden-page series measures failure-closed source validation
against growing retained revision storage; the populated/deep series exercise selected-source history at every
scale. Every candidate still has the same two-post ancestry ceiling. Selected counts and native history counts
are asserted during setup. Unrelated creator-home rows are pressure only and make no enrollment or permission claim.

Populated requests start at the first key. Deep requests seek from the native continuation immediately before
the last full page. Terminal-empty requests use the last full page's native continuation; a full final page
conservatively has an empty successor. Hidden series erase the common selected source through the author's
native DELETE command. For growing candidate populations, each later batch uses a newly authored equivalent
source before its erasure. Every candidate on the page is concealed, yet the page retains continuation. Expected
IDs come from native responses sorted by immutable key, never a fabricated cursor or selected SQL row.

## Capture and assertions

Only one GET runs inside each observed callback. All authoring, effect completion, pressure, native cursor
walking and population checks precede it. The shared observer captures actual native rows, shared blocks and
statements for authentication, the creator-home range, owning metadata readers, Access and final validation.
Reports emit costs, per-repetition relation work and classifier verdicts when executed; this document contains
no substitute estimates presented as observations.

A SQL trace asserts exactly one native candidate range with limit two. Relation costs retain all examined and filtered
rows, including the shared classifier's existing tiny-relation scan allowance. Native key and range assertions
retain exactly two candidates (zero for terminal-empty), including hidden candidates, with no refill or lookahead. The selected
exact metadata IDs match those raw candidates. Each successful candidate prepares ordinary `edition:read` twice;
each candidate permits at most two owning metadata reads, each with an initial and two final metadata points.
The real owning reader performs its source, original-subject, ancestry and Access checks in both passes.
A single-checkout observed pool and zero-held-checkout assertion at edition Access preparation retain released
home behavior. They do not replace home validation or Access work.

This is the owning bound `O(log N + L × H log N)` plus actual Access, with `L <= 20`, `H <= 33`, and this fixture
fixing `L = 2`, `H = 2`. It is not one constant metadata call. The shared access-path assertion rejects sequential
scans of growing indexed relations beyond the harness's existing tiny-relation allowance. DTO key assertions
exclude bodies and counts. Application background SQL must be absent from the measured callback.

Focused native HTTP assertions retain same-account access, concealed other-account requests with an allowed
self-inventory control, draft/published/withdrawn bindings, viewer/account/limit cursor admission, forgery,
expiry and creator-home epoch binding. A source DELETE during the first final metadata pass must conceal all
selected results and IDs while preserving raw-key continuation. A moved creator home or selected metadata home must return the native retryable
problem and Retry-After, rather than a successful empty page. Only partition infrastructure state is injected
with SQL, then restored; selected Content or authorization state is never fabricated.

## Sources read

The contract, workflow skill and its verification reference, development README and agent conduct, Content
Goal and the linked Content Cost/viewer sections; the focused Edition/index tests; `edition-index.ts`,
`edition-reads.ts`, `edition-store.ts`, candidate SQL, Content registration and native event-log composition;
the existing native system, SQL observer, receipt keys and worker environment; existing native relay and appeal
fixture composition; shared growth observer, classifier, cost, access-path and seeding interfaces; native subject
HTTP/terms examples and the HTTP problem mapping. No external reference source is named by this contract.
Existing consumer tests, frozen specifications, shared fixtures and production files remain unchanged.
