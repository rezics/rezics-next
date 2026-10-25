# @rezics/composition

The package runs unchanged in Node, Workers and browsers, and its entry must not import Node built-in modules.

The closed page format used by a type's default page, a Zone template and a Zone page.
A document is Puck's data shape with children in slot props:

```json
{
  "root": { "props": {} },
  "content": [{ "type": "Stack", "props": { "id": "stack-1", "gap": "md", "children": [] } }]
}
```

The document has exactly `root` and `content`. `root` has exactly `props`. A node has exactly
`type` and `props`. Puck's `zones` and any other key are refused. The format is ours: this
package does not depend on Puck or React. A renderer maps `type` to a component.

`props.id` matches `^[A-Za-z0-9_-]{1,64}$` and is unique across the document. Component types
come from a registry built with `defineRegistry`. Each component's props are a closed object
and never declare `id`. A slot is a prop that holds an array of child nodes; its name cannot
also be a data prop. Every declared slot is present as an array.

## Zone starters

A Zone starter is inert presentation data that a later Zone feature can copy to instantiate a
Zone. A starter file lives at
`packages/definitions/presentation/<vertical>/zone.json` and has this shape:

```json
{
  "labels": {
    "en": "Books",
    "zh-Hant": "Books",
    "zh-Hans": "Books",
    "ja": "Books",
    "ko": "Books",
    "de": "Books",
    "fr": "Books",
    "es": "Books"
  },
  "pages": [{ "route": "", "document": { "root": { "props": {} }, "content": [] } }],
  "scope": ["books/fiction"]
}
```

Labels have exactly the eight UI locale keys (`en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`,
`fr` and `es`). Each label is non-empty safe plain text of at most 80 characters. A starter
has at most 16 pages; each page has a unique, strictly increasing relative route and a
composition document. The empty route identifies the Zone home page and is required. A route
is at most 255 characters and contains lowercase path segments made from letters, digits and
single hyphens. The scope contains at most 16 distinct saved-filter IDs defined by the same
definition release. `validateZoneStarter` checks this envelope and validates each page with
`validateComposition`.

## Limits

`validateComposition` is pure, does not mutate its input, and does not throw on parsed JSON.
It runs when a page is published, not on each view.

| Limit                         | Maximum      | Pointer                       |
| ----------------------------- | ------------ | ----------------------------- |
| RFC 8785 canonical UTF-8 JSON | 65,536 bytes | `""`                          |
| Nodes in the document         | 256          | `/content`                    |
| Node depth                    | 8            | the first node past the limit |
| Distinct page reads           | 16           | `/content`                    |
| Page read cost                | 128          | `/content`                    |

A node in `content` has depth 1. A node in a slot of a depth-d node has depth d + 1. Size is
checked first. A document over the node budget returns only the node limit, including when it
is also too deep. A document inside that budget and past the depth limit returns only that
depth violation.
When no other violation exists, validation plans reads with the placeholder subject
`00000000-0000-8000-8000-000000000000`. More than 16 distinct reads, or a sum of their costs
over 128, returns only `{ pointer: '/content', code: 'limit' }`. The distinct-read count is
checked first.

## Safety

Every string a registry admits is one of:

- `plainText({ maxLength })`: no control character other than tab and newline, and no `<`
  followed by an ASCII letter, `/`, `!` or `?` (`3 < 4` is text; `<b>` is not);
- `href()`: at most 2,048 characters. A site path starts with `/`, the next character is not
  `/` or `\`, and the value contains no whitespace, backslash, `<`, `>`, `"` or `'`. An
  absolute `https:` URL has a host name, an optional port and no user information. Any other
  scheme, a protocol-relative URL or a control character is refused;
- `curie()`: `^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*$`, at most 128 characters;
- `localizedText({ maxLength })`: `plainText({ maxLength })`, or an object of 1 to 16 entries
  whose keys match `^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$` and whose values are plain text of
  that maximum length;
- a TypeBox literal or a union of literals.

`defineRegistry` throws when a string is anything else. The message includes `<Type>.<prop>`.
The same rules are patterns on the generated JSON Schema, so a consumer that only validates
against that schema applies the same safety. Localized text is an `anyOf` of the string and
the object, and the object uses `propertyNames` for its keys.

## Violations

`validateComposition` returns `{ pointer, code }[]` with RFC 6901 pointers.

| Code           | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `invalid`      | Envelope or value shape, an unknown key, a missing required key, or a schema mismatch |
| `unknown_type` | `type` is not registered; that node's props are not checked                           |
| `unsafe`       | A string fails a plain-text, link or CURIE pattern                                    |
| `duplicate`    | A repeated `props.id` after its first occurrence                                      |
| `limit`        | Canonical size, node count, depth, distinct page reads or their total cost            |

Document order visits a node before its slot children, and slots in registry order. One
violation is kept per pointer, and `unsafe` wins over `invalid`. Results are sorted by
pointer in code-unit order and capped at 64.

## Platform registry

`platformRegistry` contains layout and data components. Root props are
`{ appearance?: Appearance }`. `APPEARANCE` closes the
tokens: `density` (`compact` or `comfortable`), `radius` (`sm`, `md` or `lg`), `surface`
(`flat` or `cards`), `cover` (`portrait`, `square` or `landscape`) and `headingScale` (`md`
or `lg`). Every token is optional. Colours and type faces are not tokens; pages share the
REZICS visual language.

| Component        | Props                                                                                                               | Slots          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------- |
| `Stack`          | `gap`: `sm`, `md` or `lg`                                                                                           | `children`     |
| `Columns`        | `split`: `even`, `start` or `end`                                                                                   | `start`, `end` |
| `Heading`        | `text` (localized text, 200), `level`: 2, 3 or 4                                                                    |                |
| `Text`           | `text` (localized text, 2,000)                                                                                      |                |
| `Slot`           | `name`: one of `SLOT_NAMES`                                                                                         | `children`     |
| `SubjectHeader`  | none                                                                                                                |                |
| `Statements`     | `properties`: 1–32 unique `curie()` values                                                                          |                |
| `MoreStatements` | none                                                                                                                |                |
| `SubjectList`    | `title` (localized text, 120), `property`: `curie()`, `limit`: integer 1–24                                         |                |
| `SearchBox`      | `placeholder` (localized text, 80)                                                                                  |                |
| `LinkGrid`       | `links`: 1–12 `{ label: localized text (60), href: href() }` entries                                                |                |
| `TypeList`       | `title` (localized text, 120), `types`: 1–8 unique `curie()` values, `sort`: `name` or `collections`, `limit`: 1–24 |                |

`SLOT_NAMES` is `header`, `hero`, `entity`, `aside`, `footer` and `actions`. The host site
fills the `actions` slot with its controls for the page subject, before any children the
template puts there. `Slot` is the platform's rendering; reviewed first-party Zone code may
wrap or replace it.

`SearchBox` and `LinkGrid` read nothing. A `LinkGrid` `href` starting with `/` is a site path
without the locale; the website renderer adds the locale.

`SubjectHeader`, `Statements`, `MoreStatements` and `SubjectList` read nothing when
`page.subject` is `null`. The first three otherwise read the page subject. `Statements` shows
the named properties; `MoreStatements` shows the subject's statements whose properties no
`Statements` node on the page names. `shownProperties(document)` lists those named properties
once, in document order. `SubjectList` reads subjects whose `property` statement points at the
page subject, sorted by name and bounded by `limit`. `TypeList` reads subjects matching its
`types` on any page, sorted by name or by most public Collections first, and bounded by `limit`.

## Read planning

A component definition may supply `read(props, page)`, where `page` is
`{ subject: string | null }`, returning a `PageRead` or `null`. This function is code owned by
the registry. It is absent from the generated JSON Schema, and documents cannot name reads.
`PageRead` is either:

```ts
{
  kind: 'subject';
  id: string;
}
// GET /v1/subjects/{id}

{
  kind: 'search';
  body: {
    filter: PageFilter;
    sort: 'name' | 'collections';
    limit: number;
  }
}
// POST /v1/subjects:search

type PageFilter = { statement: { property: string; in: [string] } } | { type: { in: string[] } };
```

`SubjectList` uses its `property` and `limit` with `in: [page.subject]`.
`TypeList` uses `{ type: { in: types } }` and is independent of `page.subject`.
`planReads(registry, document, page)` accepts a valid document and returns `{ reads, nodes }`.
It walks parents before their slot children, with slots in registry order. Descriptors with
equal RFC 8785 canonical JSON share a read. `reads` assigns `r0`, `r1`, … in order of first
use; `nodes` maps every node id with a read to its key. The planner does not mutate the
document or execute reads. The later kernel aggregate route will dispatch each descriptor
through its standalone route; data component rendering belongs to the website.

`MAX_PAGE_READS` is 16, and planning throws if more distinct reads are needed. Every page
subject plans the same number of reads, so the publish-time count bounds every read; a null
subject needs none. Planning is one walk over at most 256 nodes with one canonical
serialization per data node (each descriptor is under 1 KiB). It is linear in the document
and never depends on the catalogue. A page issues at most 16 distinct reads whatever its
node count or subject, enforced at publish. The growth check covers 1, 16 and 200 data nodes
planning 1, 16 and 1 reads, and refuses 17 distinct reads.

`readCost(read)` is the number of subjects that read can return: 1 for a subject read and
the search `limit` for a search read. `MAX_PAGE_COST` is 128. After the distinct-read count
check, publish-time validation sums `readCost` over the distinct reads planned with the
placeholder subject. Shared descriptors count once. The sum is one pass over at most 16
reads, so a page read issues at most 16 reads and returns at most 128 subjects in total,
whatever the document or subject.

## Localized text

`Heading.text` (200), `Text.text` (2,000), `SubjectList.title` and `TypeList.title` (120),
`SearchBox.placeholder` (80), and each `LinkGrid` link label (60) are `localizedText`. A
string is checked as `plainText`. An object reports a bad key as `invalid` at that key, a bad
value as `unsafe` or `invalid` at that value, and too few or too many entries as `invalid` at
the property. Any other JSON value is `invalid` at the property.

`pickText(value, locale)` returns `{ text, lang }`. A string yields `{ text: value, lang: null }`.
An object yields the entry for `locale`, otherwise an entry whose primary subtag equals the
locale's (the key equal to that subtag first, then the others in code-unit order), otherwise
`en`, otherwise the first key in code-unit order. `lang` is the key chosen.

Localized text multiplies a text property's size by at most 16 entries, and the document
stays inside `MAX_COMPOSITION_BYTES`. `pickText` is one lookup plus at most one pass over at
most 16 keys.

`bun scripts/schema.ts` writes `schema/composition-v1.schema.json` from this registry.
`bun scripts/schema.ts --check` fails when that file is stale. The schema covers the closed
shape and the safety patterns. Runtime validation also enforces size, node count, depth,
unique ids, the distinct read limit and the total read cost.

## Presentation profile

A presentation profile holds the composition documents that decide how every page reads.
It has one generic page, then templates by structural base, by type and by explicit route.
A type's default read layout is its type template. A launch vertical needs no page code of
its own.

```json
{
  "format": "https://rezics.com/presentation/profile/1",
  "generic": { "root": { "props": {} }, "content": [] },
  "bases": [{ "base": "schema:Thing", "document": { "root": { "props": {} }, "content": [] } }],
  "types": [{ "type": "schema:Book", "document": { "root": { "props": {} }, "content": [] } }],
  "routes": [{ "route": "/", "document": { "root": { "props": {} }, "content": [] } }]
}
```

The profile has exactly `format`, `generic`, `bases`, `types` and `routes`. `format` is
`https://rezics.com/presentation/profile/1`. A base entry has exactly `base` and `document`.
A type entry has exactly `type` and `document`. A route entry has exactly `route` and
`document`. `generic` and every `document` are composition documents.

`base` and `type` pass the `curie()` rule: its pattern and at most 128 characters. `route`
matches `^/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$` and has at most 256
characters. Within each list, keys are strictly increasing in code-unit order.

## Profile validation

`validateProfile` is pure. It does not mutate its input, and it does not throw on parsed
JSON. It runs once per publish, never on a read. Work is linear in the profile's RFC 8785
canonical UTF-8 bytes: at most 1 MiB, at most 128 templates, and each template stays inside
`validateComposition`'s limits.

| Limit                                    | Maximum         | Pointer |
| ---------------------------------------- | --------------- | ------- |
| RFC 8785 canonical UTF-8 JSON            | 1,048,576 bytes | `""`    |
| Entries in `bases`, `types` and `routes` | 128             | `""`    |

`generic` is outside the template count. Size is checked first. A profile over the byte
budget returns only `{ "pointer": "", "code": "limit" }`. A profile inside that budget and
past the template limit returns only that same limit, and validation stops. The pointer is
`""` whatever the size of the templates.

Below both limits, violations use the codes of `validateComposition`. A value that is not an
object, a wrong or missing envelope key, a wrong `format`, or a key that fails its rule is
`invalid`. Inside a list, each key is compared with the entry just before it. An equal key
is `duplicate` and a smaller key is `invalid`, both at the later key. Each document is
checked with `validateComposition`, and its violations are reported under that document
(`/generic/...`, `/types/3/document/...`). One violation is kept per pointer, with the same
precedence as `validateComposition`. Results are sorted by pointer in code-unit order and
capped at 64.

`profileDigest` is `sha256:` and the lowercase hex SHA-256 of the RFC 8785 canonical UTF-8
JSON, the same way a definition release is digested. Key order in the object does not change
the digest.

## Template resolution

`resolveTemplate` chooses one document for a subject `{ route?, type?, bases? }`. The profile
is valid. Templates resolve in this order:

1. The route template whose `route` equals the target route.
2. The type template for the target type.
3. The first structural base, nearest first, that has a base template.
4. The generic page.

The result is `{ scope, key, document }`. `scope` is `route`, `type`, `base` or `generic`.
`key` is the matched route, type or base. The generic page uses `null`.

Lookups are binary searches over the sorted lists. Resolution is O(log T) for T ≤ 128
templates, plus at most one lookup for each structural base. Bases come from the definition
release, nearest first, bounded by its class depth. A page read never scans the profile.

## Platform profile

`profiles/platform.json` is the presentation profile a launch vertical uses when it ships no
page of its own. The package exports it as `@rezics/composition/profiles/platform.json`, so
the website's fake kernel and stories serve the same templates.

`generic` is a `header` slot holding `SubjectHeader` and the `actions` slot, then
`MoreStatements`. Every subject template uses that header.

`bases` has `schema:CreativeWork` and `schema:CreativeWorkSeries`. The work template is that
header, then a `Statements` node, then a `SubjectList` of editions (`schema:exampleOfWork`,
limit 12), then `MoreStatements`. The `Statements` properties are the work facts the bundled
release defines, in this order: `schema:author`, `schema:illustrator`, `schema:translator`,
`schema:publisher`, `schema:datePublished`, `schema:inLanguage`, `schema:genre`,
`schema:isPartOf`. The series template uses that header and those statements, then
`SubjectList`s for works in the series (`wdt:P179`) and parts (`schema:isPartOf`), limit 24
each, then `MoreStatements`.

`types` has four templates. Each list is a `SubjectList` after the header and before
`MoreStatements`, with its title in the eight UI locales. `schema:Person` lists
`schema:author`, `schema:illustrator`, `schema:director`, `schema:musicBy` and `wdt:P725`,
limit 12. `schema:Organization` lists `schema:publisher`, `schema:productionCompany` and
`wdt:P178`, limit 12. `skos:Concept` lists `schema:genre`, limit 24. `wd:Q95074` lists
`schema:character`, limit 24. Route `/` is the site home template: a `SearchBox` whose
placeholder invites searching books, anime, visual novels and recipes, then a `LinkGrid` of
Books (`schema:Book`), Anime (`schema:TVSeries` and `schema:Movie`), Visual novels
(`wd:Q689445`) and Recipes (`schema:Recipe`), then one `TypeList` per vertical in that order
and with the same types, sorted by `collections` with limit 12 and titled with the vertical's
name. Each link is `/search?type=` plus that vertical's type CURIE, percent-encoded; Anime
names its first type. Every text is written in the eight UI locales. Resolution is route,
then type, then base, then generic, so `/` uses the home template, a person, organisation,
concept or fictional character uses its type template, a series uses
`schema:CreativeWorkSeries`, another bundled work uses `schema:CreativeWork`, and every other
bundled type uses `generic`.
