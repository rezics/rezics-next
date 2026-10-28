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

Statement ::= { property: Curie, in: string[], qualifiers?: Qualifier[] }
            | { property: Curie, range: Range, qualifiers?: Qualifier[] }

Qualifier ::= { property: Curie, in: string[] }
Range ::= { gte?: number, lte?: number, unit?: string }
```

Objects are closed: extra fields are errors. Arrays contain their own indexed values; inherited properties are not
used. CURIEs use a lowercase namespace and an ASCII local name. Strings must be non-empty, free of control characters,
and at most 256 UTF-8 bytes (128 bytes for CURIEs). A range needs at least one bound, and its lower bound cannot be
greater than its upper bound. A statement has exactly one of `in` or `range`. Qualifiers are part of that statement,
so they cannot introduce a separate filter condition.

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

Each statement counts as one leaf plus one for every qualifier. Each saved filter counts as one leaf while parsing;
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
`u` flag once per property definition; without a pattern the condition stays unsupported, and qualifiers stay item-only.

Saved definitions come from the release's `filters` map and are parsed with the same grammar. Expansion is one level:
a missing definition, malformed stored filter, or stored filter containing another saved leaf is an unsupported query.
Pass `{ saved: false }` to reject saved leaves, including for validation of release definitions that must not reference
other saved filters. `validateFilter` combines parsing and admission and returns either no errors or the first field
error without throwing.

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
property definition, and each value check is linear in at most 128 code units across at most 64 values. No I/O. The growth check is the limit
tests above: the same refusals at the same pointers whatever the release size.
