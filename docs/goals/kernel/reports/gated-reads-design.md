# Gated reads: one admission rule for rankings, public and private Content search and private contribution search

Design pass, 2026-10-12 (read-only analysis, Sol), against `3c6b150b1f02`. Line numbers refer to that tree; relocate them after intervening merges. The rule and the per-gate admissions below are a design, not a verified implementation. The class (A) and the order of work are Program's.

RESULT: done

CASES: Read-only design completed for rankings, public Content search, private Content search and private contribution search, including Realm ranking admission and `/health/search-ready`.

Adopt the proposed rule with one qualification: **the projection must supply a consistent read cut; its current checkpoint does not always prove one.** Serve the complete admitted population at that cut, with additions awaiting projection absent. Before delivery, apply current owner removal and authorization checks to the read’s bounded dependencies. Exclude an affected item before ordering, pagination and counts, or return typed incomplete for the affected scope when safe exclusion cannot be proved. Unrelated writes and unprojected additions never invalidate admission. Preserve recovery, lineage, generation-integrity and Access delivery fences. A captured snapshot grants no authority, and hidden items contribute no results, counts, facets or continuation hints.

1. **Read rankings**

   **Today:** `services/main/src/modules/rankings/projection.ts:349` checks generation-wide retained failures, progress and Review heads, coverage, epochs and lag. Retained failures refuse immediately; ordinary source lag can refuse after 60 seconds. These checks protect retained-event integrity and freshness. Current visibility is separately checked through the admitted index, graph publication and disclosure checks in `services/main/src/modules/rankings/read.ts:65`.

   **Smallest admission:** Read candidate rows and their published revision in one Access statement snapshot. Bind ordering and continuation to `(generation, context, metric, interval, bucket, published revision)`, where context is the Realm or global context. The existing seek index already begins with these population dimensions: `services/main/migrations/access/1031_admitted_read_rankings.sql:20`. Removal checks use exact Work/context dependencies and existing Access scope/governance ownership.

   Simply removing `retained_pending` is unsafe as a completeness repair: successful targets commit past failed targets, while the reported coverage position stops before the first failure (`services/main/src/modules/rankings/projection.ts:273`, `:326`). Publish a materialization revision that honestly identifies the applied state; do not describe those rows as a complete source prefix. Keep the current `exact-page` count with `total:null` (`read.ts:198`).

   Failed additions remain pending without closing admission. A pending removal either updates/excludes the affected admitted population or makes only the relevant population incomplete. Retain live disclosure checks for selected Works.

   **Realm Best/Top remains globally gated:** `services/main/src/modules/rankings/realm-threads.ts:158` still requires exact Content/Main coverage, no unindexed reply/discussion anywhere in the epoch, and no nonpopulation dirty job anywhere. The stream-position repair removed a position-domain error; it did not scope these predicates.

   Use `(data epoch, Realm, population, sort, period, published revision)`. Existing `realm_thread_state` is Realm-keyed; reference indexes support exact reply, Work and parent lookup (`services/main/migrations/access/1038_realm_thread_ranking.sql:37`). Preserve population initialization, private-history admission and period-expiration correctness. Once established, an addition extends a later revision without closing the existing population. Publish reference, root aggregate, order and revision together.

   Launch’s thread reads should use the same owner rule, narrowed to `(Realm, root/parent, population)` where possible. `services/main/src/modules/realm-reply/thread-store.ts:72` currently repeats the global gate. Register removal effects at the authoritative transition, before acknowledgement; discovering them later through replay leaves an unsafe gap.

2. **Public Content search and search readiness**

   **Today:** `services/main/src/modules/content-publication/search.ts:153` requires eligible and physical Content-unit counts to equal the whole current public inventory. `:165–170` requires the global Content cursor to equal its owner; `:284–290` rejects global movement. This protects against missing or stale units, but treats additions and removals alike. The audit also scans the corpus again whenever its global qualification key changes.

   **Smallest admission:** Reuse the existing native generation-qualification owner, consumed by `services/main/src/modules/work/search-readiness.ts:249`, and read one qualified, consistent native cut. Remove whole-inventory equality and global Content catch-up from request admission.

   Before searching, the physical scope is the **index generation**. After searching, the safety scope is the **entire bounded phrase-candidate relation**, keyed by resource, variant, exact revision, publication/eligibility decisions, parent Work/Book and Rights assessment. These identities already occur in `search.ts:223–240`.

   Preserve current-head joins, erasure exclusions, parent disclosure and Rights filtering. Add an exact Content-owner availability fence for candidate revisions; `services/content/src/core.ts:1023` supplies an indexed batch of at most 64 revisions. For other pending removals, consume the existing owner’s exact eligibility/removal decision. The bounded variant evaluator is useful, but cannot be reused unchanged: `services/main/src/modules/content-publication/eligibility-state.ts:657` still ends with a global snapshot fence at `:720–724`.

   Filter the **full candidate relation** before counts or pagination, as `services/main/src/modules/disclosure/search.ts:14` already requires. `complete:true` then means complete for the admitted projection cut after current safety exclusions. Exceeding the candidate budget must remain an explicit failure.

   `population` needs a contract change: its current value is whole public-current inventory before viewer disclosure (`search.ts:78,296`). Native physical public-unit population is not a valid substitute. Remove the audience-facing field or give it an accurately scoped, qualified meaning; retain physical population for operational qualification.

   `/health/search-ready` should return 200 for a usable qualified cut and report owner lag as `indexing`. Retain 503 for recovery hold, uncertainty, invalid profiles or absence of a usable qualified generation.

3. **Private Content search**

   **Today:** `services/main/src/modules/content-publication/search-private.ts:42` rejects any active private writer; `:105–109` rejects any intervening writer. This protects the separate posting and phrase probes against mixed index commits. The exact posting/body/language checks at `:78–103` prevent a missing posting from becoming a false complete miss.

   **Smallest admission:** Scope index integrity to `(resource, variant, captured revision, Content owner epoch, index generation)`. `ContentCore.readDraftHead` already performs an exact resource/variant lookup (`core.ts:575–586`). Use one native exact-unit probe that validates the posting and evaluates the phrase on one committed reader.

   Preserve the existing resource/principal Access lease and delivery owner: `services/main/src/modules/search-disclosure/content-read-lease.ts:43` explicitly reuses the contribution lease ledger. Its scope/principal pending probes have partial indexes and admission caps; no new revocation ledger is needed.

   A newer additive draft head should not invalidate a still-authorized, available captured revision. Make that snapshot meaning explicit rather than retaining newest-head equality as an availability gate. Erasure, withdrawal or loss of authorization for the captured revision still excludes delivery or yields scoped unavailable.

4. **Private contribution search**

   **Today:** `services/main/src/modules/contribution/search-private.ts:64` uses the same global writer fence. `:150–152` checks it again alongside the exact contribution head. Source, projection and posting checks at `:104–148` protect the complete zero-or-one result.

   **Smallest admission:** Use `(contribution, captured draft revision, index generation)` with the same exact-unit native probe. The current-head query already binds the contribution (`:79–82`). Retain `contribution:read:<contribution>`, principal and selected proof/grant checks through `services/main/src/modules/access/admission.ts:671`.

   Preserve Access’s existing race semantics: closure before arm denies delivery; a delivery armed first remains pending until it settles. `services/main/src/modules/search-disclosure/private-delivery-fence.ts:64` owns that boundary. Index snapshots must not create another authorization decision.

The **three search families share native reader capture**; both private families additionally share the exact-unit probe and existing Access lease mechanism. Rankings use Access statement snapshots and population revisions, following the same admission rule.

Native work is necessary. `infra/jena/command-module/src/main/java/com/rezics/jena/FilteredGraphTextIndex.java:1235` opens a reader for each text query. `infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java:792` starts broad writer epochs before update work, while `infra/jena/command-module/src/main/java/com/rezics/jena/SearchDeltaJournal.java:1013` relies on the epoch to establish RDF/Lucene agreement.

Extend that owner with a **short publication/capture critical section**, covering real commit and bounded qualification publication. Capture the RDF read transaction, committed Lucene reader and qualification together, before Fuseki starts an automatic query transaction. Release the capture lock before executing the bounded query; pass the same reader through nested proof helpers. Retain whole-command writer serialization separately. Locking reads behind the existing whole-command monitor (`CommandService.java:674`) would preserve traffic-dependent delay. Use one native request or copied bounded facts, without introducing cross-HTTP historical TDB sessions.

These are proposed composition changes, not verified implementation results. [Lucene’s committed-reader API](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/index/DirectoryReader.html) and [PostgreSQL snapshot semantics](https://www.postgresql.org/docs/current/transaction-iso.html) support the underlying primitives; they do not prove this composition.

Each implementer’s one-line check:

| Surface | Acceptance check |
|---|---|
| Read rankings | Pause after population capture; unrelated context/metric/bucket writes and pending additions still return 200; an affected removal is absent or makes only that population incomplete. |
| Realm rankings/threads | Dirty Realm B between establishment and reading A: A returns 200; remove an A placement or aggregate dependency: A excludes it or returns scoped incomplete. |
| Public Content | Unrelated Content/private/receipt writes during capture and final admission return 200; remove a candidate or parent and verify absence from results, total, facets and continuation. |
| Search health | A qualified cut with pending additions returns 200/indexing; recovery or unqualified generation remains 503. |
| Private Content | Keep another unit’s writer active through hit and miss delivery; both succeed, while captured-revision removal or pre-arm closure withholds the frame. |
| Private contribution | Repeat that race for another contribution/principal; selected-unit damage never becomes complete zero, and revocation retains Access pending-delivery semantics. |

Scale acceptance must measure actual rows visited and native work across growing unrelated inventories. Use keyed lookups and bounded batches, never a global dirty count, corpus audit, rejected-prefix walk or synchronous fan-out to every Realm. Large removal propagation stays resumable behind the owner’s committed scope fence. Also replace the surrounding dataset-sequence admission/cursor dependency where needed: `services/main/src/modules/work/read-session.ts:392` can otherwise reject unrelated graph movement after the inner gate is repaired.

Implementation estimate: **6–8 worker sessions**, not measured—two for native capture/probe and concurrency proofs; one for both private adapters; one for public Content/count/health; one for read rankings; one coordinated launch session for Realm placement/thread admission; up to two for contract and scale follow-through. Rankings and Main adapters are Main-side changes; search capture requires a native build. Wrong resource, parent, Realm, principal or grant keys can disclose removed material. A mixed cut can certify a false zero; filtering only a page can certify false totals.

COMMITS: none; no repository changes.

CHECKS: Protocol, staged evidence and source inspection; primary API documentation reviewed; `git status --short` clean. No QA run, as specified.

OWNER CHANGES: none.

PROPOSED TASKS: Dispatch native capture/probe first; migrate both private adapters together; implement public scoped admission/count/health; implement ranking population cuts; coordinate Realm/thread changes with launch. Run future implementation QA through `bun scripts/goal/goalctl.ts test`.

BLOCKERS: none for this design pass. Native composition, count-contract changes and scale acceptance remain implementation proofs.

NEXT: kernel-sonnet to assign those steps with the acceptance checks above and share the Realm admission rule with launch.

## Additional consumer of the consistent capture: Zone browse reconciliation

Added 2026-10-12 from Launch's relay gap recovery. The Zone browse reconciliation (a hole or a late batch reconciled from the authoritative graph at a validated cut) keeps being invalidated under sustained unrelated writes: after three invalidations it waits 30 seconds, shows `waiting-for-cut` (bounded, observable, reads unavailable). It completes under continuous writes only with the scoped consistent capture: it is a consumer of the native capture step, with the Zone's own scope (Zone, mounted resources) as the capture key instead of a global cut. The implementer of the capture step lists it in the acceptance table (unrelated writes during reconciliation do not invalidate its cut).
