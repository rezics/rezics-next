# Library personal facts and lifecycle quality review

## Disposition and source binding

Reviewed on 2026-11-03 against dev and the clean worker base, both
`8f63aa396c789f5d6b10b5f65c2edaf24a3d5987`. The report changes no runtime, fixture, frozen outcome,
generated binding or owner contract. Its commit therefore retains that runtime source, but supplies no
execution evidence for it. Main promotion remains parked; this review registers no promotion proof.

Decision: follow the controller's final validation policy, defer acceptance/native/browser checks to integration,
and retain clauses 2, 5, 6 and 7 as unmeasured and non-green.

That policy explicitly overrides the earlier request to execute the original acceptance in this attempt.
No acceptance command ran, no assertion was reached, and no check UUID, runtime log or measured exit exists.
Research completion here means a committed review, not Library Goal completion. No workspace source changed,
so no workspace typecheck applies; no test file was created or changed.

The [Library Goal](../goals/library.md#done-when) and its linked owners supply the requirements below.
`docs/goals/library.capabilities.md` is absent at the bound source. The coverage map below links actual test
cases rather than inventing a capability manifest or treating wrapper discovery as proof.

## Clause review and bounded next briefs

All four clauses lack current-dev execution evidence in this attempt. The additional source gaps below are
distinguished from observed test failures. Proposed briefs are recommendations for the commerce manager;
none was dispatched or enqueued. Reuse the existing Library lifecycle/Source repair responsibilities and
Accounts' erasure ownership. This review does not establish the state of individual repair tasks.

### Clause 2: independent personal facts

> Owners manage exclusive states, independent labels, copies/holdings and every supported progress mode, including
> rereads and noncontiguous completed units. Clearing one personal fact preserves other facts and their Library
> presence under the existing authority. Stored subject references and accepted profile meaning remain intact.

**Finding: unmeasured.** [Personal facts](../library-and-collections.md#personal-facts-and-one-collection-abstraction)
defines Everything as the union of live state, effective labels, retained sessions/history and holdings.
Follows, curated occurrences and published snapshots alone do not establish membership. The original
[outcomes](../../specs/library-outcomes.test.ts) cover exclusive state/CAS (line 492), sparse units (680),
rereads (764), separate copies (786) and incarnation/replay (553). They do not alone prove that every kind of
clear preserves the complete union. The [label outcomes](../../specs/library-labels-outcomes.test.ts) add
state/label independence (446), source-fact distinctions (537), parent hiding/Undo (1092) and retained assignment
identity (1134). These remain unchanged and unexecuted here.

The [owner-fact hooks test](../../services/kernel/test/library/owner-fact-source-hooks.test.ts) names all four
fact drivers and the common source fence; it is additional source coverage, not a measured owner journey.
The Goal also retains separate profile and shelf outcomes. An entry-only HTTP pass would not establish
presence through labels, copies or retained history.

**Repair outcome / next brief:** use the existing Library personal-fact and native owner-query owners to record
one native journey with all four facts on one stored subject. Clear each independently, observe the surviving
facts and Everything immediately, then remove the last qualifying fact and observe absence. Include retained
profile meaning, reread history and sparse units. Run the unchanged Library, label, profile and shelf wrappers;
repair only a demonstrated violation, without replacing them. Likely paths are
`services/kernel/src/library/{entries,label-commands,copies,progress}.ts`, the existing native
adapters and their owner-query integration. This is one bounded union-preservation brief, not a new membership
authority. Other/anonymous/suspended reads and writes must remain denied during the journey.

### Clause 5: Following, counts and History privacy

> Following, private owner counts and History use their existing owner boundaries. Public discovery contains no
> private Library facts; publication is explicit, never inferred from payment, import mappings or personal edits.

**Finding: unmeasured, with explicit fixture gaps.** The original Library cases cover own Following (819),
owner-private entries/sessions/units/changes/copies/follows (847), public membership exclusions (884), explicit
published snapshots (937) and suspended credentials (979). Publication does not authorize private progress data.

[Private follow counts](../private-follow-counts.md#disclosure-authority) requires native `collection:update`,
`space:manage`, or management of the actual account resolved from its agent, including the account-self branch.
Outgoing follows/counts belong to the authenticated follower. Anonymous requests are `401`; the actual suspended
bearer receives `401 invalid_credentials`; missing scope is `403`; concealed targets/management denials are `404`;
unavailable dependencies/readiness are retryable `503`, never a fabricated zero. Successful counts are private,
`no-store`, and absent from public DTOs and indexes.

The [follow-count wrapper](../../services/kernel/test/library/follow-counts-outcomes.test.ts) imports the unchanged
[count outcomes](../../specs/follow-counts-outcomes.test.ts). Cases at lines 71–179 cover management, agent resolution,
denials and cursor/authorization boundaries; 190–266 cover replay, reverse delivery, suspension and terminal work;
288–327 cover unavailability, public artifacts and growth. Its
[native driver](../../services/kernel/test/library/support/follow-counts-driver.ts) uses native commands, Access,
source reconciliation, target delivery and observation of real receipts/outbox rows. However, `fixture(kind)`
explicitly refuses automated/organization host bindings, and `accountState(..., 'deleted')` refuses deletion with:

```text
Native Library dependency_unavailable: Auth account-operation delete approve/execute host binding in createLibraryDriver
```

This is a source-declared unavailable binding, not an error observed from a run. The agent-resolution case includes
operated/organization personas, so a supported subset cannot make that original suite green. `publicArtifacts()`
inspects actual response/index/event surfaces; this review did not execute its comparisons or validate their
complete coverage. Progress changes and published-log tests are not a substitute for Accounts' private History
authorization or shared History erasure.

**Repair outcome / next brief:** reuse the Library follow-count fixture owner, consuming the existing Accounts/Auth
native account-operation host. Bind actual operated/organization creation and terminal deletion, retain the exact
original count assertions, and record all personas, public artifacts and readiness failures. Likely paths:
`services/kernel/test/library/support/{outcome-driver,follow-counts-driver,native-conformance}.ts` and the existing
Accounts native fixture exports. Add no permissive success host. Accounts retains History authorization/erasure;
its owner should supply the current private History evidence, while Library demonstrates its own payloads never
leak through those reads. Measure the unchanged suite before proposing a production count repair.

### Clause 6: exact Undo and complete terminal cleanup

> Lifecycle cleanup covers the complete owned graph and shared payload custody, with immediate terminal fencing,
> real participant completion and no resurrection. Ordinary exact Undo remains governed by shared deletion.

**Finding: unmeasured; full completion is explicitly unavailable in current source.**
[Lifecycle authority](../library-and-collections.md#lifecycle-and-terminal-erasure) fixes ordinary Undo strictly
before the original 720-hour deadline and terminal fencing at T. [Shared deletion](../deletion.md#account-erasure)
requires cleanup in every role, exact shared-copy locators, actual store-owner minimization and durable completion;
dispatch, local exhaustion and workflow history deletion establish none of these.

The [entry lifecycle command suite](../../services/kernel/test/library/entry-lifecycle-command.test.ts) contains
real native create/read controls (183, 189), independent archived snapshots and empty-slot CAS (197), private
locator concealment (257), authorization before replay (273), strict expiry with wall-time-valid credentials
(335), all eighteen original pinned fields (368), and current source visibility (412). The
[HTTP Undo suite](../../services/kernel/test/library/entry-undo-http.test.ts) checks committed deletion headers,
restore conflicts, original receipts and closed transport output. The
[incarnation suite](../../services/kernel/test/library/entry-incarnation.test.ts) additionally guards clear/refill
ABA and exact replay. These are candidate proof for original identity/receipt/Undo; their existence supplies no exit.

The [terminal participant](../../services/kernel/src/library/erasure-participant.ts) deliberately returns `pending`
after local cleanup, with missing Source/destination disposition, identity-participant closure, shared payload
minimizers, publication-operation locators and logs/caches/exports/replicas/backups inventory. In particular:

```text
shared receipt/outbox/write_basis/work payloads: no exact Library producer custody/minimizer handoff
```

The [participant tests](../../services/kernel/test/library/erasure-participant.test.ts), including an unused actor,
assert pending rather than an invented `none`. The
[owned-graph suite](../../services/kernel/test/library/erasure-owned-graph.test.ts) uses actual retained clear,
labels, sessions/history, Collection children and pins; its workflow observer follows continuation segments and
asserts no Library acknowledgement even when local `remainingStores` is empty. It also covers replay and retirement
of retained Source children. [Source custody tests](../../services/kernel/test/library/native-source-custody.test.ts)
cover complete capture, altered holds, writer fences, retirement and explicit COMPLETE output. They do not discharge
all participant obligations or prove public A/pending B terminal disposition.

The fixture distinction is actionable: the Library conformance helper's `deleteAccount()` explicitly throws
`Native Library dependency_unavailable: Auth account-operation approve/execute host binding (not a kernel account-delete route)`.
The owning terminal suites already use [Accounts' native fixture](../../services/kernel/test/access/native-account-bindings-fixture.ts),
which constructs `createAuthHost` with native bindings/workflow proofs. Their
[deletion helper](../../services/kernel/test/support/account-deletion.ts) signs in, invokes Auth approval and execution,
and reads the committed Access erasure barrier. This is an existing integration seam, not a globally absent host.

**Repair outcome / next brief:** retain the existing Library terminal/Source repair owner and Accounts shared-history
owner. Deliver one exact Library producer-to-store-owner minimizer handoff, with durable locator/fence and late-item
handling, and observe the actual participant result through every continuation. Keep acknowledgement pending while
any other obligation remains. Likely Library paths are `erasure-participant.ts`, its owned-graph cleanup,
`native-source-custody.ts`, publication/identity producers and work registration. Accounts owns
`access/erasure*`, `history/**`, shared receipt/outbox/work minimizers and Auth proof verification. Do not turn a
local Library repair into replacement Accounts erasure. Separately record the existing entry Undo suites before
briefing any regression in ordinary retention. Final closure still requires full graph, public COMPLETE A/pending B,
late positive work, child-before-parent crash/replay and post-T nonresurrection measurements.

### Clause 7: ordinary APIs and reviewed pages

> Real APIs and storage support subject actions, Library/Collection browsing and editing, labels, copies, progress,
> Following and History through reviewed pages using Web's shared shell and patterns.

**Finding: unmeasured.** The [original Library wrapper](../../services/kernel/test/library/outcomes.test.ts) binds
`LIBRARY_DRIVER` and imports the frozen spec. Its
[base driver](../../services/kernel/test/library/support/outcome-driver.ts) provisions through Auth consent/sign-in,
creates the suspended persona through the actual suspend endpoint, publishes compiled definitions, issues kernel
requests and inspects PostgreSQL. Unsupported operations in derived adapters fail explicitly. Component HTTP suites
such as `personal-http.test.ts` and `progress-http.test.ts` are useful narrower coverage; they do not replace the
complete native driver or reviewed pages. The base driver's `inspect()` covers collections, members, entries,
sessions, units, changes, copies, follows and logs, not a complete cross-store lifecycle inventory. Native capture
also refuses incomplete internal-pool cost attribution rather than manufacturing measurements.

**Repair outcome / next brief:** reuse the Library API/native-adapter owner to record the unchanged full journey,
including labels/profiles/shelves and terminal personas through their owning suites. Supply actual API recordings
to the existing Web page owner for subject, Library/Collection, copies, progress, Following and private History
journeys. Likely paths are existing Library conformance adapters, `apps/web/src/library/**` and their existing
routes/stories. Require current phone/desktop, theme/locale, interaction/accessibility and visual review evidence.
No page was opened, browser check run or page regression established here; do not dispatch a speculative UI rewrite.

## Commands and evidence classification

The following are integration commands, **not executions or successful results from this attempt**. Paths after
`check` are relative to `services/kernel`. Use the supported owning runner and its existing placement; preserve
the inherited remote/compiler-database configuration. Do not unset `KERNEL_CHECK_REMOTE`, bypass the runner with
direct native `bun test`, or hand-edit generated inputs.

```sh
bun run --cwd services/kernel check test/library/outcomes.test.ts
bun run --cwd services/kernel check test/library/labels-outcomes.test.ts test/library/profiles-outcomes.test.ts test/library/shelves-outcomes.test.ts
bun run --cwd services/kernel check test/library/follow-counts-outcomes.test.ts
bun run --cwd services/kernel check test/library/entry-lifecycle-command.test.ts test/library/entry-undo-http.test.ts test/library/entry-incarnation.test.ts test/library/entry-incarnation-precondition.test.ts
bun run --cwd services/kernel check test/library/erasure-participant.test.ts test/library/erasure-owned-graph.test.ts test/library/native-source-custody.test.ts
bun run --cwd services/kernel check test/access/erasure-native.test.ts test/access/erasure-failed-locator-work.test.ts test/access/auth-history-proof.test.ts
```

| Evidence class | Actual result on the bound source in this attempt |
| --- | --- |
| Original acceptance and owning native suites above | Deferred by final controller policy; no process, exit, assertions, log path or check UUID. |
| Assertion failures | None observed; no assertion executed. Source-declared missing bindings/pending completion are findings, not captured failing runs. |
| Flakiness | Unmeasured; no first run or repeat exists. Older failure narratives cannot establish current flakiness. |
| Infrastructure failure before assertions | None observed for acceptance because it was not launched. Do not classify policy deferral or missing fixture code as infrastructure. |
| Measurements | No current native row/block/statement/byte attribution, growth, terminal segment/custody, browser, accessibility or visual measurements. Existing growth cases still require their owning runs. |
| Source binding | `git status --short` produced no entries; `git rev-parse HEAD` and `git rev-parse dev` each returned the SHA above; shell exit 0. These are identity observations only. |
| Decision delivery | `bun tools/goal/src/cli.ts inbox send commerce info "Decision: use a source-only Library quality review under the final validation policy; defer native acceptance to integration and keep clauses 2, 5, 6 and 7 unmeasured, with no promotion proof."` exited 0. |

Future integration evidence must name its own actual dev commit, exact argv, physical run/returned evidence paths,
native and final cleanup exits, reached cases and personas. A different commit, dirty snapshot, missing result or
pre-assertion failure remains non-green. [Verification placement](../development/verification.md#check-placement)
owns transport and settlement evidence. No baseline acceptance was executed, so no current failure is attributed
to this report or certified as an observed base failure.

Earlier evidence is useful only within its original scope: the
[entry lifecycle audit](library-entry-lifecycle-native-audit.md) documents native scenarios, missing surfaces and
repair slices; current owner documentation now describes installed retained-entry/HTTP Undo. The
[earlier entry research](library-entry-undo-independent-current.md) is design/source evidence, not a new run.
[Web review](web-review-library.md) binds revision `50253f81316a8e975d67971fb62ed42db3145c10`, not the current dev
SHA. [Accounts participant research](accounts-erasure-participants.md) binds
`da107d37f4b90b508bd705e8d2b0eaa1b38c444b`. Neither its recommendations nor an older red/green label establishes
the current native result. There is no current-dev runtime evidence artifact to link from this attempt.

## Primary-source patterns and recommendation

Reference clones were reused only as text; nothing from them was installed, built or executed. Paths in this table
are relative to `/home/edge/projects/rezics/rezics-next/.reference/`. The topic reuse entries are added to its
`INDEX.md`; this index is the only write outside the declared report path, required by the research instructions.

| Primary source, pinned revision and licence | Inspected path / finding |
| --- | --- |
| PostgreSQL `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`) | `library-shelf-maintenance/postgres`, `doc/src/sgml/ddl.sgml`, lines 1392–1401: deleting a referenced parent needs matching-child lookup; a foreign key does not automatically index referencing columns. [Pinned source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/ddl.sgml#L1392) and [official constraints documentation](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK). |
| Mastodon `f943e0583be804bb062e5c9a4f8e65e2a05e5346`, AGPL-3.0 (`LICENSE`) | `follow-counts/mastodon`, `app/services/unfollow_service.rb`: removes the addressed relationship, then performs its feed/delivery work. `app/services/delete_account_service.rb`: separately inventories associations and purges statuses, media, favourites, bookmarks, feeds and profile data; batch deletion and callback-dependent destruction are explicit choices. [Unfollow source](https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/services/unfollow_service.rb), [account deletion source](https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/services/delete_account_service.rb). |

The shared pattern is explicit relationship boundaries and complete accounting for dependent work: removal of one
relation proves that relation's change; completion of an account operation requires the other stores and side
effects too. PostgreSQL documents the indexing prerequisite, while Mastodon makes the application-owned cleanup
inventory visible. Neither establishes REZICS's private-count authority, exact Undo policy or terminal completion.

Recommendation for this stack: retain PostgreSQL native independent facts and indexed owner/child inventories;
retain the existing Access evaluator for private Following/counts/History; use DBOS for bounded resumable work,
with actual store-owner cleanup and the permanent Accounts erasure record deciding completion. Bind the Library
fixture to the already available native Auth host rather than implementing a second lifecycle. First measure the
unchanged suites on the integrated commit; attach each missing proof or demonstrated failure to its existing owner.
Adopt any resulting design decision in that topic's owning document. No external implementation is proposed for copying.
