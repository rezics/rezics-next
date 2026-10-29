# Definition publication construction bounds

This proposed construction subtopic belongs to the parent [publication CPU contract](../../../services/kernel/src/semantic/definition-publication-contract.md)
(pending delivery in this checkout) and the existing [publication owner](../../../services/kernel/src/semantic/README.md#definition-publish).
[Definitions](../README.md) owns validity; [Filter](../../filter/README.md) owns admission meaning. This document
replaces the parent's assumptions that non-pattern work is already linear and that aggregate enforcement requires
an in-analysis API. It does not replace the parent publication authority, ship limits, add a runtime service,
queue, schema, checker policy, HTTP outcome or public preparation API. Definitions, parent publication, Root,
Search and affected consumers must approve the proposals before implementation.

The parent remains fully outstanding: cold publication 201/GET/ETag, exact replay 201 without effects, existing
digest/new key 200, changed-body key conflict 422, malformed 400, currently denied replay 403 without disclosure,
and the valid excess release's missing nonretryable 422 before effects. Its original full HTTP test is preserved,
not replaced by this native package acceptance. In the prior native run the valid excess actually returned 201
and added a release, receipt, outbox event and write basis. The construction tests neither mount HTTP nor certify
that missing boundary. All pending ingress, owned serialization/two digests, fresh Access/T/retry, history capture,
physical worker retirement/cancellation/shutdown, heap/margin and runtime-read verification scopes remain required.

## Inspected native sources

The inspected repository revision is `1a652b29ed1663c2aee69f763585eb33c18c0d7b`. Exact SHA-256 identities:

| Source                                        | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `packages/definitions/src/index.ts`           | `0717ecf05f578ac5b6247689c79223bd846bedeb17ba5f860fcc55ecd517e21a` |
| `packages/definitions/schema/release.json`    | `890c2f1e9a400380947efe843f58943517cc3b706eacd9954a56d0882e3233bd` |
| `packages/filter/src/filter.ts`               | `55397ea0c07c997a8ad59535c7490dbef7f3a68461e03080890442b0509b52a0` |
| TypeBox `build/schema/engine/uniqueItems.mjs` | `a6555632092a58e85662b1e1db799d3347c24307cffc2bae5310fbc206074840` |
| `packages/definitions/src/pattern-safety.ts`  | `89d1491ccb6c79f3e30fa35ad3e0a2df278be197cc2665081d86b360b4e1390b` |
| recheck `lib/browser.js`                      | `fd332e833abd002c9fc9e0b9d7a5282bbb33b0b5e81b06e7ff67c32bedca2fce` |

Dependencies are TypeBox **1.4.3**, recheck **4.5.0**, canonicalize **5.1.0**; runtime identity is emitted by the
probe, including Bun revision. Read `collectionLimits`, `validateRelease`, semantic list/pattern/filter walks,
release-schema `curies` and every bases/mappings/qualifiers reference, the pinned uniqueItems producer,
`includesOwnString`, `ownData`, `typeFacets`, `facetProperties`, `allReleaseFacets`, `admitFilter` and `validateFilter`.
Actual callers inspected: Definitions `compile.ts` saved-filter compilation and `index.ts` release validation;
kernel `search/service.ts` query admission, `search/scope-source.ts` current pinned scope admission,
`search/facets.ts` facet probes; web `search/search.tsx` display properties and selected filter admission.
These consumers need shared compatibility review, not independent reinterpretations of a new index.

The complete Performance review, prerequisite split requirements, digest-frame correction and exact prior
contract/test/support snapshot were read from their supplied absolute evidence paths. No external research or
reference clone is needed: the gaps follow directly from these concrete loops. Prior phase timing/RSS claims,
if consumed by the parent, have their actual Performance-identified log
`.temp/goal/checks/worker-check-2026-10-29T07-47-05.268Z-50af9c7b.log`, SHA-256
`edff4b56dcff5ea861f8b52c302e8e62f0c686358e4286b689e13380a32fb417`.
No native margin is inferred here from those loaded-host measurements.

## Three separate defects and their replacement requirements

1. Invalid duplicate-heavy arrays reach `validator.Errors(value)` after `Check` fails. `curies` has uniqueness
   but no item cap; collectionLimits does not count bases, mappings or qualifiers. TypeBox reduces each array,
   and each duplicate returns `[...result, index]`. The first duplicate spreads zero accumulated indices, the
   next spreads one, and so on. Native small-scale iterator counters observe these copied elements. At roughly
   700,000 duplicates the loop alone would copy roughly 245 billion elements. This upper bound is a derivation
   from the observed loop, never a 4 MiB pathological workload sent to a shared host.
2. Valid large external base lists are permitted even when the base is not a declared type. Every invocation of
   `typeFacets` first copies the bases through `ownStringList`, then probes every base. Every saved filter and
   every returnable type invokes this again. The untyped union's existing WeakMap does not fix selected-type
   repeated expansion. Growth must vary bases and filter populations separately and together, including invalid
   filters that already performed this expansion before refusal.
3. Valid large qualifier declarations are allowed up to the property population. Each statement qualifier calls
   `includesOwnString`, scanning from the beginning until its own-data string matches. Declaration length,
   statement qualifier count, leaf count and filter population multiply. A late missing qualifier still scans the
   entire declaration. An error-count or elapsed-time observation cannot establish any of these work bounds.

Own duplicate detection must execute before dependency error enumeration. Proposed implementation is a single
Set pass per relevant string array, retaining schema uniqueness and current invalid diagnostics. Record duplicate
arrays, then ensure the schema error path cannot re-enter TypeBox's quadratic producer for those arrays. Merely
adding an early error and still invoking Errors is insufficient. A compatibility approach is a validation-only
owned view with duplicate arrays deduplicated after recording their current array-pointer error, then schema
validation of that view; retain original indices for all child diagnostics and all unaffected fields. Alternatively
use an upstream linear error producer after dependency review. This task selects neither product implementation.
Malformed nonstring members must still retain their original schema child errors, including mixed duplicate and
wrong-type cases. Do not silently replace all schema errors with one duplicate error. No validator copy becomes
product code. The smallest required seam is inside validateRelease, between collection/JSON checks and
`validator.Errors`: own list limits plus linear uniqueness error production with equivalent schema diagnostics.

Build one-level type facet sets once per immutable owned release. Preserve own facets first, then each listed
base's direct facets in list order; deduplicate in first-seen order. Do not recurse into grandparents, or conflate
returnable type selection with all-release facets. Compile declaration membership Sets once per property alongside
these sets; keep property existence, datatype, native string/item constraints and same-statement association.
Definitions' relation order/filter/slot membership should share those declaration sets within validation.
The smallest reuse seam joins Definitions' saved-filter loop and Filter's admission preparation; all three current
entry points (`admitFilter`, `validateFilter`, `facetProperties`) and real consumers need the same lifetime policy.
No exported stub or guessed method signature is supplied here.

Owned immutable releases may retain derived sets for their owned lifetime and exact policy identity. For arbitrary
mutable raw FilterRelease callers, rebuild within a call or explicitly owned validation session; never retain a
WeakMap index solely by their object identity. Descriptor-aware `ownData` must continue ignoring inherited,
accessor-backed and sparse elements without invoking getters. A partly frozen graph is not immutable ownership.
The new ordinary tests mutate the same raw graph and check selected facets/admission again. They do not bless the
existing all-release cache or code-pattern cache as a universal mutable-input lifetime model.

## Proposed pre-schema limits and compatibility

These are exact review proposals, not adopted constants or changed acceptance semantics:

| Collection                  | Proposed maximum | Unit / refusal location                                                 |
| --------------------------- | ---------------: | ----------------------------------------------------------------------- |
| each type's bases           |             4096 | array entries, including duplicates; `/types/<escaped-key>/bases`       |
| each type/property mappings |              256 | array entries, including duplicates; corresponding `mappings` pointer   |
| each property's qualifiers  |             4096 | array entries, including duplicates; corresponding `qualifiers` pointer |

Check lengths before schema Check/Errors, canonical sorts and pattern work, with existing `limit` code and first
code per pointer. Cheap collection failures still precede size/JSON/schema/pattern checks. These caps alone are
not a linear-work repair: 4096 duplicate entries still require linear own diagnostics, and repeated scans of valid
4096-entry lists still require reuse. Canonical 4 MiB and existing types/properties/facets/filters/group caps stay.
4096 bases permit external superclass names beyond the 1024 declared types. 4096 qualifiers preserve the entire
currently possible valid property population. 256 mappings per definition deliberately bounds external alignment
fanout without reducing ordinary extension grain; unlike the other two, no existing catalogue-size cap implies it.
Owners must review this acceptance restriction explicitly rather than infer approval from generous headroom.

The inspected full current catalogue has 24 types, 103 properties, 26 saved filters; maxima are 3 bases/type,
1 mapping/type or property and 8 qualifiers/property. All fit. Ordinary three-type/twelve-property extensions
and the documented hundred-vertical launch grain fit when each new definition stays under these local limits.
This is not proof that all historical pins fit: their populations are not available in this bounded source
inspection. Historical released digest/schema bytes must remain unchanged and readable. Before adoption, owners
must inventory historical pins and define version-aware admission for new publications versus already accepted
pins; a stored valid pin exceeding a new cap cannot become unreadable on restart. A compatible option is applying
new collection admission to new publication only while historical verification uses linear diagnostics/reuse with
its existing byte/schema policy. It needs parent/Search/consumer review and an explicit verification cost bound;
it grants no arbitrary caller a historical exemption. Never migrate digests, silently trim arrays or rewrite the
release/schema/recordings to make these proposals fit. Unknown historical compatibility is an implementation
prerequisite, not a claim this specification already inventoried the database.

## Native schedules and counter fidelity

The two acceptance files call real release validation and real Filter parsing/admission. Each fixture retains the
entire bundled catalogue. Array axes use 64/512/4096 entries. Saved populations use 64/512/998 added filters,
where 998 plus the original 26 reaches the current 1024 cap. Grammar axes use 1/3/6 statement leaves,
1/2/4 statement qualifiers, and 1/8/64 returnable types; these respect the existing 32 expanded-leaf budget.
Crossed bases/declarations use 64/512/4096 entries and 1/8/64 added filters. Both valid and late-invalid
admissions execute; qualifiers are selected at the end of their sorted declarations and invalid qualifiers are
missing after the full scan. Bases, saved population, declared qualifiers, leaves and statement qualifier count
also vary independently. This replaces the old property-dense family holding these axes constant.

One isolated child creates an exact disposable TypeBox package copy and exact Definitions/Filter/checker source
copies under `.temp/publication-construction/`. Import rewrites resolve only to original source dependencies or
those exact copies. Every instrumentation anchor must occur exactly once. A generator wraps the actual original
spread iterator and increments on each yielded element, not on a derived d-squared expression. Additional counters
sit in the original reduce, ownStringList base reads, typeFacets base expansion, and includesOwnString loop bodies.
The child selects only fixture base/declaration objects for membership counters, excluding unrelated catalogue
work without deleting it. These counts are deliberately partial actual work, sufficient lower bounds for reds;
node/edge/filter/string counts are separate input dimensions, never presented as executed operations.

Every row emits full uninstrumented and instrumented semantic outputs, including normalized admitted filters or
complete typed refusals, plus hashes of each original/copied file and runtime/dependency versions. Filter success
observes validateFilter and direct admitFilter, so its counters include both executions; release mode measures
one real validateRelease including its actual Filter caller. Linear allowances explicitly cover this fixed
multiplicity. Before throwing any growth assertion, the child finishes all scales and emits the complete report.
The ordinary compatibility tests execute unmodified modules separately. In finally the child restores its global
counter descriptor and deletes its disposable tree; process exit discards module/VM caches. Nothing edits
node_modules, product files, host clocks or shared prototypes. Missing instrumentation anchors fail as setup
errors, never as alleged native growth proof. The final result must distinguish these from reached growth reds.

## Sorted patterns and remaining-budget precedence

Performance and Root accept summing actual completed analyses after sorted distinct source admission. Each actual
checker invocation executes at most 8193 checkpoints (the increment which throws after 8192 is executed work).
For the first aggregate excess, execution is therefore at most candidate Amax + 8193 = 24577. Amax 16384 remains
an unapproved candidate; it is not derived from the 2000 ms deadline. No weighted meter or mandatory in-analysis
remaining-budget API returns. Fixed-policy membership remains exact source/flags/checker/policy identity after
successful fixed proofs, and every property-value pattern is still walked unconditionally.

Native cases include safe `^A$`, unsafe `^(a+)+$`, checkpoint exhaustion `^[ab]{32}a[ab]*$`, and structural/analysis
refusal `^[ab]*a[ab]{32}$`. The copied checker additionally records actual native status or guarded exception;
`analyzePattern` intentionally exposes only safe/steps. Unknown, exception or unsafe is never safe. For each defect,
the test actually executes a sorted safe prefix followed by that same defect, with aggregate boundaries one
checkpoint below, exactly at and one above its observed total. A separate fixed-candidate schedule executes 900
sorted safe literal sources then the exhausted pattern. This is a diagnostic method schedule, not a publication
admission API or a fabricated HTTP result.

The proposal for review is: cheap bounded 400 first; then sorted analyses; a defect with no aggregate excess retains
its diagnostic; when the SAME completed pattern both defects and first exceeds the aggregate, return the existing
defect diagnostic before excess. This preserves a defect discovered in that pattern, while still bounding executed
work. It differs from a naive unconditional sum-first 422 at the same checkpoint. Native observations establish
coincidence, not HTTP precedence; the current validator has no aggregate refusal and does not sort globally.
Root's existing ruling preserves defects before exhaustion and first excess 422, but does not settle this
same-pattern coincidence. Parent/Root must explicitly adopt the tie rule before HTTP implementation. If they select
sum-first instead, document that HTTP precedence amendment; neither result can label the pattern safe. Errors
actually reached retain escaped pointers, first code, lexical order and the 64 cap. The existing ordinary tests
retain unsafe_pattern and cheap collection-before-pattern behavior without claiming aggregate HTTP exists.

## Cost and remaining handoff

Touches: one bounded submitted release, all its bases/mappings/qualifiers/duplicates/saved filters, pinned schema
error loop, native Filter admission and sorted pattern checkpoints. No database/history scan is introduced.
Let N be input values, E input edges/members, F filters, R returnable-type references, Q statement qualifier
references, L input string bytes and O the explicit materialized one-level facet entries. Proposed own work is
O(N + E + F + R + Q + L + O), plus canonical key/source sorting comparisons and their compared string bytes,
plus actual checker checkpoints. Account O separately: expanding a base's at-most-16 direct facets per edge is
bounded by an existing fixed cap; do not hide recursive closure growth. Set construction and expected point probes
replace the current duplicate copies, repeated base expansion and qualifier list scans. Opaque schema validation,
JCS/hash and transient allocation costs still need their phase evidence; these partial counters do not meter them.
The growth assertions require a generous fixed multiple of input edges and reference counts, and intentionally
fail on current product paths rather than assert that quadratic defects should remain forever.

No construction Cost freeze is granted. K/c/runtime and exact Amax freeze remain withheld. E at eight entries AND
8 MiB canonical bytes remains conditional on byte-only residency, cold-miss job work and 1E/8E/64E evidence.
Cmax 6312 is envelope-minus-BODY (`76 + 6*1024 + 92`); its existing sole correction owner supplies the witness.
This subtopic neither duplicates that test nor edits its files. Heap must cover valid/invalid property-dense AND
node-dense shapes, peak and post-GC job heap; ingress reservation lasts through the later of request completion
and physical job-buffer disposal, or separately charges retired inputs. Result/DB binding bytes remain to derive.
Idle native margin must later use construction-bounded worst shapes, maximum body/context and executed
candidate Amax + 8193 under the unchanged deadline. These obligations cannot be closed by a package growth red.

Handoff requires the full four formatted files/diff and their SHA-256 values, raw acceptance/root typecheck logs,
counter identity/compatibility evidence, first actual growth failures and this exact cap/lifetime/precedence
proposal. There is no product fix in this change. Expected native growth failures are the specification's delivered
reds; setup failures are not acceptable substitutes and must be repaired before handoff.
