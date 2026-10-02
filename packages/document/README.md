# REZICS Document

An independent, Apache-2.0 content contract with reference validation and
ProseMirror schemas. It requires no REZICS account, service, database, RDF graph
or browser. The package contains TypeScript ESM source, usable in Bun and
TypeScript bundlers; its JSON Schemas are language-independent.

## Profiles

The shared structure is ProseMirror JSON: nodes have `type`, optional `attrs`
and `content`; text nodes have `text` and optional `marks`. Node names follow
Tiptap's maintained extensions so editing does not require a second document
format. These are REZICS's versioned profiles of that model, not an upstream
ProseMirror interchange standard.

| Contract      | Responsibility                                                                                | Machine-readable artifact                                 |
| ------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Document Core | Snapshot envelope and common node/mark shape                                                  | [Core schema](schema/rezics-document-core-v1.schema.json) |
| Text          | Paragraphs, headings, quotations, lists, tasks, code, links, language, ruby and text emphasis | [Text schema](schema/rezics-text-v1.schema.json)          |
| Blocks        | Text plus tables, images, media and opaque components                                         | [Blocks schema](schema/rezics-blocks-v1.schema.json)      |

```ts
import { fromPlainText, parseDocument, serializeDocument } from '@rezics/document';

const snapshot = fromPlainText('漢字\nSecond paragraph');
parseDocument(snapshot);
const stored = serializeDocument(snapshot);
```

```json
{
  "version": "rezics-document-v1",
  "profile": "text",
  "doc": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "attrs": { "id": "p1", "lang": "zh-Hant-TW" },
        "content": [
          {
            "type": "ruby",
            "attrs": { "rt": "ㄏㄢˋ", "position": "inter-character" },
            "content": [{ "type": "text", "text": "漢" }]
          }
        ]
      }
    ]
  }
}
```

## Interoperability

`version` and `profile` are required. Text is a subset of Blocks. Core alone
establishes the JSON shape, not profile conformance. The profile schemas reject
undeclared node types, marks and attributes so editor deserialization cannot
silently discard them. Runtime validation additionally checks ProseMirror
content expressions, table spans and unique IDs. Lists require a leading
paragraph in each item; table cells contain blocks. An empty editable document
contains one empty paragraph. Empty paragraph content can be omitted.

Every block, table row, table cell and opaque inline component has a nonempty
`attrs.id`, unique within its snapshot. IDs remain on moved or edited units;
copies receive new IDs. Splits retain the original ID on one resulting unit;
merges retain one participating ID. `withDocumentIds` preserves existing unique
IDs and assigns absent/duplicate IDs without changing the source object. IDs
identify units within a document; precise external references also pin the
document revision. Ordinary text spans do not receive permanent IDs.

`normalizeDocument` applies declared defaults, ProseMirror mark ordering and
adjacent-text merging. `parseDocument` preserves supplied JSON after validation.
`serializeDocument` normalizes and sorts object keys deterministically; arrays
retain their order. This serialization is not a general RFC 8785 implementation.
Whitespace and Unicode normalization in authored text are preserved.

Normalized snapshots, including those from `fromPlainText` and `fromMarkdown`,
are deeply frozen; copy one (for example with `structuredClone`) to change it.
Freezing lets the package recognize a block it already checked by identity, so
an editor that keeps unchanged blocks between edits pays only for the blocks it
changed. The published JSON Schemas define validity; the runtime checks each
node type's shell without resolving schema references, and the tests compare
both on mutated documents.

Language tags use [BCP 47](https://www.rfc-editor.org/rfc/rfc5646); spelling is
preserved and structural tag syntax is checked, without a registry lookup.
`dir` uses HTML's `ltr`, `rtl` and `auto`. Ruby is a base-text sequence plus one
`rt` string, with positions from [CSS Ruby](https://www.w3.org/TR/css-ruby-1/).
It does not represent every complex HTML ruby pairing. `textEmphasis` uses the
shape, fill and position vocabulary from
[CSS Text Decoration](https://www.w3.org/TR/css-text-decor-3/).

`documentParagraphs` returns ordered `{id, text}` leaf units, including image
alt text, media captions and component fallbacks. Ruby annotation text is
excluded from the base-text projection; hard breaks become newlines.
`documentText` joins units with newlines. The projection is for search and
plain-text display, not a lossless export or a ProseMirror position map.

## Components and exchange

`extensionBlock` and `extensionInline` are opaque atoms with `definition`,
`version`, arbitrary JSON `payload` and plain `fallback` attributes. Blocks
also have the common language/direction attributes. A consumer may display the
fallback while preserving every payload field. Definitions can identify
versioned [Vega-Lite](https://vega.github.io/vega-lite/docs/),
[GeoJSON](https://www.rfc-editor.org/rfc/rfc7946),
[JSCalendar](https://www.rfc-editor.org/rfc/rfc8984), or other existing payloads;
that definition owns payload validation. The document contract does not load
component code. REZICS service resource references and authorization remain
application responsibilities.

`fromMarkdown` imports CommonMark through `prosemirror-markdown`, with the
existing Reddit-style `>!spoiler!<` spelling mapped to a `spoiler` mark. It preserves
inline HTML as literal text and promotes inline images to Blocks image nodes,
splitting surrounding paragraphs as necessary. A Text import with images fails
instead of dropping media. Markdown and plain-text projections cannot preserve
all document features. `parseStoredDocument` is only for application-owned
serialized draft storage; authored JSON text must not be inferred as a document
at an API boundary.

Renderers treat documents as untrusted data: use text/attribute APIs, admit safe
link and media URL schemes, and never execute extension payloads. Content
validation does not grant authority to a resource reference.

Profile changes that alter meaning or reject an existing valid snapshot require
a new document version. Additional advanced payloads use versioned component
definitions rather than new basic text models. A consumer unable to represent
a component retains it as an opaque atom or reports that conversion is lossy.

## Reference implementation

Basic text, lists and tables reuse maintained
[ProseMirror schemas](https://github.com/ProseMirror/prosemirror-schema-basic),
[list mechanics](https://github.com/ProseMirror/prosemirror-schema-list), and
[table mechanics](https://github.com/ProseMirror/prosemirror-tables).
`documentSchema` defaults to Blocks; `textDocumentSchema` and
`blocksDocumentSchema` select explicit acceptance profiles. Schemas are
regenerated by `task document:gen`, with focused invariants under
`tests/document.test.ts`.
