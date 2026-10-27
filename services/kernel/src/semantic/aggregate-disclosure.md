# Current public aggregate disclosure

This is an implementation contract with native failing acceptance, not a claim that the implementation is safe
already. It applies the [deletion policy](../../../../docs/deletion.md) to Semantic's current public numbers.
Stored skeleton aggregates remain internal. Identifiers, types, nonpersonal relations, tombstones and aggregate
storage remain; this work neither schedules deletion nor purges data.

## Disclosure rule

A public number requires current source-safe proof for the **entire counted set**, for this viewer and Context.
Without that proof omit its optional field or property. Do not return null, an unknown-number sentinel, a stale
integer with `exact:false`, a guessed zero, a lower bound, a facet, or a replacement flag encoding the total.
A consumer checkpoint, even `caught_up:true`, proves no absence of foreign revocations. No global revocation
clock, synchronous fanout, new membership authority or cross-home transaction is introduced.

The initial conservative policy omits numbers when the bounded candidate window does not establish exhaustion
from the beginning, or any candidate fails current disclosure. A deep cursor does not establish exhaustion of
its prefix. A genuinely exhausted small set can retain its exact value after the same bounded read verifies
every member. A failed/unknown point proof omits the number; real infrastructure failure retains existing error
semantics. No count-only read may scan or authorize the full foreign degree to manufacture completeness.

Every returned row independently needs current source and target visibility, viewer Access, Context selection
and disclosure, moderation/retraction and tuple fences. An absent number never licenses a stale row. Source
candidate identity/provenance is checked, not merely the subject's label or its old projection revision.
Apply the same obligation to previews and graph edges, including paths with labels disabled. Preserve other
labels and relations. Underfilling a bounded candidate page is permitted; scanning replacements by degree is not.

`next`, graph continuation cursors, session tokens and freshness retain their ordinary meanings. A continuation
can express remaining candidates without claiming an exact public total. Do not add a stronger promise that
traffic, timing or every boolean continuation is independent of hidden data. In particular, do not expose a new
`has_hidden`, `count_omitted_because_hidden` or exact-total-bearing page metadata field.

## Current surfaces and additive schema changes

Use the current names. In `http/subjects.ts` change the code-first declarations, then regenerate OpenAPI and Eden.
Do not hand-edit generated declarations or silently rename `relationCounts` to another field.

| Surface                                                    | Current public declaration / producer                                                                                                                 | Required representation                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/subjects/:id/links?property=…`                    | Optional `count:{value,exact}`; `listSubjectLinks` reads `read-inbound-link-count.sql`, adds private total, or samples `count-inbound-link-types.sql` | Keep optional `count`; omit absent complete current proof, including typed samples. Cross-property pages already omit it.                                                                                                                                                                                                                                     |
| `GET /v1/subjects/:id/relations?property=…`                | Required `count:{value,exact}` in `SubjectRelationsPage` and response; outbound counter plus private total / type sample                              | Make `count?:{value:number;exact:boolean}` and `t.Optional(t.Object({value:t.Integer({minimum:0}),exact:t.Boolean()}))`. Existing proved values keep their shape.                                                                                                                                                                                             |
| Subject read/create/edit response `subject.relationCounts` | Required `Record<string,number>` in `Item`, `resolveItem`, `SubjectSchema`; read previews use 13 candidates and emit 12                               | Keep required map with individual property keys optional: omit unproved keys, retain proved integer entries. Keep the sparse `Record<string,number>` and `t.Record(t.String(),t.Integer({minimum:0}))`; `noUncheckedIndexedAccess` already makes indexed lookups optional. Never serialize undefined values. Command replies need the same disclosure policy. |
| `GET /v1/subjects/:id/graph`                               | `SubjectGraph.truncated[]` requires numeric `count`; `read-graph-expansions.sql` reads internal inbound/outbound counters before traversal            | Make each `count?:number`, `t.Optional(t.Integer({minimum:0}))`; keep node/property/direction/cursor and existing traversal limits. Derive continuations from bounded candidate progress; do not require a public total to issue a cursor.                                                                                                                    |
| Subject summaries and related items                        | `SubjectSummary` contains ID/type/types/label/creativeWork/cover, no count                                                                            | No new aggregate field. Current summary authorization still applies; its success alone does not prove an entire relation set.                                                                                                                                                                                                                                 |

Exact current storage is `inbound_link_count`, `outbound_link_count` and the corresponding
`inbound_link_context_count` / `outbound_link_context_count` deltas (Global plus Context overlay), indexed by
route/subject/property/filter. These and `partition_subjects.visible` remain internal counters. `privateLinks`
currently supplies a separate total; it also needs the same bounded completeness policy before contributing to a
public number. Search source partition counts are internal rebuild/export accounting, not a new public live
subject count. Relation facet witnesses are internal membership hints, not an aggregate disclosure proof.
No storage decrement or destructive cleanup is required merely to suppress a public count.

## Native counterexample

The existing deletion audit creates a visible Person target and a foreign Book with `schema:author` pointing to
it, drains the link projection, and receives exact 1. It then executes the real subject takedown command and
runs no projection/relay. The source summary disappears and the next successful inverse response contains
`links:[]`, `count:{value:1,exact:true}`, `freshness:{consistency:"eventual",target_seconds:10,caught_up:true}`,
`next:null`. This defect exists without any individual DELETE route.

`read-inbound-link-count.sql` reads only the target's stored Global counter plus Context delta; it has no source
visibility, Access, retraction or fence proof. Keeping that stored 1 is correct skeleton retention; publishing it
as the viewer's live exact total is not. The old audit assertion that demands `{value:0,exact:true}` after this
revocation needs later authorized reconciliation to absence of `count`. Its initial exact-1 assertion can remain
only when bounded current complete-set proof is supplied. The audit contract, README and two audit test files
are being reconciled separately and are not edited here.

## Budget and evidence

Charge the existing internal counter point, bounded candidate selection, and every current source/target,
Context, provenance/fence and viewer Access point to the request. Use the existing candidate budgets: inverse
and relation pages select at most `limit+1` (typed pages at most `4*limit+1`); subject previews select 13 per
relation property; graph uses at most 25 per expansion with its existing 500-edge cap. A complete-set proof
reuses only candidates within those budgets. No full-degree count query, type-prefix scan of 1000 rows for a
small page, uncapped private total scan, history fold, offset scan or separate hidden count is allowed as proof.
Counts omitted for incomplete sets require no extra foreign membership discovery. Use point authorization in
the owning partition with existing imports (`request/access.ts`, `eligibility.ts`, `fences.ts`, slot/adoption
readers), releasing connections where existing readers already require it. No foreign locks or transaction.

The native tests use migrated PostgreSQL and `createRealAccess`, actual HTTP writes and source commands. Relay
work is driven explicitly only before mutation; all consumers are paused by not starting background relays.
Takedown is exercised independently of missing DELETE. Hide and candidate moderation are separate cases;
source tuple takedown supplies the native revocation case. Individual contribution deletion is covered when
its owner supplies the route; this contract does not invent lifecycle authority or probe missing routes as a
substitute for the existing regression.

Growth uses the unchanged shared `seed` and capture helpers, degree and unrelated population at 64/512/4096,
one warmup and five repetitions, first and deep pages both with and without a type filter, fixed input and proof budgets. Sources are distinct
foreign IDs with native-shaped revision/fact/link storage; authority mutations use commands, never SQL truth
or fabricated proof stamps. All current proof and Access queries run through the same instrumented owner pool;
any future extra owner pool must use `GrowthDatabase.openPool` so it is charged too. Actual rows and statements
must stay constant and blocks logarithmic. A 404/503 is never a successful measured operation. Compare both
hidden-before-cursor and hidden-after-cursor cases; raw target-local stored total must stay exact while the
public property is absent. Do not alter capture/classification, ignored statements, Cost bounds, planner
settings or timeouts to obtain green measurements.
The typed native page test also rejects the existing thousand-member type sample in captured SQL: passing
aggregate growth bounds against a large fixed authorization baseline does not establish the smaller page proof budget.

## Implementation split and dependencies

1. Current evidence and bounded completeness: reuse `links.ts`, `subject.ts`, `graph.ts`, `slots.ts`,
   `statement-disclosure.ts`, `fences.ts` and `eligibility.ts` imports. Candidate windows must be selected before
   current checks. Produce local proof results only from those current checks; never install SQL proof stamps.
   If existing source/fence ports cannot establish a bounded point, send the exact missing cross-owner contract
   to the manager. No new port is assumed authoritative here.
2. Apply omission to inverse/relations, per-property subject maps (including command responses), and graph
   truncation, preserving continuations independently. This depends on step 1; schema optionality alone is not
   implementation. Remove type count sampling from the public proof path unless its entire work fits the same
   page budget. Internal counters and projection semantics stay intact.
3. Coordinate `http/subjects.ts`, `item.ts`, `links.ts`, `graph.ts`, callers and generated contracts; regenerate
   with `bun run --cwd services/kernel derived`, using `scripts/openapi.ts` and `scripts/client.ts`. This depends
   on the final optional fields in step 2. The generated tree `packages/client/src/kernel/**/*.d.ts` includes
   imported route declarations transitively, not just `semantic/http/subjects.d.ts`; OpenAPI lives in
   `contracts/openapi.json`. Never rename schema fields without the typed client and consuming pages.
4. Run native acceptance and existing caller tests, root typecheck (`bun scripts/typecheck.ts`) and generated
   drift checks. The tests delivered here are intentionally red on current production behavior.

## Coordinated caller and test inventory

Direct production declarations/callers: `semantic/item.ts` (`Item`, `resolveItem`), `subject.ts` (`createSubject`,
`readSubject`), `links.ts` (`SubjectLinksPage`, `SubjectRelationsPage`, `listSubjectLinks`, `listSubjectRelations`),
`graph.ts` (`SubjectGraph`, `listSubjectGraph`), `http/subjects.ts` (`SubjectSchema`, graph and list responses),
`http/definitions.ts` and `http/contexts.ts` (transitively typed route chains), `http/summaries.ts` and
`summaries.ts` (preserve the count-free shared projection). There are no other direct calls to the three list functions on this base. Recipe/composition consumers of HTTP
list responses must propagate missing totals rather than synthesize zero.

Web consumers needing coordinated review are `apps/web/src/features/pages/views.ts`, `overview.tsx`,
`relations-view.tsx`, `subject-frame.tsx` and `data.tsx`; `countText`, tab counts and list recipes must handle
absence without synthesizing a total from the returned rows. `holderItems` currently turns absent `count` into
an exact page length, and `previewCount` does the same for tabs; both fallbacks must change. Review the generic
page read descriptors in `packages/composition/src/registry.ts` and their execution through the web client.
`apps/web/src/kernel/fake.ts` and its `fixtures.json` plus `recorded/subject-links.json`, `subject.json`,
`subject-uncovered.json`, `subject-page.json`, `realm-subjects.json`, `agent-page.json` and
`agent-page-reader.json` need matching optional-field fixtures; production acceptance must stay native. Client fixture coverage includes `packages/client/tests/client.test.ts`.
Web acceptance includes `apps/web/tests/view-tabs-fit.test.ts` and page/list fixtures in
`home-search-rebuild.test.ts`. Generated OpenAPI and all Eden declaration outputs must be regenerated together.

Existing native tests that assert list counts, relation maps, graph totals or their derived responses:
`links.test.ts`, `inverse-pages.test.ts`, `relations-uncapped.test.ts`, `relation-page-summaries.test.ts`,
`links-projection.test.ts`, `graph-read.test.ts`, `graph-context.test.ts`,
`graph-summaries.test.ts`, `subject.test.ts`, `subjects-http.test.ts`, `subjects.test.ts`, `item.test.ts`,
`subject-summaries.test.ts`, `context-relations.test.ts`, `custom-relation-types.test.ts`, `pen-names.test.ts`,
`pen-name-editing.test.ts`, `recipe-structure.test.ts`, `growth-relations.test.ts`, `growth-inverse-pages.test.ts`,
`growth-private-statements.test.ts`, `growth-key-reemit.test.ts`, `statement-visibility.test.ts`,
`visibility.test.ts`, `merge-projection.test.ts`, `merges.test.ts`, `expansion.test.ts`,
`agent-verification-reversal.test.ts`, `account-agent-erasure.test.ts`, `authored-documents.test.ts`,
`bulk.test.ts`, `subject-pages.test.ts`, plus `specs/semantic-outcomes.test.ts` and its shared driver. Existing tests
remain unchanged in this specification task; production work must reconcile only explicitly authorized
expectations. The separate deletion-audit exact-zero assertion is the one known obsolete requirement.
