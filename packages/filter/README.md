# `@rezics/filter`

`@rezics/filter` parses and admits the closed filter documents used by search. It has no runtime dependencies and
does not depend on the kernel or definitions packages.

## Grammar

A filter is one node:

```text
Filter ::= { and: Filter[] }
         | { or: Filter[] }
         | { not: Filter }
         | { type: { in: Curie[] } }
         | { statement: Statement }
         | { saved: SavedFilterId }
         | OwnerLeaf

OwnerLeaf ::= { owner: { presence: true } }
            | { owner: { state: { profileId: DataId, stateSetId: DataId, in: DataId[] } } }
            | { owner: { label: { id: UUID } } }
            | { owner: { session: { profileId: DataId, lifecycle: 'active' | 'completed' | 'abandoned' } } }
            | { owner: { holding: { profileId: DataId, kind?: DataId, status?: DataId } } }

Statement ::= { property: Curie, in: string[], qualifiers?: Qualifier[] }
            | { property: Curie, range: Range, qualifiers?: Qualifier[] }

Qualifier ::= { property: Curie, in: string[] }
Range ::= { gte?: number, lte?: number, unit?: string }
        | { type: 'time', gte?: CalendarEndpoint, lte?: CalendarEndpoint }
CalendarEndpoint ::= YYYY | YYYY-MM | YYYY-MM-DD
```

Objects are closed: extra fields are errors. Arrays contain their own indexed values; inherited properties are not
used. CURIEs use a lowercase namespace and an ASCII local name. Strings must be non-empty, free of control characters,
and at most 256 UTF-8 bytes (128 bytes for CURIEs). A range needs at least one bound, and its lower bound cannot be
greater than its upper bound. A statement has exactly one of `in` or `range`. Qualifiers are part of that statement,
so they cannot introduce a separate filter condition.

Decision: precise calendar ranges use `range: { type: 'time', gte?: string, lte?: string }`; numeric ranges
retain their existing year/quantity meaning. A typed calendar range admits only a released time facet and
has no unit. Endpoints follow the Gregorian calendar, including signed extended astronomical years. A
partial endpoint represents its whole year or month. The lower edge of `gte` and upper edge of `lte` form
an inclusive interval, matched by overlap with the recorded date's interval. Either endpoint may be absent;
both absent, impossible dates, reversed intervals and timestamps are rejected. Unknown dates cannot
witness a positive match. Parsing preserves each endpoint's authored precision, including through saved
filter expansion and Boolean nodes. Engine consumers must establish a prepared calendar-capable physical
generation before compiling these ranges; the historical year-only mapping cannot answer them.

Saved filter IDs use the form `namespace/name`, with lowercase letters, digits and single hyphens in each part, and
are at most 96 characters. Parsing retains saved filters as leaves; admission expands them using the supplied release.

## Limits

| Limit                     | Maximum |
| ------------------------- | ------: |
| Filter leaves             |      32 |
| Boolean nesting depth     |       4 |
| Alternatives in an `or`   |      16 |
| Values in an `in` list    |      64 |
| Qualifiers on a statement |       4 |

Each owner predicate counts as one leaf. Each statement counts as one leaf plus one for every qualifier. Each saved filter counts as one leaf while parsing;
admission expands it and checks the expanded document against the same limits. A `not` cannot directly contain another
`not`.

## Admission and saved filters

`parseFilter` checks structure and returns a fresh `FilterDocument`. `admitFilter` expands saved filters, then checks
types, statement facets, property datatypes, values, ranges, units and qualifiers against a structural `FilterRelease`.
Facets are admitted from the types a query can return: a top-level type leaf selects its values, a top-level `and`
intersects its direct type children, and other forms may return every release type. A type contributes its own facets
and the facets of its bases. The exported `facetProperties(release, types)` provides the same rule for display: in the
supplied type order, it returns each type's own facets followed by each base's facets in base order, without repeats.
Lookups use own properties only. A registered string facet admits `in` only when its
definition declares `value.pattern`: each value must be 1 to 128 code units and match that pattern, compiled with the
`u` flag once per property definition; without a pattern the catalogue facet condition stays unsupported.

A declared qualifier admits either `wikibase-item` values (canonical UUIDs, unchanged) or any `string` datatype.
String qualifiers need no pattern to opt in. Values obey the grammar's nonempty, no-control, 256 UTF-8 byte
limit, plus the native fixed string schema's `minLength`, `maxLength` and optional `pattern` when
present, with the native string schema's pattern semantics. The 128-code-unit catalogue code-facet limit does not apply to qualifiers. Equality preserves exact
bytes: no coercion, trimming, case folding, Unicode normalization, language guessing or label lookup. Canonical
language and SHA-256 patterns retain their exact spelling. Monolingual text, quantity and range qualifiers remain
unsupported. Released item/string relation qualifiers use the same admission rules. Search forwards the entire
conjunction to its bounded native current-evidence probes, retaining uncertainty under NOT; see
[qualified credit evidence](../../services/kernel/src/search/character-person.md). This extension does not certify
complete negative evidence or whole-page preparation.

Native `subjectSource` retains concrete item and string qualifiers from each selected statement's pinned release
on that same statement, for both compact and expanded storage. Existing nested keyword terms and the current pure
matcher compare these strings directly. This extraction primitive does not establish complete public query safety:
the old SubjectSource samples relations and drops unknown snaks, and cannot distinguish missing, unknown or withheld
qualifiers from complete known absence. Its false matcher result must not certify a negative. At a complete
source/plan boundary essential uncertainty must be `not_proven`, including under NOT. Complete projection,
query privacy/foreign repair, native unknown conformance and measurement schema/scope/eligibility remain separate
requirements; generic fixture vocabulary is no bundled measurement release or capability claim.

Saved definitions come from the release's `filters` map and are parsed with the same grammar. Expansion is one level:
a missing definition, malformed stored filter, or stored filter containing another saved leaf is an unsupported query.
Pass `{ saved: false }` to reject saved leaves, including for validation of release definitions that must not reference
other saved filters. `validateFilter` combines parsing and admission and returns either no errors or the first field
error without throwing.

## Owner context and complete traversal

The [owner predicate contract](../../docs/library-owner-queries.md) owns private fact meanings. `OwnerLeaf` is part
of the same `FilterDocument` union and may occur anywhere a leaf is allowed, including below NOT and in saved
expansions. Each owner object selects exactly one family. All operand objects are closed, with no account, route,
client or accepting-pin selector. `DataId` uses the native released Library identifier rule: 1–64 ASCII characters,
first `[a-z]`, remaining `[a-z0-9_.-]`, matched against the entire input. State IDs must be nonempty and distinct and
obey the shared `in` limit. Label IDs are lowercase canonical UUID strings, with no name or global owner lookup.
The holding's optional kind and status remain independent data operands; supplying both refers to the same holding.

Actual entry point signatures are:

```ts
export type FilterAdmissionOptions = { saved?: boolean; owner?: true };
export function parseFilter(input: unknown): FilterDocument;
export function admitFilter(
  filter: FilterDocument,
  release: FilterRelease,
  options?: FilterAdmissionOptions,
): FilterDocument;
export function validateFilter(
  input: unknown,
  release: FilterRelease,
  options?: FilterAdmissionOptions,
): FilterValidationError[];
export function walkFilter(filter: FilterDocument): IterableIterator<FilterDocument>;
```

Ordinary admission rejects owner predicates with `unsupported_query`, including under NOT and after saved expansion.
Commerce can explicitly pass `{ owner: true }` to the same admitter or validator. This permits only the structural
owner operands; it performs no private IO, kernel/definitions calls or current profile lookup. It grants no permission
and proves no accepted pin. Catalogue type, datatype, unit and qualifier admission still applies to every catalogue
leaf. Search's catalogue compilers and facet admission explicitly reject owner expressions before source/engine IO.

A consuming native owner plan must bind the authenticated viewer-self partition, admit CURRENT scopes/gates for every
private family, and validate each historical accepted pin against its own immutable release. Owner state/session/
holding queries must not reinterpret historical data using current subject type or current release. The owner
indexed/prepared adapters, real Collection/dynamic integration, native user-case drivers, accepted-pin readers,
immutable engine observations, privacy-reduction acknowledgement and composed cost proof remain separate runtime
dependencies. This grammar boundary does not deliver those native outcomes or a public owner-query capability.

For dependency extraction, call `walkFilter` on the actual expanded result from `admitFilter`. It yields every native
node by identity in preorder, including nodes below NOT, without deduplication, projection, interpretation or IO.
Statement nodes retain all same-statement qualifiers; owner nodes retain all family operands. Unexpanded saved nodes
are yielded as references, not resolved by the walker. Never derive dependencies from only positive/matched leaves.
Public query/name/label/alias/fallback/type/order and immutable observation dependencies belong to Source and the
native Search planner. Private owner operands must not enter the public per-home privacy log.

The entry point also retains `FILTER_LIMITS`, `FilterError`, `positiveFilter`, `relationFacetProperty`, `facetProperties`
and the `FieldErrorCode`, `FilterProblem`, `FilterRange`, `FilterQualifier`, `FilterStatement`, `FilterDocument`,
`FilterRelease` and `FilterValidationError` types. `OwnerLeaf` and `FilterAdmissionOptions` are the additive types;
`walkFilter` is the additive structural traversal. There is no second Filter union or JSON schema.

## Execution admission and conformance

[Filtered lists](../../docs/filtered-lists.md) owns list execution, freshness, current disclosure and cost. This
package admits released **meaning**; `admitFilter` does not establish an executable page plan. Search/Commerce admit
filter + source + order together as direct catalogue index, direct owner index, prepared public result or prepared
owner result plans. These are prose responsibility names, not new executable discriminants. A composed Zone page
also needs aggregate admission. Direct work needs a page-derived bound including engine work; otherwise use bounded
retained preparation on existing infrastructure, or reject 422 before enumeration.

Complete identified indexed observations may execute the same grammar in OpenSearch or typed, parameterized SQL,
including admitted ranges/qualifiers. Preserve release pins, datatypes/units, same-statement qualifier association
and unknown under NOT. The Search pure matcher is the conformance reference, not mandatory request-time raw-fact
replay. A partial sample cannot prove a negative. No universal 256-key proof or whole-selected-slot observation
restricts list execution; existing grammar, scalar and native batch limits retain their units and scope.

Everything disclosed, including membership, NOT harem exclusion, order, fields, source metadata and cursors,
requires current native disclosure and complete dependencies. Query-level privacy-reduction invalidation and
acknowledgement is required in addition to candidate checks. It covers actual refresh-visible local AND dependent
foreign repair; observe safety before execution and revalidate before disclosure. Missing/pending/changed/unsafe
acknowledgement means preparation/readiness. Ordinary checkpoints/securityRevision/generations and returned-ID
checks or omitted counts cannot certify this abstract seam. No certificate store or safety-token ABI is selected.

Successful lists fill the requested page or are genuinely exhausted; sparse inputs use finite retained preparation,
not short/empty success chains. Catalogue healthy lag is 60 seconds, readiness over five minutes of actual pipeline
lag; privacy reductions are immediate and owner writes appear on the owner's next read. The shared acceptance
matrix covers harem light novels, Book wordCount > 1,000,000 (exact threshold/absent excluded), combined, public
Zone/Collection and own library without/with own state. Released Concepts and genuine word/character mappings remain
separate data-producer prerequisites. Owner-only NOT state X includes no entry within the admitted owner population.
These requirements do not claim the current native planner/projection/privacy seam is implemented or tested.

## Cost

Parsing is linear in the input and bounded by the limits: at most 32 leaves, each with at most 64 values and 4
qualifiers of 64 values; at most 16 alternatives per `or`; depth 4. Admission walks the expanded document once; a
saved filter expands at most once per leaf and never recursively, so the expanded document obeys the same limits. The
admitted facets come from at most 64 returnable types with their bases, or from the union over all types, computed once
per release object and cached, so a request never iterates the release's types. A code pattern is compiled once per
property definition. Catalogue code-facet values check at most 128 code units each; string qualifiers check at
most 256 UTF-8 bytes each, with native length constraints counted in Unicode code points. Both retain at most
64 values per list. No I/O. The growth check is the limit tests above: the same refusals at the same pointers
whatever the release size.
