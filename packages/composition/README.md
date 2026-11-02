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

Saved Zone resources use the additive `ZoneConfiguration` envelope. Its optional `primaryLanguage`
selects one of the supported languages and requires that nonblank name; other names are optional.
Without metadata, legacy configuration still requires all eight names. `validateZoneConfiguration`
validates this Zone-only variant, while `validateZoneStarter` and composition labels remain unchanged.
`pickZoneName` selects the requested readable name, the stored primary, then the first readable name in
`UI_LOCALES` order for legacy fallback. It never reads private configuration or synthesizes translations.

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

Integer and Number values that meet their numeric type requirements but exceed inclusive or exclusive
bounds produce `limit` at the value's pointer (HTTP `out_of_range`). Wrong types, fractional Integer
values and nonfinite numbers remain `invalid` (HTTP `invalid_format`); validation never coerces values.

## Safety

Every string a registry admits is one of:

- `plainText({ maxLength })`: no control character other than tab and newline, and no `<`
  followed by an ASCII letter, `/`, `!` or `?` (`3 < 4` is text; `<b>` is not);
- `href()`: at most 2,048 characters. A site path starts with `/`, the next character is not
  `/` or `\`, and the value contains no whitespace, backslash, `<`, `>`, `"` or `'`. An
  absolute `https:` URL has a host name, an optional decimal port from 0 through 65,535 and
  no user information. Any other scheme, a protocol-relative URL or a control character is
  refused;
- `curie()`: `^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*$`, at most 128 characters;
- `subjectId()`: a lowercase canonical UUID;
- `localizedText({ maxLength })`: `plainText({ maxLength })`, or an object of 1 to 16 entries
  whose keys match `^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$` and whose values are plain text of
  that maximum length;
- a TypeBox literal or a union of literals.

`defineRegistry` throws when a string is anything else. The message includes `<Type>.<prop>`.
The same rules are patterns on the generated JSON Schema, so a consumer that only validates
against that schema applies the same safety. Localized text is an `anyOf` of the string and
the object, and the object uses `propertyNames` for its keys.

The editor preserves authored scalar/map forms and locale entries; clearing an existing map entry saves empty text, while a blank new locale control adds no translation.

## Violations

`validateComposition` returns `{ pointer, code }[]` with RFC 6901 pointers.

| Code           | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `invalid`      | Envelope or value shape, an unknown key, a missing required key, or a schema mismatch      |
| `unknown_type` | `type` is not registered; that node's props are not checked                                |
| `unsafe`       | A string fails a plain-text, link, CURIE or subject UUID pattern                           |
| `duplicate`    | A repeated `props.id` after its first occurrence                                           |
| `limit`        | Numeric bounds, canonical size, node count, depth, distinct page reads or their total cost |

A document has at most one page heading. A `SubjectHeader` is the page heading of any
document that contains one, so every level-1 `Heading` in that document is a `duplicate`
at its `props/level`. Otherwise the first level-1 `Heading` in document order is the page
heading and each later one is a `duplicate`. A document with more than one `SubjectHeader`
gets no heading violations. `validateProfile` applies the rule to each template.

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

| Component            | Props                                                                                                                                             | Slots          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `Stack`              | `gap`: `sm`, `md` or `lg`                                                                                                                         | `children`     |
| `Columns`            | `split`: `even`, `start` or `end`                                                                                                                 | `start`, `end` |
| `Heading`            | `text` (localized text, 200), `level`: 1, 2, 3 or 4                                                                                               |                |
| `Text`               | `text` (localized text, 2,000)                                                                                                                    |                |
| `Slot`               | `name`: one of `SLOT_NAMES`                                                                                                                       | `children`     |
| `SubjectHeader`      | none                                                                                                                                              |                |
| `Statements`         | `properties`: 1–32 unique `curie()` values                                                                                                        |                |
| `MoreStatements`     | none                                                                                                                                              |                |
| `SubjectList`        | `title` (localized text, 120), `property`: `curie()`, `limit`: integer 1–24                                                                       |                |
| `RelationGroups`     | optional `title` (localized text, 120), `property`: `curie()`, optional `filter`: subject UUID, optional `type`: `curie()`, `limit`: integer 1–24 |                |
| `Cover`              | none                                                                                                                                              |                |
| `Summary`            | none                                                                                                                                              |                |
| `Appearances`        | optional `direction`: `forward` or `inverse`, `property`, optional `filter`, optional `type`, `limit`: integer 1–24                               |                |
| `Credits`            | optional `direction`: `forward` or `inverse`, `property`, optional `filter`, optional `type`, `limit`: integer 1–24                               |                |
| `RatingSummary`      | none                                                                                                                                              |                |
| `ThreadList`         | none                                                                                                                                              |                |
| `ReviewList`         | none                                                                                                                                              |                |
| `Sources`            | none                                                                                                                                              |                |
| `CollectionList`     | `title` (localized text, 120), `limit`: integer 1–6                                                                                               |                |
| `ReactionSummary`    | none                                                                                                                                              |                |
| `AccountIdentity`    | none                                                                                                                                              |                |
| `AccountThreads`     | `threadKind`: `discussion` or `review`, `limit`: integer 1–20, optional `paged`                                                                   |                |
| `AccountPosts`       | `limit`: integer 1–20, optional `paged`                                                                                                           |                |
| `AccountCollections` | `limit`: integer 1–24, optional `paged`                                                                                                           |                |
| `SearchBox`          | `placeholder` (localized text, 80)                                                                                                                |                |
| `LinkGrid`           | `links`: 1–12 `{ label: localized text (60), href: href() }` entries                                                                              |                |
| `TypeList`           | `title` (localized text, 120), `types`: 1–8 unique `curie()` values, `sort`: `name` or `collections`, `limit`: 1–24                               |                |

`SLOT_NAMES` is `header`, `hero`, `entity`, `aside`, `footer`, `actions` and `personal`. The
host site fills the `actions` slot with its controls for the page subject, before any children
the template puts there. It fills the `personal` slot with content for the signed-in viewer,
before any children the template puts there; page reads are the same for every viewer, so the
kernel cannot fill it. Without that content the `personal` slot renders nothing, children
included. `Slot` is the platform's rendering; reviewed first-party Zone code may wrap or
replace it.

An account is part of the page target, as the subject is. The page context is `{ subject, account }`, where `account`
is `{ id, handle }` or absent. `AccountIdentity` reads the public profile of the page account; `AccountThreads`,
`AccountPosts` and `AccountCollections` read its lists. None of them names a handle, an id or a continuation cursor, so
one template serves every account: an agent page at `/@handle` is a subject page, and a published template is
immutable. A reader follows a list's `next` through its standalone route. Every account component reads nothing
when the page has no account. An account whose agent is a graph subject takes that subject's type template, verified or
not; an account without one takes the `schema:Organization` template for an organization and the `schema:Person`
template for a person. An automated account without a named subject uses `schema:SoftwareApplication`; its public
identity supplies `automated` and `operatorId`.
Threads and replies return at most 20 entries per page; collections return at most 24 entries and always use the
standalone BASIC view. The configured limit is the component's page-read cost; identity costs one.

The website's bare account continuation cursor requires exactly one distinct planned account-list descriptor.
Identical descriptors share a continuation read. With no account list or several distinct descriptors, continuation
is unavailable before any standalone list request; document order never selects its target. Other page reads remain intact.
Account post rows address the selected post with a localized canonical thread URL and `?post=<post-id>#post-<post-id>`;
the existing thread reader owns resolving that locator across post pages and preserving it through canonical redirects.

`SearchBox` and `LinkGrid` read nothing. A `LinkGrid` `href` starting with `/` is a site path
without the locale; the website renderer adds the locale.

`SubjectHeader`, `Statements`, `MoreStatements` and `SubjectList` read nothing when
`page.subject` is `null`. The first three otherwise read the page subject. `Statements` shows
the named properties; `MoreStatements` shows the subject's statements whose properties no
`Statements` node on the page names. `shownProperties(document)` lists those named properties
once, in document order. `SubjectList` reads subjects whose `property` statement points at the
page subject, in the property's declared order (series position, credit order, date, then name),
bounded by `limit`, with the route's exact or at-least count. `TypeList` reads subjects matching its
`types` on any page, sorted by name or by most public Collections first, and bounded by `limit`.
`RelationGroups` reads inverse links for its property, optional qualifier value and optional
holder type, including holder labels and the route's exact or at-least count. A page's
`RelationGroups` nodes are shown together: the website groups their items by the relation group
of each node's property, labels each item with the property's inverse label (a symmetric
property's own label), and gives each group the sum of its counts and a link to the paged
relations view for every property with more than the preview. `CollectionList`
reads public Collections and their exact total count. `ReactionSummary` reads the subject's
reaction totals without viewer-specific reaction data. These three components read nothing
when `page.subject` is `null`.

## Subject data components

The registry's data components cover every overview section with bounded previews. Components use
owner-supplied counts where available. Discussion and review lists have no count and preserve the
owner's opaque continuation, including on an empty page.

| Component         | Reads                                                                                    | Preview limit     |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `SubjectHeader`   | The page subject, with its cover summary                                                 | —                 |
| `Cover`           | The page subject's cover summary; always renders, with the placeholder when it is `null` | —                 |
| `Summary`         | The subject's summary document in the reader's language, spoiler-safe                    | —                 |
| `Statements`      | The named properties                                                                     | 32 properties     |
| `RelationGroups`  | Inverse relations of one property, grouped with the page's other nodes by relation group | 12 per node       |
| `Appearances`     | Character appearances with role and cast (on a work); works with role (on a character)   | 12                |
| `Credits`         | Credits grouped by role in credit order (on a work); works by role (on a person)         | 12                |
| `RatingSummary`   | The headline population's aggregate, the viewer's Realm aggregates, imported scores      | 3 Realms          |
| `ReactionSummary` | The subject's public reaction totals                                                     | 1                 |
| `ThreadList`      | Current discussions in native last-activity order in the page's population               | 6 Global, 5 Realm |
| `ReviewList`      | Current reviews in native last-activity order in the page's population                   | 6 Global, 5 Realm |
| `CollectionList`  | Public collections containing the subject                                                | 6                 |
| `Sources`         | Cover credits, fact sources and external identifiers                                     | —                 |
| `MoreStatements`  | Facts no other component on the page shows                                               | —                 |

`Cover`, `Summary` and `Sources` read the page subject. `Appearances` and `Credits` take the
statements of one relation property in one of two directions. `inverse`, the default, is the
`links` read `RelationGroups` uses: the subjects whose `property` statement points at the page
subject, which is how a person's works and a character's appearances are found. `forward` takes
the statements the page subject itself holds from the subject read it already shares, which is how
a work's cast and staff are found; `filter` and `type` apply to `inverse` only. A forward list is
the subject's statements of that property in statement order, previewed to `limit` with their
count.

`RatingSummary` plans no composition read. `ThreadList` and `ReviewList` bind the existing Content
`subject_threads.list` operation with `kind: discussion` and `kind: review` respectively. The guarded
population selects the native place: Global Context's ID for Global, the selected Realm's ID for Realm.
Both request six Global entries; the existing selected-Realm five-entry window is retained. `paged`
changes presentation and enables node continuation, without widening that window. No subject means no read.
Content's current review kind and optional native vote citation remain authoritative; these lists do not
invent question, helpfulness or rating ordering. Original status, body and opaque `next` pass unchanged
through composition. All configured leaves share the existing 16-distinct-read/128-requested-slot budget.

Web consumes those aggregate leaves for overview and full views, with one public account batch for bylines.
It makes no supplemental Global thread request. A continuation addresses one current `paged:true` node,
retains native cursor admission (4,096 characters), and leaves other list streams unrequested (204).
Each group uses its own next/restart link and retains the selected Realm query parameter.
Failures and platform closure remain distinct from a successful empty page. A zero-item page with a continuation
invites continuation rather than claiming the subject has no posts. Creation uses a returned thread's actual board;
no default board or Realm association is inferred for an empty list.

A section whose read did not succeed says so and offers a retry; the rest of the page renders.

Full views use the same components with `paged: true`, which read one page and render a
continuation link.

A data component never renders a value as an id. `Statements` and `MoreStatements` render
`media` values with `Cover`, `document` values with the document renderer, and item values as
linked labels; a datatype a component cannot render is left out of the reading view and shown
in Details.

The platform profile places `MoreStatements` in the Details view. The overview ends with
`Sources` and a link to Details; it never shows an unordered dump of remaining facts after the
header.

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

{
  kind: 'links';
  id: string;
  property: string;
  filter?: string;
  type?: string;
  limit: number;
}
// GET /v1/subjects/{id}/links?property=...&filter=...&type=...&limit=...

{
  kind: 'collections';
  id: string;
  limit: number;
}
// GET /v1/subjects/{id}/collections?limit=...

{
  kind: 'reactions';
  id: string;
}
// GET /v1/subjects/{id}/reactions

{
  kind: 'account';
  handle: string;
}
// GET /v1/accounts?handle=...

{
  kind: 'accountThreads';
  id: string;
  threadKind: 'discussion' | 'review';
  limit: number;
}
// GET /v1/accounts/{id}/threads?kind=...&limit=...

{
  kind: 'accountPosts';
  id: string;
  limit: number;
}
// GET /v1/accounts/{id}/posts?limit=...

{
  kind: 'accountCollections';
  id: string;
  limit: number;
}
// GET /v1/accounts/{id}/collections?view=BASIC&limit=...

type PageFilter = { statement: { property: string; in: [string] } } | { type: { in: string[] } };
```

`SubjectList` is the inverse `links` read of its `property` and `limit`, the same read `RelationGroups` uses.
`TypeList` uses `{ type: { in: types } }` and is independent of `page.subject`.
`planReads(registry, document, page)` accepts a valid document and returns `{ reads, nodes }`.
It walks parents before their slot children, with slots in registry order. Descriptors with
equal RFC 8785 canonical JSON share a read. `reads` assigns `r0`, `r1`, … in order of first
use; `nodes` maps every node id with a read to its key. The planner does not mutate the
document or execute reads. The kernel page read dispatches each descriptor through its
standalone route; data component rendering belongs to the website.

`MAX_PAGE_READS` is 16, and planning throws if more distinct reads are needed. Every page
subject plans the same number of subject reads, so the publish-time count bounds those reads; a null
subject has no subject-specific reads. Account reads are planned with the resolved page account in the same single plan
and share the same 16-read limit. Planning is one walk over at most 256 nodes with one canonical
serialization per data node (each descriptor is under 1 KiB). It is linear in the document
and never depends on the catalogue. A page issues at most 16 distinct reads whatever its
node count or subject, enforced at publish. Publish-time validation plans account lists with a placeholder account
(`{ id: '00000000-0000-8000-8000-000000000000', handle: 'placeholder' }`) so their limits are included. The growth check covers 1, 16 and 200 data nodes planning
1, 16 and 1 reads, and refuses 17 distinct reads.

`readCost(read)` is the row bound: 1 for subject, reaction or account identity reads and the `limit` for a search,
inverse-links, public-collections, account threads, account posts or account collections read. `MAX_PAGE_COST` is 128. After the distinct-read count
check, publish-time validation sums `readCost` over the distinct reads planned with the
placeholder subject and account. Shared descriptors count once. The sum is one pass over at most 16
reads, so a page read issues at most 16 reads and returns at most 128 subjects in total,
whatever the document or subject.

## Localized text

`Heading.text` (200), `Text.text` (2,000), `SubjectList.title` and `TypeList.title` (120),
`SearchBox.placeholder` (80), and each `LinkGrid` link label (60) are `localizedText`. A
string is checked as `plainText`. An object reports a bad key as `invalid` at that key, a bad
value as `unsafe` or `invalid` at that value, and too few or too many entries as `invalid` at
the property. Any other JSON value is `invalid` at the property.

`localeChain(locale)` is the reader's one fallback list: the locale, its primary language, the other
scripts of that language in a fixed order, then English. `zh-Hans` reads `zh-Hans`, `zh`, `zh-Hant`, `en`;
`zh-Hant` reads `zh-Hant`, `zh`, `zh-Hans`, `en`; `ja` reads `ja`, `en`. Every label, title, description and
summary the site chooses itself goes through it; the site's kernel client sends the same list as
`Accept-Language` with descending q-values, so the kernel chooses embedded labels the same way.

`pickText(value, locale, original?)` returns `{ text, lang }`. A string yields `{ text: value, lang: null }`.
An object walks the chain over its entries that hold text. After the chain it offers other regions or scripts of the
reader's language (in code-unit order), then the `original` language when the caller knows it (the language of the
subject's original title or `schema:inLanguage`), then English, then the first key in code-unit order. For an
English reader the original follows English. `lang` is the key chosen. `pickLanguage(languages, locale,
original?)` is the same choice over bare language keys, for values that are not strings, such as alias lists. Tags
match without regard to casing; when equivalent keys coexist, an exact fallback spelling wins, then existing keys
use code-unit order.

Localized text multiplies a text property's size by at most 16 entries, and the document
stays inside `MAX_COMPOSITION_BYTES`. `pickText` is one pass over at most 16 keys and
a chain of at most five tags.

`bun scripts/schema.ts` writes `schema/composition-v1.schema.json` from this registry.
`bun scripts/schema.ts --check` fails when that file is stale. The schema covers the closed
shape and the safety patterns. Runtime validation also enforces size, node count, depth,
unique ids, the distinct read limit and the total read cost.

## Presentation profile

A presentation profile holds the composition documents that decide how every page reads.
It has one generic page, then templates by structural base, by type and by explicit route.
A type's default read layout is its type template. A launch vertical needs no page code of
its own.

Structural-base templates are presentation fallbacks for existing catalogue structure; adding one creates no catalogue Type or permission.

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
`https://rezics.com/presentation/profile/1`. A base entry has its `base` and a template body, a type entry its `type`
and a route entry its `route`. A template body is `document`, a composition document that is the overview, or `views`,
one document per view (see [Subject views](#subject-views)). `generic` is a composition document or `{ views }`.

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
The presentation editor compares this identity for saved and retained snapshots; distinct drafts that cannot be canonicalized remain unsaved, while an untouched snapshot stays clean.

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
templates, plus at most one lookup for each structural base. A view takes the same lookups and then one property
read for each template of the order. Bases come from the definition
release, nearest first, bounded by its class depth. A page read never scans the profile.

## Subject views

A subject page is a set of views from a closed list (`VIEWS`: overview, editions, contents, characters, appearances,
credits, works, relations, posts, reviews, discussion, lists, collections, details), which is also the order a page offers them. A template
entry (`generic`, a base, a type) holds one document per view it supports:

```json
{ "type": "wd:Q95074", "views": { "overview": { "root": { "props": {} }, "content": [] }, "relations": { "…": "…" } } }
```

`overview` is required; the other keys come from the closed view list. `generic` is `{ "views": { … } }` in the same
way. An entry that has only an overview may write it as `document` instead of `views`; the two forms are exclusive
and `templateViews(entry)` returns the documents either way. A route entry has only its overview.

`resolveView(profile, target, view)` picks the template and then the view: a template that lacks the view yields to the
next in the resolution order, then to the generic view, and a view no template defines resolves to `null`.
`resolveTemplate` is the overview. `definedViews(profile, target)` lists the views any template of the order defines,
in the closed order. Each view document is validated on its own, at `/…/views/<view>`; an unknown view key or a missing
`overview` is `invalid`.

The page read answers one view: its target may name `view` beside a subject or account (never beside a route), the
document is that view's, and the answer lists `views`, the views the page's templates define. The views a page
_offers_ are those minus the ones whose data is empty. Every page read is meant to include one view-count read for the
subject, answered from counts kept with the facts and content they count, so the tab bar never costs a read per view.
Until that read exists, the host offers a view when its preview in the overview returned at least one item.
Subject Reviews and Discussion require an actual successful native preview, including an empty one; Details
requires its template. A template whose overview previews an account's reviews offers Reviews only with data. The tab bar is rendered by the host from that list;
documents cannot name or reorder tabs.

Each view document has its own read budget (16 reads, cost 128). A view's reads are planned only when that view is
requested, so the overview never pays for a full credits list. The data components that preview a list
(`RelationGroups`, `Appearances`, `Credits`, `SubjectList`, `CollectionList`, `ThreadList`, `ReviewList`,
`AccountThreads`, `AccountPosts`, `AccountCollections`) take `paged`: a full view sets it to read one page at the component's own `limit` and renders no "See all" link. The page
read accepts one `{node,cursor}` continuation for a current paged links, relations or subject-threads node;
configured `TypeList` continuation follows its native Search contract.
The native opaque cursor is substituted before deduplication; unrelated list streams return 204 and retain
independent restart links. A component never infers a continuation or total from preview length.

## Platform profile

`profiles/platform.json` is the presentation profile a launch vertical uses when it ships no
page of its own. The package exports it as `@rezics/composition/profiles/platform.json`, so
the website's fake kernel and stories serve the same templates.

Every subject template's overview follows the documented order, and the sections a type does not support are left out:
the `header` slot holding `SubjectHeader` and the `actions` slot, `Summary`, a `Statements` node of key facts, the
parts (editions, or the parts of a series), `RelationGroups`, `Appearances`, `Credits`, `RatingSummary`, `ReviewList`,
`ThreadList`, `CollectionList`, and `Sources`, which ends the page and links to Details. `MoreStatements` is never in an
overview: every template's `details` view holds the key-fact `Statements` and then `MoreStatements`, so the facts the
overview leaves out are there, followed by `Sources`. The full views use the same components with `paged: true` and the
largest `limit` each accepts.

`generic` defines overview, relations, discussion, lists and details, with the same `RelationGroups` (side stories
`rezics:sideStoryOf`, adaptations `wdt:P144`, alternative versions `rezics:alternativeVersion` and related works
`rezics:bangumiRelatedTo`, limit 12 in the overview), `ThreadList`, `CollectionList` and `Sources`. A view a type
template does not define falls back to those.

`bases` has `schema:CreativeWork` and `schema:CreativeWorkSeries`. The work template adds editions
(`SubjectList` of `schema:exampleOfWork`), characters (a forward `Appearances` of `schema:character`), credits (a forward
`Credits` of `schema:contributor`) and reviews. Its `Statements` properties are the work facts the bundled
release defines, in this order: `schema:author`, `schema:illustrator`, `schema:translator`,
`schema:publisher`, `schema:datePublished`, `schema:inLanguage`, `schema:genre`,
`schema:isPartOf`. The series template has the same sections with contents instead of editions: `SubjectList`s for
works in the series (`wdt:P179`) and parts (`schema:isPartOf`).

`types` has five templates. The Recipe overview uses the generic overview order and a configured
`Statements` node for its author, publication date, cooking time, yield, ingredients, instructions and diet.
The other four templates follow below. Each list is a `SubjectList` after the header, with its title in the eight UI locales, and
the type's view for those lists is Works (Appearances for a character, Characters for the voice roles of a person).
`schema:Person` lists
`schema:author`, `schema:illustrator`, `schema:director`, `schema:musicBy` and `wdt:P725`,
limit 12. `schema:Organization` lists `schema:publisher`, `schema:productionCompany` and
`wdt:P178`, limit 12. `skos:Concept` lists `schema:genre`, limit 24. `wd:Q95074` lists
`schema:character`, limit 24. The `schema:Person` and `schema:Organization` templates are the agent templates: their header
slot adds `AccountIdentity` beside `SubjectHeader` (each renders nothing when it has no read, and an account page shows the
account's own presentation in place of the subject's header), and their overview previews the account's
public activity after the relations: `AccountPosts` (limit 4), `AccountThreads` of reviews (limit 4) and
`AccountCollections` (limit 3), keeping the Person overview inside its read ceiling with all sections intact. Its bound
is 16 distinct reads and 128 rows: 1 subject, 55 person links, 48 relations, 11 account previews, 1 account identity,
6 threads and 6 collections. Both
define the `posts`, `reviews` and `collections` views with the same components, `paged` and at their largest limit
(20, 20 and 24). Route `/` is the site home template: its `Heading`, then the `personal`
slot, then one `TypeList` per vertical: Books (`schema:Book`), Anime (`schema:TVSeries` and
`schema:Movie`), Visual novels (`wd:Q689445`) and Recipes (`schema:Recipe`), sorted by
`collections` with limit 12 and titled with the vertical's name. The home has no `LinkGrid`: a
grid of category links would repeat the `TypeList` headings below it. The centered site header supplies the sole Home search entry. The website renders each
`TypeList` as a row of covers with the read's total count and a See all link to
`/search?type=` plus the list's first type CURIE, percent-encoded. Every text is written in the
eight UI locales. Resolution is route,
then type, then base, then generic, so `/` uses the home template, a person, organisation,
concept or fictional character uses its type template, a series uses
`schema:CreativeWorkSeries`, another bundled work uses `schema:CreativeWork`, and every other
bundled type uses `generic`.

`OutgoingRelations` is an inert component descriptor for one native `/relations` read. It accepts the same
property, optional filter/type, limit and paged selectors as relation groups. Paged relation descriptors request
at most 12 rows; continuation binds the native cursor to one current node and its selected Context. The existing
16-read and 128-slot admission limits apply to the complete document before dispatch.

## Dependent document bodies

`documentRead(document, subject, availableProperties, context?)` is the closed internal descriptor
`{ kind: 'documents', id, context?, properties }`. `Statements` selects its named properties;
`Summary` selects `schema:abstract`; `MoreStatements` adds the other properties in the already disclosed subject observation.
The optional Context stays bound to the same selected subject observation; it never falls back to Global.
After that one bounded subject observation, `pageDocumentReferences` selects the same best rank
and reader/original language as the generic renderer, with at most one reference per property and
the smallest statement UUID breaking a tie within the selected rank and language. The executor admits the entire effective
plan before reading bodies or other planned lists. Its published maximum is fifteen distinct
bodies (`MAX_PAGE_DOCUMENTS`): one subject operation plus fifteen `document.get` operations exhausts
sixteen native reads. Account probes, redirect hops, final selected-Context guards and other reads reduce that allowance.
The final guard reserves its native read and slot; each body costs one of the same 128 requested slots.
A configuration whose currently selected values exceed either remaining allowance is rejected
with `/reads: out_of_range`; values are never truncated to fit or selected from subject history.
The aggregate invokes `GET /v1/documents/{id}` in process and retains its complete existing
`document` representation in `reads[key].body.documents[candidateId]`, beside the unchanged subject
references. Admission requires exact id, subject, candidate, language and canonical SHA-256 digest,
`availability: available`, the owner's 2 MiB canonical byte cap and `@rezics/document` validation.
That byte cap also bounds the possible JSON node count and depth; the document validator owns
profile and traversal validity. At most 30 MiB of canonical bodies fit before other reads reduce the allowance.
Missing, erased or currently undisclosed bodies are absent. Other owner failures retain their
status. Every request releases its native owner connection and admission slot before a dependent
read. Actor, request deadline, cancellation and merged session follow the standalone operations.
Bodies have request-local lifetime; aggregate and SSR responses are `private, no-store`.
