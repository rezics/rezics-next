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

A node in `content` has depth 1. A node in a slot of a depth-d node has depth d + 1. Size is
checked first. A document over the node budget returns only the node limit, including when it
is also too deep. A document inside that budget and past the depth limit returns only that
depth violation.

## Safety

Every string a registry admits is one of:

- `plainText({ maxLength })`: no control character other than tab and newline, and no `<`
  followed by an ASCII letter, `/`, `!` or `?` (`3 < 4` is text; `<b>` is not);
- `href()`: at most 2,048 characters. A site path starts with `/`, the next character is not
  `/` or `\`, and the value contains no whitespace, backslash, `<`, `>`, `"` or `'`. An
  absolute `https:` URL has a host name, an optional port and no user information. Any other
  scheme, a protocol-relative URL or a control character is refused;
- `curie()`: `^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*$`, at most 128 characters;
- a TypeBox literal or a union of literals.

`defineRegistry` throws when a string is anything else. The message includes `<Type>.<prop>`.
The same rules are patterns on the generated JSON Schema, so a consumer that only validates
against that schema applies the same safety.

## Violations

`validateComposition` returns `{ pointer, code }[]` with RFC 6901 pointers.

| Code           | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `invalid`      | Envelope or value shape, an unknown key, a missing required key, or a schema mismatch |
| `unknown_type` | `type` is not registered; that node's props are not checked                           |
| `unsafe`       | A string fails a plain-text, link or CURIE pattern                                    |
| `duplicate`    | A repeated `props.id` after its first occurrence                                      |
| `limit`        | Canonical size, node count or depth                                                   |

Document order visits a node before its slot children, and slots in registry order. One
violation is kept per pointer, and `unsafe` wins over `invalid`. Results are sorted by
pointer in code-unit order and capped at 64.

## Platform registry

`platformRegistry` is the layout vocabulary. Data components that read the page subject are
added separately. Root props are `{ appearance?: Appearance }`. `APPEARANCE` closes the
tokens: `density` (`compact` or `comfortable`), `radius` (`sm`, `md` or `lg`), `surface`
(`flat` or `cards`), `cover` (`portrait`, `square` or `landscape`) and `headingScale` (`md`
or `lg`). Every token is optional. Colours and type faces are not tokens; pages share the
REZICS visual language.

| Component | Props                                        | Slots          |
| --------- | -------------------------------------------- | -------------- |
| `Stack`   | `gap`: `sm`, `md` or `lg`                    | `children`     |
| `Columns` | `split`: `even`, `start` or `end`            | `start`, `end` |
| `Heading` | `text` (plain text, 200), `level`: 2, 3 or 4 |                |
| `Text`    | `text` (plain text, 2,000)                   |                |
| `Slot`    | `name`: one of `SLOT_NAMES`                  | `children`     |

`SLOT_NAMES` is `header`, `hero`, `entity`, `aside` and `footer`. `Slot` is the platform's
rendering; reviewed first-party Zone code may wrap or replace it.

`bun scripts/schema.ts` writes `schema/composition-v1.schema.json` from this registry.
`bun scripts/schema.ts --check` fails when that file is stale. The schema covers the closed
shape and the safety patterns. Runtime validation also enforces size, node count, depth and
unique ids.
