# @rezics/composition

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

| Component        | Props                                                                       | Slots          |
| ---------------- | --------------------------------------------------------------------------- | -------------- |
| `Stack`          | `gap`: `sm`, `md` or `lg`                                                   | `children`     |
| `Columns`        | `split`: `even`, `start` or `end`                                           | `start`, `end` |
| `Heading`        | `text` (localized text, 200), `level`: 2, 3 or 4                            |                |
| `Text`           | `text` (localized text, 2,000)                                              |                |
| `Slot`           | `name`: one of `SLOT_NAMES`                                                 | `children`     |
| `SubjectHeader`  | none                                                                        |                |
| `Statements`     | `properties`: 1–32 unique `curie()` values                                  |                |
| `MoreStatements` | none                                                                        |                |
| `SubjectList`    | `title` (localized text, 120), `property`: `curie()`, `limit`: integer 1–24 |                |

`SLOT_NAMES` is `header`, `hero`, `entity`, `aside` and `footer`. `Slot` is the platform's
rendering; reviewed first-party Zone code may wrap or replace it.

All four data components read nothing when `page.subject` is `null`. `SubjectHeader`,
`Statements` and `MoreStatements` otherwise read the page subject. `Statements` shows the
named properties; `MoreStatements` shows the subject's statements whose properties no
`Statements` node on the page names. `shownProperties(document)` lists those named properties
once, in document order. `SubjectList` reads subjects whose `property` statement points at the
page subject, sorted by name and bounded by `limit`.

## Read planning

A component definition may supply `read(props, page)`, where `page` is
`{ subject: string | null }`, returning a `PageRead` or `null`. This function is code owned by
the registry. It is absent from the generated JSON Schema, and documents cannot name reads.
`PageRead` is either:

```ts
{ kind: 'subject'; id: string }
// GET /v1/subjects/{id}

{ kind: 'search'; body: {
  filter: { statement: { property: string; in: string[] } };
  sort: 'name';
  limit: number;
} }
// POST /v1/subjects:search
```

`SubjectList` uses its `property` and `limit` with `in: [page.subject]`.
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

`Heading.text` (200), `Text.text` (2,000) and `SubjectList.title` (120) are
`localizedText`. A string is checked as `plainText`. An object reports a bad key as
`invalid` at that key, a bad value as `unsafe` or `invalid` at that value, and too few or
too many entries as `invalid` at the property. Any other JSON value is `invalid` at the
property.

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
