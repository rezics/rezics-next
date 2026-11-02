# Profile and label conformance evidence review

Reviewed 3 November 2026. **Current-dev native completion remains unverified.** This review
identifies existing production bindings and the missing observations; it reports no passing
acceptance, product assertion failure, flaky case, or completed Library Goal clause.

## Source and execution boundary

The clean controller-bound source was `4018fd28cd11092d55f4d14fc35dd482a05d3c39`.
The observed local `dev` and `origin/dev` refs both named
`cd29239f653033662b56e8b7e553f753b7db878d`. These are different revisions: no merge,
cherry-pick, fetch or source retargeting was performed. A path-limited diff found no changes
between them in the two outcome wrappers or their profile/label native drivers. That does
not establish equality of their dependencies or execution on the newer dev revision.

The launch's final minimal-verification policy overrides the earlier request to execute
acceptance. No acceptance/native/browser/root/worker/remote check was started, no check
UUID exists, and no promotion proof was registered. Main promotion remains parked.
Only this report changes in the worktree; no workspace code or tests change, so there is
no changed workspace to type-check and no changed test file to run.

The exact deferred commands, from the worktree root, are:

```sh
bun run --cwd services/kernel check test/library/profiles-outcomes.test.ts
bun run --cwd services/kernel check test/library/labels-outcomes.test.ts
```

For **each command**: execution = not started; exit = unavailable, not zero; persona/case
results = unmeasured; runtime log/evidence path = none. These are supported owning commands,
not successful command receipts. Preserve configured Kernel placement and runner-owned
preparation; do not unset `KERNEL_CHECK_REMOTE`, run Bun directly on the specifications,
or substitute a different backend. [Kernel package scripts](../../services/kernel/package.json),
[owning runner](../../services/kernel/scripts/check.ts) and
[check placement](../development/verification.md#check-placement) define that boundary.
The integration owner must record the actual dev commit, commands, exits and runner-returned
artifact paths when execution is authorized. No historical log was supplied by this launch.

## Existing evidence and native bindings

The [Library Goal](../goals/library.md#done-when) requires:

> Owners manage exclusive states, independent labels, copies/holdings and every supported progress mode, including
> rereads and noncontiguous completed units. Clearing one personal fact preserves other facts and their Library
> presence under the existing authority. Stored subject references and accepted profile meaning remain intact.

> Definition-driven Library profiles work consistently across compatible subject types, release changes and historic
> reads/Undo. Generic labels and curated edits need no invented profile or state.

These are clauses 2 and 3, respectively. Every row below remains missing current-dev native
evidence for one or both clauses, including the apparently bound cases.

The discoverable [profile wrapper](../../services/kernel/test/library/profiles-outcomes.test.ts)
imports the original [37 profile tests](../../specs/library-profiles-outcomes.test.ts);
the [label wrapper](../../services/kernel/test/library/labels-outcomes.test.ts) imports the
original [29 label tests](../../specs/library-labels-outcomes.test.ts). Each sets an absolute
native-driver path; the original specifications require the factory and close each fixture.
They do not supply a missing-driver pass.

The shared [native world](../../services/kernel/test/library/support/outcome-driver.ts)
uses Auth provisioning/consent, signed credentials, actual suspension, `createKernel`,
Access, isolated native databases and an owned executor. The
[profile compiler inputs](../../services/kernel/test/library/support/native-conformance-profiles.ts)
go through `compileCatalogue`, mixing bundled Book/edition/anime definitions with data-only
game, recipe, record, inheritance, absence and manifest-expansion scenarios. Profile tests
publish and activate releases through the Definitions APIs. The
[profile adapter](../../services/kernel/test/library/support/native-profiles-driver.ts)
calls `createLibraryProfileMigrationRuntime(...).start/resume`; it does not model migration.
The [label adapter](../../services/kernel/test/library/support/native-labels-driver.ts)
maps fixture operands to actual HTTP commands and calls `purgeLabelRetentionPage`.
These are source facts, not observations of a completed run.

Earlier evidence is narrower or older:

- [API acceptance gaps](api-acceptance-gaps.md), at
  `bc6c7eba7976422220c2fec1e572b9dce03ecd98`, explicitly ran no product suite.
  Its unbound/partial classifications and proposed journeys cannot certify these newer wrappers.
- [Terminal implementation review](library-terminal-native-implementation-review.md), at
  `cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f`, identifies cleanup requirements but
  predates the current bindings. Its missing-runtime conclusion is not a current run result.
- The [Goal's acceptance inventory](../goals/library.md#acceptance) already names historical
  DATA/receipt restoration, type/privacy fixtures, cleanup observations, migration instrumentation
  and internal-pool attribution as deferred. Its compiler-only stage is not native evidence.
- [Profile runtime acceptance source](../../services/kernel/test/library/profile-migration-runtime.test.ts)
  contains a real pre-profile native-command fixture, default worker, commit-boundary faults,
  concurrent writer, retained-copy restore and terminal-owner refusal. The retained copy is
  restored with the captured legacy digest. This is a useful existing repair seam, not a run
  in this attempt and not a replacement for the original outcomes.
- [Copy compatibility tests](../../services/kernel/test/library/profile-copy-compatibility.test.ts)
  retain old receipt semantics; [released profile cases](../../services/kernel/test/library/released-profile-user-cases.test.ts)
  explicitly distinguish their bundled world from the complete custom-profile suite and from
  two genuinely changed/retired bundled releases. Neither closes that missing measurement.

Some implementation-inventory prose in [labels](../library-labels.md#profile-policy-and-implementation-handoff)
still calls HTTP integration unimplemented, whereas the newer Goal and native adapters name
actual routes. Treat that prose as stale inventory, not proof that an endpoint currently fails.
The owner behavior clauses remain authoritative. This review changes neither authority nor API.

## Persona and case coverage, separately

All entries describe authored acceptance coverage. **Executed coverage is zero for every persona.**

| Persona                  | Profiles                                                                                                                                                                                                         | Labels                                                                                                                                                      | Evidence limit                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Owner                    | Compatible game/recipe/record/Book/anime, inheritance, changed/removed IDs, pinned reads, scalar/cursor/completed modes, exact decimals, sparse units, holdings, independent facts, migration/replay/concurrency | Independent labels/state/session/holding/follow facts; cap and duplicates; rename/delete/CAS/Undo; Everything support; private/public Collection separation | Neither command ran; full inspections and historical fixture seams remain unavailable below.                     |
| Foreign viewer (`other`) | Private entry denial; no leaked state; current grant revocation is separately exercised                                                                                                                          | Owner partition, foreign-versus-unknown IDs, catalogue/assignment denial, denied mutation                                                                   | Authenticated foreign denial is distinct from anonymous denial; no observed response in this attempt.            |
| Anonymous                | Public release reads; denied private entry; public Collection/log exclusion of pins and private values                                                                                                           | No private catalogue/assignment/mutation; public subject/Collection exposure excludes label facts                                                           | Public row and payload assertions are authored, not whole-store privacy proof.                                   |
| Suspended                | Real suspended credentials deny private entry                                                                                                                                                                    | Suspended reads/mutations deny; no private ID/name in responses                                                                                             | Real fixture suspension is present in source; no measured denial.                                                |
| Terminal owner           | Paused migration, deletion fence, recovery cannot restore erased facts/receipts                                                                                                                                  | Account-deletion barrier blocks writes/replay/cleanup resurrection                                                                                          | Auth account-operation host binding is explicitly unavailable; suspension cannot stand in for terminal deletion. |

Labels additionally use scope-less credentials for the same account and authorization-before-receipt
tracing. Profiles separately revoke owner write/subject-read authority. These are distinct cases,
not implied by a generic private read test. Steward publication is setup, not owner coverage.

## Missing evidence and bounded owner handoffs

The following are source-identified gaps and unmeasured obligations, **not executed failures**.
Reproduction uses the applicable deferred command above with the original assertions. Line
references are to the bound source. Proposals belong to existing owners; none is dispatched here.

### Historical facts, accepted meaning and Undo

Owner clause, [profile consumers](../library-profile-consumers.md#legacy-pin-migration):

> The initial migration only pins pre-profile rows. It does
> not convert a fact from its accepting release to another release.

Owner clause, [profile-aware validation](../library-profile-consumers.md#profile-aware-write-validation):

> Restore rechecks current
> `deleted_at`/`purge_after`/CAS and restores the same historic fact and pin, never current-profile reinterpretation or a
> new fact.

`native-profiles-driver.ts:82–87` throws
`Native Library dependency_unavailable: committed historical pre-profile DATA restoration fixture; current commands cannot mint unpinned facts or old receipts`.
The profile cases beginning at specification lines 158, 452, 467, 569 and 777 therefore
cannot establish legacy values, all 18 mode/unit pairs, decimals, four copy statuses or null
accepting-type provenance with this binding. Retained legacy restoration also remains missing
from complete outcome evidence even though the focused runtime source has a retained-copy case.

User outcome: existing facts, sparse keys, dates, revisions, receipts and accepting meaning
survive migration, release changes and exact Undo. Reuse Commerce's existing Library
profile/migration acceptance owner, with Auth/native-fixture coordination. Likely paths:
`test/library/support/native-profiles-driver.ts`, `support/profile-entry-fixture.ts`,
`profile-migration-runtime.test.ts`, and existing entry/copy retention fixtures under
`services/kernel/test/library/`. Proposed next brief: bind authenticated historical native
command fixtures and original receipt observations, including retained episodes, without a
production legacy-write endpoint, raw fact manufacture, current-profile fallback or changed frozen outcomes.
Keep that fixture binding separate from page/fault instrumentation.

### Migration concurrency, crash recovery and bounded pages

Owner clause, [privacy and scale acceptance](../library-profile-consumers.md#privacy-and-scale-acceptance):

> The 100 examined-source-key allowance is shared across phases in one transaction;
> changing phase does not reset it.

> Assert at most 100 owner facts per transaction,
> constant bounded checkpoint work, exact-row CAS, unchanged user revisions/timestamps/values/history/receipts, restart
> after both sides of commit, concurrent-write behavior, and the deletion fence.

Profile specification lines 858–985, 1029 and 1111 require those observations. The adapter's
`pauseNextMigration`/`crashNextMigration` throw for the requested persistence boundary;
`inspect().migration.pages` throws
`Native Library dependency_unavailable: native migration page transaction and EXPLAIN observations`.
The real runtime loop alone supplies neither page measurements nor proof of a racing writer.

User outcome: migration makes bounded resumable progress without losing a concurrent edit,
skipping pending phases, or reviving deleted data. Reuse Commerce's profile migration owner.
Likely paths: `services/kernel/src/library/profile-migration-runtime.ts`,
`profile-migration-page.ts`, and their existing test/fixture counterparts. Proposed next brief:
connect existing native before/after-commit fault seams and page observations to the driver;
retain actual transaction keys, CAS decisions and all-phase raw-key charges. Reuse the focused
runtime fixture; do not derive pages from expected counts or change the production algorithm speculatively.

### Compatible types, progress, releases and independent facts

Owner clause, [profile-aware validation](../library-profile-consumers.md#profile-aware-write-validation):

> Progress must use one of `scalar_amount`, `cursor_position`, or `completed_units`, and an allowed exact mode/unit
> pair. Pair metadata is read as data. The algorithms remain those three kernel algorithms.

Owner clause, [label model](../library-labels.md#model):

> A label assignment does not set or clear
> the entry state, start a session, create a holding, follow a subject, grant an entitlement, or assert a separate
> presence or hide preference.

Profile cases at 202–396, 482–568, 581–648, 656 and 990–1110 cover data-driven
verticals, sparse sets, accepted pins, release changes and independent facts. Label cases at
132, 171, 201, 446, 486, 537 and 813 cover independence and unprofiled admission.
The 37/29 authored tests do not establish consistent runtime behavior without execution.
In particular, label `inspect()` unconditionally evaluates an unavailable cleanup observation
at `native-labels-driver.ts:209`; profile `inspect()` reaches unavailable page observations
even if its receipt list is empty. Those exceptions prevent complete snapshots, not just the
cleanup-specific assertions. Nonempty profile receipt inspection throws earlier at lines 226–228.

User outcome: each supported subject accepts only its declared values, old facts stay readable,
and clearing one fact preserves others and Everything membership. Reuse the existing Commerce
label/profile conformance owners. Likely paths: the two native drivers, `outcome-driver.ts`,
and existing production entry/session/copy/label command consumers only if a reached assertion
demonstrates a defect. Proposed next brief: bind complete native inspections and original
receipt status/key observations, then run the unchanged wrappers. Do not duplicate those
cases, replace required fields with empty values, or declare a product repair before an assertion fails.

### Privacy, hidden types and authorization order

Owner clause, [profile authorization](../library-profile-consumers.md#authorization-receipts-and-replay):

> `other`, anonymous, and suspended personas cannot infer a private fact, value, profile pin, accepting type,
> or migration state.

Owner clause, [label privacy](../library-labels.md#privacy-and-disclosure):

> Label definitions, names, assignments, revisions, cursors, and receipts are private owner data.

Profile cases 403–450 and 674–775, and label cases 240–344, 502 and 846 require
actual persona responses, receipt ordering and public-store inspection. Profile receipt and
import-run observations remain unavailable; label Collection grants/outbox/work observations
remain unavailable. The label hidden-unprofiled fixture explicitly throws
`Native Library dependency_unavailable: semantic subject read revocation source`.
The profile helper does issue real grant revocation; that is not proof that every Semantic
primary-type/privacy fixture or public payload inspection is bound.

User outcome: outsiders learn no private fact or accepting type, hidden subjects stay hidden,
and denied callers never probe a receipt. Reuse Commerce's conformance owner, Semantic's
subject/type/privacy fixture owner and Access's existing authorization owner. Likely paths:
`test/library/support/native-{profiles,labels}-driver.ts`, `native-conformance.ts`,
`outcome-driver.ts`, and existing Semantic test support. Proposed next brief: bind the
producer-owned visibility/type operation plus exact native Access/receipt trace and public/private
inspection locators. Preserve raw requests and real admission; no policy map or fabricated empty store.

### Ordinary label cleanup and terminal exclusions

Owner clause, [profile lifecycle](../library-profile-consumers.md#profile-aware-write-validation):

> Account deletion is terminal at fresh authentication plus typed confirmation time `T`.

Owner clause, [labels](../library-labels.md#model):

> Definition undo within 720 hours restores metadata and ONLY unchanged, independently live reservations.

Label cases 571, 598, 644 and 1044–1205 require immediate hiding, unchanged-claim
Undo, retained identity, stale purge safety, bounded cleanup and crash recovery. The label
adapter has a real retention-page call, but cleanup run identity, captured assignment-purge
latch, post-commit/pre-ack pause and worker restart observations explicitly throw. Both
drivers' account deletion delegates to `native-conformance.ts:136`, which throws
`Native Library dependency_unavailable: Auth account-operation approve/execute host binding (not a kernel account-delete route)`.
No terminal API journey or complete private-payload cleanup was observed.

User outcome: deletion hides immediately, ordinary Undo restores only eligible identity,
and terminal cleanup erases the owned graph without resurrection. Reuse Accounts/Auth's
account-operation host owner and Commerce's label retention owner. Likely paths:
`services/auth` account-operation test support, `test/library/support/native-conformance.ts`,
`native-labels-driver.ts`, `src/library/label-retention.ts` and its existing worker tests.
Proposed next briefs: bind the real approved Auth deletion host separately from label retention
run/page/fault observations; do not replace terminal confirmation with a direct kernel tombstone
or create another cleanup implementation to fit a test interface.

### Growth, bytes and full attribution

Owner clause, [profile scale](../library-profile-consumers.md#privacy-and-scale-acceptance):

> Record rows and bytes as well as statement counts.

Owner clause, [label cost](../library-labels.md#mutation-and-cleanup-cost):

> Charge raw source keys BEFORE filters,
> including rejected, internal, lookahead and reread work across every Access, source, catalogue and summary pool.

Profile cases 795 and 823 require unrelated-fact scales 64/512/4096 and 10/100
compiled manifests; label cases 696, 752 and 1206 require deep keysets, three-scale work
and inactive same-subject history. `outcome-driver.ts:1023–1026` refuses internal-pool
activity with `Native cross-pool wire/backend attribution unavailable; refusing incomplete cost evidence`.
Profile wire bytes/affected rows and label affected rows, candidate/peak-memory,
reservation/parent/wire-byte observations also remain explicit unavailable seams.

User outcome: private libraries remain bounded as unrelated and retained data grow. Reuse
the Kernel native measurement owner with Commerce's existing growth acceptance owner.
Likely paths: `services/kernel/test/support/growth.ts`, the shared native world, and the
two adapters. Proposed next brief: instrument actual internal pools and per-page/source work
before rerunning original growth cases. No estimated count, response length, wall time,
missing-pool omission or raised budget substitutes for the measurements.

## Primary-source patterns and recommendation

PostgreSQL's [transaction isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html)
describes statement snapshots and rechecking update predicates after a competing transaction.
Its upstream [isolation-test README](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/test/isolation/README)
uses separate connections, named steps and explicit interleavings; the
[conflicting insert case](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/test/isolation/specs/insert-conflict-do-nothing.spec)
varies commit and abort. Together these support controlled native races, not serial modeled
equivalents. For this repository's Bun/PostgreSQL/DBOS stack, reuse native fixture connections
and existing commit-boundary latches to observe writer/migration CAS and replay.

PostgreSQL's [EXPLAIN documentation](https://www.postgresql.org/docs/18/using-explain.html)
distinguishes emitted rows from scanned work and recommends structured output for tools.
This agrees with the owner contracts' raw-key accounting: retain actual plans, loops, buffers,
filtered candidates and all-pool byte observations rather than equating a short page with
bounded native work. These are design recommendations, not code to copy or acceptance evidence.

The reused clone is
`/home/edge/projects/rezics/rezics-next/.reference/library-shelf-maintenance/postgres`,
HEAD `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; inspected paths are
`src/test/isolation/README`, `src/test/isolation/specs/insert-conflict-do-nothing.spec`
(read with `git show` because the working tree is sparse), and `COPYRIGHT`.
Upstream is [postgres/postgres](https://github.com/postgres/postgres), under the
[PostgreSQL License](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT).
No clone code was installed, built or executed. Its reuse was added to the shared
`.reference/INDEX.md`, the only outside-declared-path write, as required source registration.
REZICS sources cited above are repository-owned primary sources under [AGPL v3](../../LICENSE).

The manager can adopt the existing-owner binding/measurement briefs above, then obtain one
unaltered native outcome run on the integrated dev commit. Until that run, distinguish
**missing bindings**, **missing measurements** and **policy-deferred execution** from both
product assertion failures and infrastructure failures. This attempt observed neither of
the latter and supplies no flakiness diagnosis or baseline-pass comparison. No continuation
was enqueued, no implementation was started, and no owner decision was adopted by this report.
