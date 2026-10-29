# Definition publication construction bounds

[Definitions](../README.md) owns release validity; [Filter](../../filter/README.md) owns admission meaning;
[Semantic publication](../../../services/kernel/src/semantic/README.md#definition-publish) owns commands and stored
reads. Construction now uses linear uniqueness diagnostics and owned facet/declaration indexes in the actual
validator, saved-filter validation, public Filter entry points and publication/read callers. The release schema,
format, catalogue, canonical digest identity and pattern policy remain unchanged.

## Validation and diagnostics

Bounded descriptor/JSON/byte admission precedes canonical sorting, hashing and schema diagnostics. Accessors,
inherited data, cycles and sparse arrays are rejected without evaluating getters. Existing collection limits
retain their `limit` precedence over schema/pattern defects. Canonical JSON remains capped at 4 MiB.

The unchanged release schema determines every uniqueness site, including library import record kinds, CURIE
lists, facets, relation filters, targets and units. One schema-derived walk supplies array-pointer errors with a
Set of pinned TypeBox hashes. This preserves TypeBox's structural object ordering, malformed JSON-member
identity, numeric representation (including -0) and hash-collision behavior. Arrays are never deduplicated or
renumbered. The once-derived diagnostic schema disables only those uniqueness sites. Its remaining Check/Errors
operate on the original input, preserving child errors, first code, lexical pointer order and the 64-error cap.
There is no quadratic dependency Errors fallback on duplicates. Hash traversal, encoded bytes and object key
sorting remain real work; a hash is not treated as a constant-cost opaque value.

## Construction lifetime and Filter callers

`createFilterConstruction` owns a descriptor-only snapshot and its indexes for one explicit construction lifetime.
Definitions uses it once for all saved filters and relation qualifier membership. Each type's own facets precede
its listed bases' **direct** facets, in list order with stable first-seen deduplication; grandparents do not recurse.
An untyped union stays separate from selected returnable types. Admission retains the selected Sets and probes
membership per leaf rather than rebuilding a union per filter. Display enumeration charges actual returned entries.
Qualifier and unit membership Sets are built once; datatype, value/pattern, same-statement, item/string/query limits
and typed refusal order remain Filter's authority.

Raw `admitFilter`, `validateFilter` and `facetProperties` create fresh indexes per call. They observe same-object
pattern, qualifier, base and facet edits immediately, including the untyped union. Reuse by object identity occurs
only after every retained node is proven frozen through own data descriptors; a shallow freeze is insufficient.
Patterns are cached only in that construction lifetime. Explicit sessions retain their owned snapshot when the
caller's original graph changes. No WeakMap of arbitrary mutable inputs supplies authority.

## New publication shape admission and historical reads

The adopted NEW-publication caps count submitted entries, including duplicates:

| Collection                    | Maximum | Refusal pointer                    |
| ----------------------------- | ------: | ---------------------------------- |
| Each type's bases             |    4096 | `/types/<escaped-key>/bases`       |
| Each type/property's mappings |     256 | Corresponding `mappings` pointer   |
| Each property's qualifiers    |    4096 | Corresponding `qualifiers` pointer |

`publicationLimits` is bounded admission, not a historical flag or a changed release format. New publications
and fresh bootstrap enforce these limits with existing `limit` diagnostics (HTTP 400 `out_of_range`). Caps never
substitute for linear algorithms: native growth experiments run the shared historical-compatible core at all
64/512/4096 scales, including mappings above the NEW-publication cap.

`readRelease` still verifies actual stored bodies through that same core, checks the exact canonical digest,
and deep-freezes them. It does not apply new shape caps to trusted historical rows. For a cap-exceeding submitted
body, publication first admits JSON/bytes, owns a copy, computes its canonical digest and makes exactly one indexed
published-existence point on the **same pool**. Only actual published existence admits historical replay/new-key
processing. There is no caller exemption, alternate digest, composed-release authority or cross-pool cache test.
Current command authorization at fresh T precedes receipt disclosure. Existing exact replay, existing-digest/new-key,
key conflict and command effects remain unchanged. A missing digest receives the new-cap refusal without writes.

The native mounted HTTP test establishes a historically valid cap-exceeding pin by executing the unchanged original
validator and publication route in an isolated process against real Auth/Access/DB rows. A new process running the
delivered core reads that pin exactly, including its ETag, and exercises historical replay/new-key and denied replay.
The fixture exceeds bases and mappings caps; a valid historical qualifier list above 4096 is impossible under the
existing unique-reference and 4096-property rules. This is runtime-pin evidence, not shipped-Git headroom.

## Native evidence and compatibility witnesses

The original comparison fixtures and assertions remain intact. The serial disposable probe loads the unchanged
original Definitions/Filter code, then instrumented delivered code, preserving every original catalogue entry and
fixture scale. Its 117 rows compare complete validator errors and normalized admitted filters/typed refusals.
Filter measurements share one explicit owned construction session for their validation and direct admission calls;
this is the actual exported lifetime used by Definitions. Raw-call freshness has separate native tests.

Instrumentation copies sources and TypeBox under `.temp/publication-construction/`, checks each anchor, and observes
actual unique Set inserts, own-data reads, base expansions, qualifier probes, snapshot visits, hash nodes/bytes/key
comparisons and facet probes. Snapshot identity tracking follows the actual copied objects. Original fixtures,
scales, assertions, equality witnesses and reports are retained. Installed dependencies and frozen schema bytes
are never edited; isolation/cleanup discards all module caches. New malformed-member tests compare all uniqueness
sites, escaped pointers, child indices, precedence and the 64 cap against the unchanged original validator.
Intentional cap differences are checked separately from unchanged historical validation outcomes.

The original measured defects at 64/512/4096 were duplicate accumulated-index copies 1953/130305/8382465,
crossed base reads and expansions 64/4096/262144 each, and qualifier scans 1500/98016/6289152. All original
117 complete original/instrumented outcomes and four pattern outcomes were equal. Those observations remain
starting evidence, not a claim that a cap repaired the algorithms. The delivered probe reports actual replacement
counts independently for duplicate, base, qualifier and crossed shapes.

Inspected sources include full Definitions validation/schema/compile, Filter parsing/admission/display and pinned
TypeBox uniqueItems/hash implementations; actual kernel read/publication/bootstrap and mounted routes; Search
service/scope/facet callers and web search consumers. The two complete candidate reviews were read by exact path
under the read-only main checkout's `.temp/goal/{search,semantic}/` because they were absent from this worktree.
No external reference project or external research was required.

## Cost

### Definition construction and admission

- Touches: one bounded release's own JSON nodes/edges/bytes, schema-selected unique members, hash nodes/bytes and
  key comparisons, one owned snapshot, direct base/facet edges, declaration Set inserts, selected-type/qualifier
  probes, emitted display facets, canonical serialization/digests and unchanged actual checker checkpoints.
  A capped historical publication adds one same-pool `definition_release_pkey(route,digest)` existence point;
  cold reads verify one stored body and its exact digest. No history scan is introduced.
- Bound: expected O(N + E + L + F + R + Q + O), plus actual canonical/hash key sorting comparisons and compared
  bytes, schema work and unchanged pattern analysis. N/E/L are visited input nodes/edges/string bytes, F filters,
  R returnable-type references, Q qualifier references, O emitted one-level facet entries. Direct base expansion
  is bounded by the existing 16-facet cap; output enumeration is charged separately. Raw calls each pay their
  own construction; explicit sessions and deeply immutable releases reuse it. New shape caps are 4096/256/4096;
  historical verification retains existing JSON/schema/byte bounds and the same linear algorithms.
- Growth check: managed Definitions/Filter construction tests at 64/512/4096 independently and crossed, full
  old/new outcomes and intentional cap differences; malformed JSON uniqueness/precedence/64-cap cases and
  same-object mutable/accessor/inherited/sparse negatives. Mounted kernel acceptance is
  `test/semantic/definition-construction-publication.test.ts`, with exact/excess caps, actual historical creation,
  isolated cold read, exact digest/ETag, replay/new-key, denied replay and actual effect snapshots.

## Remaining parent boundaries

The parent [publication CPU contract](../../../services/kernel/src/semantic/definition-publication-contract.md) and
its original `definition-publication-work.test.ts` remain open. Reached defect 400 must precede same-pattern
excess 422 `definition_work_exceeded` without effects, using the exact retained sorted checkpoint schedules.
Native observed outcomes remain safe/7 for `^A$`, vulnerable automaton/156 for `^(a+)+$`, checkpoint refusal/8193
for `^[ab]{32}a[ab]*$`, and guarded refusal/457 for `^[ab]*a[ab]{32}$`; the package schedules reach totals
16383/16384/16385. These do not prove mounted HTTP precedence. No production callable aggregate work-admission
producer currently exists in the mounted publication path, so its exact HTTP tie remains an explicit unclosed
integration obligation before parent freeze. Amax 16384 and K/c remain candidates.

No worker pool, new pattern policy, test-injected production work limit, ingress/digest binding, idle-host margin,
heap bound, all-pools history cost, result/DB binding byte bound or physical cancellation/disposal/readiness/shutdown
proof is supplied here. Parent ingress reservations must last until physical disposal (or charge retired inputs).
The original excess HTTP case returned 201 and added release/receipt/outbox/write-basis rows; this construction
delivery does not claim that separate CPU refusal has become green, nor main promotion or full Goal closure.
