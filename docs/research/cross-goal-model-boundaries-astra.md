# Mathematical boundaries in the REZICS product model

Independent desk research, 2026-11-11. This report proposes decisions; it is not an adopted contract or native acceptance. The inspected checkout reported `202e92cd0c72eca2b72a49da7601447d0c38cacb` during the audit. No product code was changed. The separate work/reference/Concept/book report was not read or repeated.

## Recommendation

Keep the shared statement representation and permanent original identities. Strengthen the mathematical contracts between them and their consumers. The most important problems are not a missing universal graph engine: they are graph constraints that do not survive composition, projections that lose value meaning, and derived views whose reduction or completion rules are stronger than their available evidence.

The investigation does not establish a common cause for recent Web, Search and Imports failures. Those failures are useful counterexamples to treating a command acknowledgement, a process startup or one ready producer as an end-to-end result.

| Rank | Finding | Evidence and confidence | Decision enabled |
| --- | --- | --- | --- |
| 1 | Declared graph constraints have no identified native enforcement and are not closed under Context overlays or identity merging. | High confidence in the source/contract gap; mathematical counterexamples are decisive; native write acceptance was not executed. | Define the graph on which each invariant holds and the owner/coordination needed to maintain it. |
| 2 | Exact and uncertain values become simpler values at the Search projection boundary. | Confirmed pure counterexamples for decimal rounding and time uncertainty; source-backed year-numbering mismatch. | Preserve semantics in projections, or return unsupported/unknown before comparison. |
| 3 | Canonical identity does not specify how personal facts combine; current consumers use materially different rules. | High confidence in documented differences; clear-state resurrection follows the adopted reduction rule, not a newly executed native journey. | Adopt an explicit reducer and deletion meaning for each fact family. |
| 4 | Exact nonmonotonic results and immediate cross-home privacy require a real completeness boundary; bounded local probes do not create one. | High confidence in the information requirement; the current owner explicitly says native feasibility is unproved. | Select a realizable consistency/topology tradeoff before extending the proof protocol. |
| 5 | A selected acquisition and a complete source snapshot are different mathematical objects, but the importer generation boundary is source-wide. | Source-backed structural risk; the existing shared-selection repair demonstrates its operational consequence. | Make the domain of disappearance explicit without changing claim identity or sealed retry intent. |

Repair rank 2 first because it is small and independently testable. Resolve ranks 1 and 3 before promising that arbitrary released relations and canonical personal views compose correctly. Rank 4 needs a narrow native feasibility experiment, not another large interface design.

## The distinct objects the model needs

The [architecture](../architecture.md) correctly separates semantic vocabulary, generic behavior, authoritative writes and derived indexes. The useful next refinement is to name the mathematical object at each boundary:

| Object | Meaning | What it does not establish |
| --- | --- | --- |
| Permanent original ID | Identity of a retained catalogue record or personal reference | Current equivalence, disclosure or ownership |
| Canonical map `q_t : S -> C_t` | Current partition of originals into equivalence classes, with a chosen representative | A conflict policy for facts in the same class |
| Assertion | A qualified, sourced claim about original identities | Acceptance, selected truth or publication |
| Selected graph `G(context, release, t)` | The effective assertions after selection, inheritance and suppression | That a declared graph invariant survives another overlay or quotient |
| Derived projection | A computation over an identified source/meaning version | Current authority, complete coverage or exact representation of every admitted value |
| Command intent and receipt | One addressed operation and its acknowledged effect | The current value after subsequent commands or downstream completion |
| Observation | A value together with its source, meaning, coverage and currentness basis | A reusable permission or an ordering across unrelated sources |

A shared storage shape is valuable. It does not make all relations share an algebra. Set union, ordered occurrences, last-write registers, existential support, equivalence classes and directed acyclic graphs have different laws. The [Library contract](../library-and-collections.md) already recognizes some of these differences: labels are unioned, copies and sessions remain separate, and curated occurrences preserve multiplicity. That is the right direction.

## 1. Graph validity must survive selection and identity operations

### Evidence

The [Semantic relation contract](../../services/kernel/src/semantic/README.md#relation-properties) says an `acyclic: true` relation forms a DAG and a cycle-closing write is refused. Released definitions carry this flag, including `schema:isPartOf` in [anime.yaml](../../packages/definitions/catalogue/anime.yaml) and several order/derivation relations. The [portable relation type](../../packages/definitions/src/portable.ts) and definition compiler validate and preserve the annotation.

A bounded production search for `acyclic`, `relation_cycle` and `cycle_detected` found no Kernel implementation consuming the annotation. The inspected [proposal validator](../../services/kernel/src/semantic/candidate-proposal.ts) checks a statement's released shape and targets. The [adoption command](../../services/kernel/src/semantic/candidate-adoption.ts) checks selection, local slot multiplicity, acceptance and publication effects, but has no graph-reachability or acyclicity check. Definition tests confirming that the flag exists do not establish runtime enforcement. This is strong evidence of a missing implementation, not proof from a live API attack.

More fundamentally, local edge validation alone would not close the model:

1. **Overlay:** Global contains `A -> B`. A community contributes `B -> A`. Each contribution considered alone is acyclic; the effective inherited graph is not.
2. **Quotient:** A valid graph contains `A -> B -> C`. A duplicate-identity merge identifies `A` and `C`. The canonical graph contains `q(A) -> q(B) -> q(A)`. Acyclicity is not preserved by arbitrary vertex identification.
3. **Concurrent edges:** Two transactions, on different subject partitions, each observe no path and add `A -> B` and `B -> A`. Serializability inside each separate owner partition does not serialize their shared graph invariant.
4. **Mixed relation families:** A property marked acyclic does not say whether a cycle mixing that property with its inverse alias, another subtype of the same relation, or another composition property is prohibited. Display group `membership` is not a sufficient semantic definition of that closure.

The [identity contract](../../services/kernel/src/semantic/identity-epoch-contract.md#invariants) deliberately preserves originals and changes derived mappings. Its bounded group checks are necessary for identity publication, but group cardinality and mapping correctness do not establish validity of the resulting relation graph.

### Proposed decision

For every hard graph constraint, state:

- the selected Context and inheritance semantics;
- the relation family and orientation included in the constraint;
- whether vertices are original records or current canonical entities;
- the boundary at which the invariant must hold: proposal, adoption, publication or merge;
- the native owner of its validation and concurrent mutation fence.

Unselected, conflicting source assertions should normally remain representable. Enforce a selected-graph invariant at the selection/publication boundary, rather than rejecting provenance merely because another source disagrees. A merge must either preserve each hard invariant, wait for an explicit resolution, or publish a typed relation conflict. It cannot silently assume that quotienting a DAG produces a DAG.

There are three viable implementation families:

| Strategy | Benefit | Cost or restriction |
| --- | --- | --- |
| Bounded relation family with one authoritative scope | Small native validation and serialization boundary | Product must define a real scope/depth/size bound; a generic global graph cannot inherit it by declaration. |
| Maintained reachability/topological structure | Fast common admission and reusable constraint evidence | Insertions, deletions, overlays and identity changes require maintained dependencies; worst-case relabel/repair is not constant. |
| Prepared validation and explicit pending publication | Fits existing durable bounded work | Requires a final mutation fence and retained progress; publication latency is visible. |

A graph database would not remove this choice. Nor does a recursive query with a response `LIMIT` prove bounded reachability work. First decide whether every existing `acyclic` annotation is a hard integrity rule or only a warning. A soft rule must not retain the current promise of refusal.

### Decisive experiment

Use one existing released acyclic relation and three admitted subjects. Exercise sequential closing-edge adoption, concurrent opposite-edge adoption on two native partitions, a Context overlay, and endpoint merging of a two-edge path. Read the selected forward and inverse views independently. Any accepted cycle with no declared conflict falsifies the hard-DAG contract. This small case should precede growth testing or a new reachability subsystem.

## 2. Value-preserving storage is undermined by lossy query projections

### Executed evidence

The [Wikidata admission contract](../../services/kernel/src/semantic/README.md#wikidata-time-and-quantity-value-admission) preserves exact decimal strings, quantity bounds, calendar model, time precision and optional uncertainty. In contrast, [Search's `FacetValue`](../../services/kernel/src/search/source.ts) stores a quantity amount as `number` and a time as an astronomical `CalendarDate`. [Normalization](../../services/kernel/src/semantic/scope-leaf-selection.ts) calls `Number(content.amount)` and retains only year/month/day for time. Quantity qualifiers use the same conversion.

A small local probe called the real calendar adapter and current Search matcher. It reproduced the exact `Number` conversion performed by normalization; it did not run the effectful normalization module or a native index:

| Input and question | Observed result | Mathematical issue |
| --- | --- | --- |
| Exact amount `1.0000000000000001`; `amount <= 1` | Projected amount `1`; matcher returns `true` | The stored number is strictly greater than 1. |
| `2024-06-15`, day precision, `before: 1`, `after: 1`, versus zero uncertainty | Both project to `{year:2024, month:6, day:15}` | Distinct information becomes identical evidence. |
| That uncertain date; possible match on `2024-06-14` | `false` | The uncertainty interval was discarded before interval comparison. |
| A date known only as year 2024; June 2024 range | `true` | This is a *possible* answer, not proof that the event occurred in June. |
| Wikibase JSON date `-0001-01-01`; native calendar projection | `year: -1` | The source uses historical BCE numbering; the target type declares astronomical numbering. |

The probe is `.temp/cross-goal-model-boundaries-astra-probe.ts`, executed once with Bun. Its first two failures are independent of database size, index freshness, authorization and importer batching.

The [list-presentation adapter](../../services/kernel/src/semantic/list-presentation.ts) already rejects lossy decimal round trips before using the Search formatter. Applying that protection only to presentation lets the displayed value and the predicate disagree. The exact-spoiler reader in [the filter package](../../packages/filter/src/filter.ts) also deliberately avoids numeric rounding; the generic quantity path has no equivalent protection.

The canonical [Wikibase JSON documentation](https://doc.wikimedia.org/Wikibase/master/php/docs_topics_json.html) specifies historical BCE numbering, quantity uncertainty bounds, and time uncertainty fields. It notes that the latter fields are currently unused upstream; REZICS nevertheless explicitly admits nonzero values. The [conceptual time model](https://www.mediawiki.org/wiki/Wikibase/DataModel#Dates_and_times) explains uncertainty in units of the stated precision. These sources support preserving or rejecting the fields, not silently narrowing them.

### The missing distinction: possible and certain answers

For a value represented by a possible-value set `U` and a query interval `R`:

- possible match: `U intersects R`;
- certain match: `U is a subset of R`;
- certain nonmatch: `U intersects R` is empty;
- otherwise the evidence is indeterminate for a certain-answer query.

The current [calendar contract](../../packages/filter/README.md#grammar) intentionally chooses overlap. That is a valid product decision. It should be called possible overlap, and `NOT` must be understood as negating that exact predicate. `NOT(possibly in June)` is not `possibly outside June`. This is different from missing data or a failed dependency and should not be left to a UI label or a Boolean negation implementation.

Quantity predicates additionally need to say whether they compare the nominal estimate, an uncertainty interval, or exact discrete values. No unit conversion should happen merely because two quantities are numeric. REZICS's existing independent progress measures correctly avoid such conversion.

### Proposed decision and migration

1. Immediately refuse lossy numeric evidence as unsupported/not-proven at the shared projection boundary; never let a missing facet certify a negative. Reuse a single exact-representability rule for main values and qualifiers.
2. Choose a queryable numeric domain. Bounded decimal strings with exact comparisons or a declared fixed scale can preserve exactness. Safe-integer-only or exactly round-trippable subsets are cheaper initial capabilities. A floating index may be a candidate superset, but exact native postchecks cannot repair candidates that the index already omitted.
3. Preserve admitted uncertainty in a typed interval projection, or mark those values unprojectable. Do not reinterpret them as point values. Define possible-versus-certain filtering explicitly before adding another comparator.
4. Add a source-specific historical-to-astronomical year conversion at the adapter boundary, or retain a tagged numbering system. Preserve the original source lexical value. Do not shift every negative year in generic storage without knowing its source convention.
5. Bump the affected physical projection format, rebuild into a new generation, and keep old generations ineligible for the new semantics. Fixing the matcher alone does not correct stored rounded or narrowed values.

Exact decimal comparison is linear in the bounded lexical length; the admitted native maximum is 127 characters. Interval storage adds a bounded pair of endpoints. These are cheap relative to the existing authorization and projection work. Native engine encoding and sorting still need their own conformance test.

## 3. An equivalence class needs a fact-specific reduction rule

Let `q` map permanent originals to canonical entities. A canonical view of facts is not just `q(facts)`: it is a reduction over each fiber `q^-1(c)`. That reduction determines whether aliases contribute one fact, several occurrences, a conflict, or an explicit absence.

The existing contracts choose different reductions:

| Fact family | Current rule | Consequence |
| --- | --- | --- |
| Library labels | Union | Idempotent set behavior is appropriate. |
| Copies, sessions and curated occurrences | Preserve separate identities/multiplicity | Deduplicating canonical subjects must not deduplicate these facts. |
| Entry state | Highest live `owner_write_seq`, conflicts retained | Physical absence is not a last-write value. |
| Native votes | Survivor's vote or clear takes precedence; otherwise latest changed merged vote | Choice of representative can change the counted answer. |
| Canonical episode completion | Exact canonical IDs; redirected old IDs become unavailable; no automatic transfer | A duplicate merge can make a previous completion unobservable at the current episode. |

Sources: [Library canonical state and write order](../library-and-collections.md#owner-state-write-order), [Rating vote semantics](../../services/kernel/src/rating/README.md#questions-votes-and-populations), and [canonical episode completion](../library-episode-progress.md).

### Concrete counterexamples and decisions

**Clear versus absence.** Original A has `reading` at sequence 1; B has `finished` at sequence 2. After merging, B's state wins. Clear B. The [adopted clear rule](../library-and-collections.md#owner-state-write-order) advances the owner counter but creates no live tombstone; archives do not compete. Under “highest live sequence,” A's older `reading` becomes visible again. The new sequence alone cannot remember the user's cleared canonical state.

This may be intended if the command means “remove this original's assertion and reveal the remaining conflict.” It is wrong if the canonical page promises “clear my state for this work.” The model must select one meaning. For the latter, use an explicit clear value in the canonical register or a clear operation over the captured contributing originals, with currentness and conflict semantics. The former needs an original-addressed editor and feedback explaining the remaining state. Do not silently change tombstone retention or rewrite all original facts as a generic cleanup.

**Identity versus representative policy.** A has vote 2 and B has vote 8 for the same person/question. Merging onto A and merging onto B create the same equivalence class but different counted ratings under survivor precedence. This is an explicit editorial conflict policy, not a mathematical consequence of identity. Keep it if desired, but expose/review that consequence and verify it independently from mapping correctness. A representative-independent reducer would instead select by an authoritative owner vote order, with clear participating as a value; this is a product change, not a free refactor.

**Occurrence evidence versus current canonical ID.** Record completion for Episode A, then merge A into duplicate B. The episode contract deliberately keeps A in history, rejects redirected A for the current checklist, and does not transfer completion to B. The current B checklist can therefore be unmarked despite completion evidence for the same asserted entity. Choose between original-evidence-with-current-canonical-projection and intentionally original-only evidence. The latter should not be advertised as preserving canonical completion across duplicate resolution.

**Undo and split.** A union-find-style destructive rewrite would make unmerge and these corrections much harder. The existing permanent originals and retained occurrence identities are a strength. Keep them; compute current views through an explicit reducer. Semantic defines equivalence and mapping, while the personal-fact owner defines its reducer. Neither should infer the other's policy.

### Proposed algebraic acceptance

For each reducer, name which laws are intended: idempotence, commutativity, associativity, representative independence, preservation of explicit clear, and recovery after split. It is acceptable for an editorial policy to fail one of these laws deliberately; it is not acceptable for tests to assume a law the product did not choose.

Do not introduce one generic merge callback that silently unions every collection. A small table of fact-family rules and a few counterexample cases are enough to guide the existing owner implementations.

## 4. Completeness, currentness and authority are independent dimensions

### What is already correct

[Filtered lists](../filtered-lists.md) correctly says that sampled positive witnesses cannot prove a negative, a complete generation is not a grant, and hidden facts must not influence exclusions or order. [The identity contract](../../services/kernel/src/semantic/identity-epoch-contract.md#scoped-reader-publication-and-complete-query-dependencies) correctly rejects global maximum-epoch reasoning: a lower-numbered job can finish after a higher-numbered job. Scoped committed revision, retained obligations and complete dependency registration are the right conceptual ingredients.

The danger is treating the extensive protocol description as proof that its physical boundary exists. Both owners explicitly identify missing native producers and unproved feasibility.

### The information constraint

A reader sees identical local source and index states in two executions. In the first, no relevant foreign reduction committed. In the second, a foreign reduction committed, but delivery to the reader's local summary is delayed. If the reader neither observes that authority nor relies on a registration/fence that participates in the foreign commit boundary, it cannot distinguish the executions. It cannot safely return an exact current answer in one and withhold it in the other.

Adding a local Boolean `ready`, another local revision, two observations of the same delayed summary, or a signed cursor does not supply the missing information. A complete dependency index can make the check efficient, but its registration and mutation handshake are part of the correctness proof and have maintenance cost.

This is not a claim that REZICS's design is impossible. It is a reason to reopen a precise cost or placement constraint when the required information has no admitted path. The [CALM overview by Hellerstein and Alvaro](https://arxiv.org/abs/1901.01930) explains why nonmonotonic computations require coordination under its model. It does not prove a particular SQL count impossible. REZICS has known partitions, durable work and native transactions, so its actual plan must be measured rather than dismissed by slogan.

### Separate the orders and the states

A source revision, command sequence, definition digest, identity epoch, projection generation, privacy frontier and authentication floor do not form one universal total order. A content hash proves equality of bytes; it does not establish chronological precedence. Receipt arrival order is not commit order. `max(position)` is not a completed prefix when gaps remain.

The source owner may summarize many events into a scalar only after a real serialized state transition accounts for every relevant obligation. That scalar is then local to the source/incarnation/meaning it summarizes. [Timely Dataflow's progress model](https://timelydataflow.github.io/timely-dataflow/chapter_5/chapter_5_2.html) is useful background: partially ordered timestamps and outstanding capabilities explain why “largest value seen” differs from “no earlier work can arrive.” This is a conceptual reference, not a recommendation to add Timely or a new event engine.

Likewise, keep at least these distinctions in owner interfaces:

- semantic unknown versus known false;
- complete observation versus partial observation;
- preparing work with a finite advancing frontier versus unsupported capability;
- dependency unavailable versus a definitive denial;
- acknowledged command versus independently current readback.

Do not replace them with one global state machine. A product state or discriminated operation result is enough. The present `not_proven` result can remain at the Boolean evaluator if the surrounding boundary retains the cause and does not promise automatic progress for an unsupported plan.

### Feasible choices and their prices

| Choice | Read cost | Maintenance or availability cost |
| --- | --- | --- |
| Observe every relevant authority directly | Follows the number of relevant homes/dependencies | Simpler evidence; relaxes a fixed statement/connection ceiling. |
| Complete maintained dependency registration and scoped fences | Small indexed read | Atomic writer integration, inverse routing, bootstrap and repair fanout. |
| Co-locate a named query population or authority boundary | Local transaction/snapshot | Placement constraint, hot-scope contention or migration work. |
| Serve a named immutable published snapshot | Predictable read and reusable preparation | Snapshot semantics must be honest; current privacy reductions still require an effective revocation boundary. |
| Explicitly withhold unsupported shapes | Bounded refusal | Reduced capability; cannot be counted as universal Search completion. |

Do not fund this with another runtime price ledger. Document the chosen static bounds and charge the actual native operations. The fixed response size is not the cost model. For a sparse predicate, no general top-N shortcut guarantees a full page without an appropriate index or preparation. In the adversarial case, any unexamined candidate can be the next match. Existing retained preparation is appropriate; its progress measure must advance on fixed finite input rather than reset on every unrelated change.

### Native falsification before expansion

Use two relevant homes and one excluded or order-only subject. Pause summary delivery after the relevant authoritative mutation commits. Keep returned positive IDs unchanged. The old page and continuation must not succeed. Then allow arm, repair and finish to occur entirely between start/final probes; the changed committed basis must still be detected. Run an unrelated mutation in parallel and verify that a finite unaffected owner scope remains usable.

Only after those cases pass should the owner spend on the 64/512/4096 growth series, varying reduction arrival rate and repair latency as well as catalogue size. A small passing output with unbounded background backlog is not evidence of scalable availability.

## 5. Source snapshot closure differs from acquisition selection

The importer has strong separation between source records, proposal intent, acceptance, adoption and independent current reads. Its immutable request journal is worth preserving. The remaining structural risk is what a complete generation is complete *over*.

[Run storage](../../services/importer/src/run-store.ts) keys `run_sources` by source alias and its current generation, with generation members under `(source, run, record_key)`. [Run options](../../services/importer/src/importer.ts) expose disappearance thresholds and acquisition options but not a first-class snapshot universe. The [importer owner](../../services/importer/README.md#sources-mapping-and-writes) therefore requires a complete generation before disappearance and records a repair where a book-only selection must not replace the earlier shared Bangumi selection.

The mathematics is straightforward. Absence is established by `previous members - current complete members` only when both sets describe the same universe. Given complete `{a,b}`, a later selected acquisition of `{b}` says nothing about whether `a` vanished upstream. A low disappearance percentage is not evidence of completeness either. Raising the mass-disappearance threshold would mask the problem.

### Proposed decision

Represent acquisition mode explicitly at generation admission:

- **Complete snapshot of a declared universe:** may classify disappearance within that universe after sealing.
- **Selected observations/delta:** may update exact named records; omission supplies no negative evidence.

The universe can be the existing whole alias if that is the product's intended scope. If independent selections need independent complete snapshots, retain a stable declared selection/domain identity with the generation. Do not make new source aliases merely to bypass checks: aliases are part of durable claim identity and destination binding. This is an additive generation contract, not a new provenance authority.

Migration should preserve sealed generations and exact pending commands. Mark old generations with their existing full-alias meaning only where that meaning is established; an ambiguous historical partial input must not acquire retrospective disappearance authority. A small SQLite fixture with `{a,b}` followed by selected `{b}`, and separately complete `{b}`, decides the behavior without a live provider.

### Commands and attempts remain different

The same source body can be submitted in multiple delivery attempts while remaining one intent. An uncertain response must replay the sealed key/body; reconversion with newly available bindings belongs after resolving that intent. Conversely, a completed receipt does not prove current publication or that unchanged source bytes have unchanged dependencies. The existing importer explicitly rereads bindings and publication; no broader redesign is needed there.

The separate create-contention symptom has a concrete owner boundary: [identity terminal commands](../../services/kernel/src/semantic/identity-terminal-closure-command.ts) execute inside `withSingleCommandAttempt`, while the importer now serializes identity creates. Native retryability and importer envelope splitting are different concerns. [PostgreSQL's retry guidance](https://www.postgresql.org/docs/16/mvcc-serialization-failure-handling.html) requires retrying the entire transaction decision logic after a serialization failure. A bounded owner retry must reacquire its native observations and preserve uncertain-commit handling; simply increasing HTTP retries or blindly reusing an old admission object is insufficient. This should be repaired in the command owner only after the exact contention path is measured.

## Authority and the recent failure evidence

Identity answers “which original or account is this?” Authority answers “may this current principal perform this operation on this current resource?” They are not interchangeable edges in the graph. A session cookie, an account-agent mapping, a source binding and a verified Actor each establish different facts.

The [Library scoped-search requirement](../library-owner-queries.md#scoped-subject-search-consumption-required-runtime-pending) explicitly names a missing bridge from Search's viewer identity to real verified native authority for durable owner preparation. Preserve that distinction: carry the actual request-owned capability through the application port, and let Access authorize the current operation. Never reconstruct authority from `account:<id>` or from a logical Everything identifier. This is an independent near-term integration repair, not evidence that the identity data model is intrinsically wrong.

For Web, [SessionStore](../../apps/web/src/session/store.ts) intentionally separates local session lifetime from a fresh usable credential. [Session queries](../../apps/web/src/session/query.ts) fetch viewer exposure separately, but the inspected exposure reader catches failures and returns `[]`. That collapses an unavailable authority observation into an apparently empty admitted-action set. It is safe against accidental granting, but loses the product's denied-versus-unavailable distinction. An explicit result should preserve that distinction without making the session payload grant actions.

Retained local observations constrain the diagnosis:

- The earlier page-data run at `1da89b90ca` reached callback acceptance and then timed out in the session phase. Its captured first cause was a Search writer awaiting owner custody, and it also recorded a large client module graph. Neither fact proves which boundary caused the browser timeout.
- The newer run at `078b34666d` records `Member browser sign-in phase=session verified`; public and member Home readers still remained loading. Member Following had a native HTTP 200 while browser execution had not run. This falsifies “failure to sign in is the current common cause.”

Evidence files are `.temp/goal/page-data-failures/1794375107897-check.log`, `.temp/storybook-sections/page-data-capture-1da89b90ca.json`, and `.temp/goal/page-data-failures/1794399385685-check.log`. Only bounded relevant excerpts were inspected. No private credential or personal payload is reproduced here. A supplied older Imports log was absent locally; its reported details were not treated as independently verified evidence.

## Independent near-term repairs

| Owner | Coherent repair | Smallest useful acceptance |
| --- | --- | --- |
| Semantic, Search, Definitions | Make numeric/time projection fidelity explicit and shared; stop lossy comparisons. | Exact decimal just above 1 versus `<=1`; uncertain day; BCE adapter; positive and negated filters. Then one native source-to-index round trip. |
| Semantic | Resolve the hard-DAG contract and its scope, then implement the first actual enforcement boundary. | Closing edge, two concurrent edges, Context overlay and merge-induced cycle using one released relation family. |
| Library, Rating, Semantic | Decide canonical state clear and episode completion semantics; document each fact-family reducer. | Two originals with conflicting state, terminal clear, duplicate Episode merge, representative choice for one voter's conflicting votes. |
| Search, Semantic, Library | Select and prove one complete observation/registration boundary under current native placement. | Two-home delayed-arm and clean-to-clean races plus unaffected-scope progress; no large matrix until these distinguish the design. |
| Imports | Distinguish complete snapshot domain from selected observations at run admission. | Same-alias complete `{a,b}`, selected `{b}`, complete `{b}`, sealed replay and unchanged dependency refresh. |
| Web, Accounts | Preserve unavailable exposure and carry actual verified authority to scoped preparation. | Valid cookie with unavailable credential/exposure, explicit empty grants, current revocation, and a real signed-in reader; keep hydration progress separate. |

These repairs can proceed independently. They do not require new services, a replacement datastore, a generic proof framework or a new global revision counter.

## What would change the recommendation

- A native counterexample showing existing cross-partition, overlay-aware and merge-aware DAG enforcement would remove the implementation-gap finding. It would not remove the need to define the graph to which the invariant applies.
- A released numeric capability explicitly restricting every reachable quantity to the exact projected subset, enforced before publication and for qualifiers, would narrow the decimal issue. No such enforcement was found on the shared normalization path.
- A native migration or typed adapter converting Wikibase historical years before the inspected calendar function would narrow the BCE finding. The inspected admission returns a clone of the original content; the conversion was not found there.
- A product decision that canonical clear reveals other original assertions, and that episode completion deliberately stays original-only, would turn those findings into intentional behavior. Their interfaces would still need to make that behavior clear.
- A native complete-dependency protocol meeting the delayed-arm race and growing-load availability checks within current budgets would settle the feasibility concern. Source declarations, typed ports and positive-hit tests would not.
- A durable importer generation field or upstream admission proof already distinguishing complete universes from arbitrary selected acquisition would remove the proposed generation addition; the existing full-selection orchestrator repair could then simply consume it.

The existing model also has important strengths: qualified statements remain distinct from subjects; accepted release meaning is separate from current recording admission; native votes are not imported provider statistics; publication is not inferred from import; and permanent originals preserve evidence through identity correction. The recommendation is to preserve those boundaries and make their composition laws executable.
