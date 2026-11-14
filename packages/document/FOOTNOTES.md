# Footnote integration

The public producer is already implemented: Document snapshot, schema, Markdown and editor support is in
`c05e8da6337fcad86488415e8de02128741772e3`; shared reading disclosure is in
`2fb77c76565f2098eb3a6d044858c3e13284a978`. Both implementations are included in base
`4188156508ebba95d4ef9727491c465c68bfeac7`. These are implementation revisions, independent of this integration brief.

Decision: retain this delivered representation and shared `DocumentBody` controls; consumer integration supplies
localized labels and explicit source/revision/visit identity without introducing a second footnote format.

## Snapshot and validation

Import `DocumentSnapshot`, `parseDocument`, `normalizeDocument`, `serializeDocument`, `fromMarkdown` and
`withDocumentIds` from `@rezics/document`. Footnotes are additive under `rezics-document-v1`, in both `text` and
`blocks`; existing snapshots keep their meaning. The ordinary document envelope contains:

```json
{
  "version": "rezics-document-v1",
  "profile": "text",
  "doc": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "attrs": { "id": "body" },
        "content": [
          { "type": "text", "text": "A finding" },
          { "type": "footnoteReference", "attrs": { "label": "Source-1" } }
        ]
      },
      {
        "type": "footnoteDefinition",
        "attrs": { "id": "source-definition", "label": "Source-1", "lang": "en" },
        "content": [
          {
            "type": "paragraph",
            "attrs": { "id": "source-paragraph" },
            "content": [{ "type": "text", "text": "Supplied source detail" }]
          }
        ]
      }
    ]
  }
}
```

References are inline atoms with a case-sensitive `label`. Labels match
`[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. Definitions are top-level nodes with the ordinary unique `id`, optional `lang`
and `dir`, the matching label and one or more ordinary profile blocks. Definition bodies can retain formatting,
links, lists and, in Blocks, tables/media/components. They cannot contain footnote references or definitions.
Each label has at most one definition, every reference resolves, and repeated references share that definition.
Unreferenced definitions remain valid and preserved; the reader displays disclosures for referenced definitions.

The public language-independent artifacts are `@rezics/document/schema/rezics-document-core-v1.schema.json`,
`@rezics/document/schema/rezics-text-v1.schema.json` and
`@rezics/document/schema/rezics-blocks-v1.schema.json`. Core owns the envelope and common shape; Text and Blocks
declare their footnote nodes and attributes. Runtime `parseDocument`/`checkDocument` additionally enforce unique
block IDs, definition labels, resolution, placement and the ban on nested footnotes. Validate imported/HTTP snapshots
at their existing boundary; internal consumers use the admitted snapshot unchanged.

## Editing, import and submission

The existing `RichTextEditor` public entry (`@rezics/ui`) accepts these snapshots. Both profile extension sets retain
references as inline atoms and definitions as editable, draggable top-level units, including their IDs, labels and
formatted content. Editing ordinary text or a definition does not rebuild the snapshot from its text projection.
Keep using the editor's validated `onChange` snapshot for submission, with its existing pending/error contract.

`fromMarkdown(markdown, profile)` imports `[^Source-1]` and top-level `[^Source-1]: detail` definitions. Four-space
continuations retain additional Markdown content. Definitions are appended in source order after ordinary body
blocks; fenced examples remain code. Invalid links such as an unresolved label fail import rather than dropping a
reference. `withDocumentIds` assigns absent IDs while preserving unique existing IDs. Normalization and canonical
serialization retain the footnote structure; `documentText` writes reference markers and includes definition text,
but is a projection, never a submission or editing format.

Decision: Markdown reference tokens carry typed `{ label }` metadata; definition DOM import reads IDs, language and
direction from the same `data-block-id`, `lang` and `dir` attributes emitted by the schema.

## Shared reading controls and messages

Import `DocumentBody` from `@rezics/ui/document-body`. Pass the full snapshot as `document`. Each reference is a local
link to a native focusable `summary`; each referenced definition has one initially closed `details` disclosure in a
labelled Footnotes region. Repeated references share the target; separate reader instances receive separate targets
even for identical snapshots. Enter follows a reference, and the summary's native Enter/Space behavior opens and
closes the disclosure. Definition content mounts only while open and uses the shared document renderer, preserving
authored attributes and existing URL/media safety. No reference, attachment or media fetch is added.

The `labels` prop accepts these strings; `locale` alone does not translate controls:

| Public label   | English default | Web message to supply in its existing document wrapper |
| -------------- | --------------- | ------------------------------------------------------ |
| `goToFootnote` | Go to footnote  | `document_go_to_footnote`                              |
| `footnote`     | Footnote        | `document_footnote`                                    |
| `footnotes`    | Footnotes       | `document_footnotes`                                   |

The first two strings are prefixes: the renderer appends a space and the supplied label. The third names the region.
Keep the existing spoiler/task/component/image labels. Web adds these messages in every supported locale and passes
them through `apps/web/src/document-body.tsx`; footnote bodies retain their authored language independently.

## Disclosure lifetime

`DocumentBody` owns disclosure per mounted reader. Changed structural document content or a changed `visitKey`
retires footnotes and spoilers before replacement content commits. Equal content, including reordered object keys,
keeps disclosure within the same visit; changes to labels, locale, styling or callbacks also keep it. A new object
with equal bytes alone is not a new shared-reader visit. Callers must change `visitKey` or remount the reader for a
new source/revision/reading visit even when bytes are equal. Returning from A to B to A starts closed each time.

Own drafts continues through its existing `OwnDraftBodyPreview` → `PostReadingBody` → shared `DocumentBody` path.
`PostReadingBody` already retires its reading visit on document object, `readerIdentity` or `wideVisitKey` replacement.
`OwnDraftBodyPreview` includes `source` and `visitKey` in its identity and supplies the current-reader guard. Keep server,
browser and readback identities independent; a readback never inherits submitted-preview disclosure. Keep the
acknowledged submitted snapshot/source/revision separate from a later current-read snapshot.

## Consumer acceptance and named stories

Extend the existing Own-drafts resume and command suites and retain unrelated assertions. Use different supplied
footnotes for server, browser and later readback; inspect them before explicit body choice, preserve the chosen
snapshot through editor changes and command submission, and assert independent acknowledgement and current read.
Cover independent readers, changed documents, equal-byte visit replacement, and returning to an earlier source.
Retain native assertions and extend native footnote acceptance where the existing fixture supplies structured bodies.

Extend these existing stories in `apps/web/src/stories/own-drafts.stories.tsx`:

| Named state                                                                                                                                                          | Footnote acceptance                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `StructuredServer`                                                                                                                                                   | Inspect supplied server notes before choosing that body.                            |
| `StructuredRecovery`                                                                                                                                                 | Independent server/browser notes; explicit browser choice preserves its snapshot.   |
| `BrowserUnknown`                                                                                                                                                     | Browser notes remain inspectable while resume stays disabled.                       |
| `StructuredSaveReadback`                                                                                                                                             | Submitted notes stay in acknowledgement; current read uses its own notes and visit. |
| `StructuredPublishedReadback`                                                                                                                                        | The same separation after publication.                                              |
| `StructuredGerman`, `StructuredSpanish`, `StructuredFrench`, `StructuredJapanese`, `StructuredKorean`, `StructuredSimplifiedChinese`, `StructuredTraditionalChinese` | Localized footnote controls preserve authored content.                              |

Focused producer acceptance lives in Document `document.test.ts` and `contract.test.ts`, and UI
`document-extensions.test.ts`, `document-body.test.ts` and `document-disclosure-lifetime.test.tsx`.
Compiler, suite execution, native checks, rich-document browser/keyboard and visual review are separate verifier work;
source availability does not establish a pass.
