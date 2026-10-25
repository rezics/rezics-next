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
and the facets of its bases. Lookups use own properties only.

Saved definitions come from the release's `filters` map and are parsed with the same grammar. Expansion is one level:
a missing definition, malformed stored filter, or stored filter containing another saved leaf is an unsupported query.
Pass `{ saved: false }` to reject saved leaves, including for validation of release definitions that must not reference
other saved filters. `validateFilter` combines parsing and admission and returns either no errors or the first field
error without throwing.

## Cost

Parsing is linear in the input and bounded by the limits: at most 32 leaves, each with at most 64 values and 4
qualifiers of 64 values; at most 16 alternatives per `or`; depth 4. Admission walks the expanded document once; a
saved filter expands at most once per leaf and never recursively, so the expanded document obeys the same limits. The
admitted facets come from at most 64 returnable types with their bases, or from the union over all types, computed once
per release object and cached, so a request never iterates the release's types. No I/O. The growth check is the limit
tests above: the same refusals at the same pointers whatever the release size.
