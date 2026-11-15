# REZICS Editor

`@rezics/editor` owns reusable editing and static reading over `@rezics/document`. The
[editor product contract](../../docs/editor.md) defines supported authoring, preferences and acceptance.
Hosts supply document identity, authorization, media, mentions, saving and publication.

## Public entries

- `@rezics/editor`: `RichTextEditor`, labels, props, upload types and mention-source types.
- `@rezics/editor/reader`: `DocumentBody`, reader labels/types, `DocumentSpoiler`, `Prose` and safe URLs.
- `@rezics/editor/schema`: the React-free shared Tiptap extensions and profile selection.
- `@rezics/editor/preferences`: the pure preference model, validation and preset defaults.
- `@rezics/editor/styles.css`: shared reader/editor typography; import after `@rezics/ui/styles.css`.

The static reader never imports the editing entry. Editor depends on UI primitives and Document; UI has no
editor dependency or re-exports. Preference consumers may import the pure leaf without React or browser APIs.

## Development

Run `bun run storybook` to use the existing shared UI Storybook on port 6007. Moved stories retain their titles
and IDs. The composed published review entry is `/ui/?path=/story/editor-overview--catalogue`; it links the
implemented editor review states. Host save, publication and native acceptance remain separately scheduled.
Build with `bun run --cwd packages/editor storybook:build`. Publish a source-only development snapshot with
`bun run --cwd packages/editor storybook:deploy -- --local --source-only`. Both call the existing Web scripts;
the combined Web and `/ui/` output already includes Editor. Extra arguments are forwarded.
Run `bun run typecheck` for types and `bun run test <file>` for a focused package test. Browser tests
reuse UI's Storybook configuration and existing routed private-network runner; they select only editor stories.
`bun run test:stories:slow-frames` uses the shared delayed-frame setup. UI's own suite selects only UI stories.

Preference enum and scope controls use native pickers for their short fixed catalogues, retaining the operating
system's touch/keyboard affordances and browser accessibility. The longer command catalogue supplies search.

## Integration

Adopt the complete controls and interaction composition of
[Reactjs Tiptap Editor 1.0.48](https://github.com/hunghg255/reactjs-tiptap-editor/tree/496b84967ef58b85465edb1c4eae517de11fba73)
at revision `496b84967ef58b85465edb1c4eae517de11fba73` as the source for the shared editing experience.
Tiptap primitives and a locally assembled generic toolbar alone do not meet this requirement. Adapt the upstream
formatting, block/slash, link/media and table controls around the existing Tiptap instance, `RichTextEditor` public
contract and `@rezics/document` schema. Preserve the current pinned engine; upstream node definitions, a second
StarterKit, a second editor/history instance, demo persistence and external services are not part of this adoption.

Keep copied or substantially adapted source together with its upstream path, exact revision, local adaptation notes
and the upstream MIT copyright and permission notice. Reuse the complete applicable controls rather than only
their visual styling. Bind their action registry to the existing schema-aware commands and media/mention ports;
preserve stable block IDs, language/direction, ruby, footnotes, mentions, opaque extension payloads and table content.
Do not convert the document through HTML, Markdown or another block model to accommodate a control. Table controls
use maintained ProseMirror table mechanics against the existing table roles. Scope upstream global editable, locale
and slash state to the editing visit; a second editor or read-only preview cannot change another editor's state.

The source comparison considered these pinned alternatives:

| Product                                                         | Revision and license                                        | Decision                                                                                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reactjs Tiptap Editor                                           | `496b84967ef58b85465edb1c4eae517de11fba73`, MIT             | Adopt its complete Tiptap 3 control composition with the adapters above.                                                                                                              |
| [Tiptap UI](https://github.com/ueberdosis/tiptap-ui-components) | `799929bea4804c73767562b69f8acc2acdb8ac86`, MIT             | Public Simple template lacks the full table/slash experience; its accessible toolbar is an available adaptation source with its own notice. Paid templates are outside this adoption. |
| [Novel](https://github.com/steven-tey/novel)                    | `fa95098e66476c466faebb8211baa5869c101a9c`, Apache-2.0      | Inspected composition uses Tiptap 2 and lacks a complete table experience.                                                                                                            |
| [BlockNote](https://github.com/TypeCellOS/BlockNote)            | `58a40d2f55553110266de6bd644026b863ae5445`, MPL-2.0 core/UI | Complete block product, but its blockGroup/blockContainer schema would require a separate document-model migration; XL has separate GPL/commercial terms.                             |

The editor package owns command/schema adaptation, instance isolation, selection and composition continuity, translated
accessible names/pressed states, keyboard toolbar entry/travel and touch/RTL integration. These are explicit gaps
in the adopted source, not assumed library guarantees. Ordinary command menus still use the public `Menu`
contract; text-range formatting uses the editor selection layer. Domain hosts retain account/session replacement,
permission and disclosure, private-draft departure, uncertain commands, revisions, save/publication review and
authorized media access. These business rules justify custom integration; generic editor controls do not.

The first bounded source adaptation is in `src/components/editor-upstream/reactjs-tiptap-editor`: its action
control now serves the existing formatting/history toolbars, and its complete table action groups use the current
document schema through `editor-table-commands.ts`. Table selection/paste, row/column operations, merge/split,
headers, resizing and cell navigation share the existing editor/history instance. The upstream table bubble's
groups use an in-flow toolbar and the public responsive `Menu`; interface labels remain separate from document
language. The adjacent provenance identifies the copied/adapted source and retained MIT notice.

The adopted slash groups also supply the searchable block picker in the public responsive Menu, including a
return to Paragraph. Table insertion from either entry point opens the upstream 10×10 size grid, with keyboard
travel, explicit row/column inputs and a header-row choice. Its selection belongs to the current editing visit;
confirmation inserts in one transaction and cancellation keeps any typed slash. The original discoverable,
labeled formatting toolbar, docked touch controls and wrapping caller save/submit slot remain intact.

The adopted link view/edit blocks operate on an exact saved link extent, with URL validation, open/edit/unlink
actions and restoration of the original caret. The upload dialog keeps the chosen file and alt text through
responsive presentation changes, then enters the existing authorized attachment lifecycle. Link text, link
attributes, opaque media IDs and caller upload/save/publication behavior stay with their existing owners.
Changed or retired targets cannot dispatch an old control, and deferred focus respects newly focused controls.

Source is not usable-journey acceptance. Web owns subsequent rich-document round trips, table and
media operations, keyboard/touch/IME/RTL/screen-reader use, native undo, two-editor isolation and caller save/publish
continuity. Root owns publication and sampled review. Those checks are separately scheduled after the code-only window.

shadcn menus and sheets render in a portal on the page, not inside the story canvas, so a story finds them with `screen`. A layer that takes focus must hand it back through Tiptap's frame-deferred restore (`returnFocus` in `editor-selection-menu.tsx`); wait for the editor to hold focus before sending the next key. A controlled echo of the same document keeps the current ProseMirror selection and an open link draft; the address field returns focus only when the editor does not already hold it, and never restores a retired visit's selection.

The touch bar derives its one Tab entry from currently rendered and enabled controls. If its remembered command disappears, Tab enters at the first available control without moving focus during recovery.

Editing continuity keeps one active document, caret, undo history and upload lifecycle. Preview and history open on
demand within that visit. Save and publication remain explicit actions; an uncertain command retains its independent
frozen intent while newer edits stay in the working document.

Decision: native `beforeinput` history uses a visit-bound editor prop over the existing ProseMirror history;
the installed plugin's eager handler is disabled, and only an actually applied step consumes the event.
Native Edit-menu/mobile undo (`historyUndo`) and redo (`historyRedo`), keyboard undo (Ctrl/Cmd+Z) and redo
(Ctrl/Cmd+Shift+Z or Ctrl+Y) share the toolbar's native ProseMirror history.
The DOM boundary admits only a cancelable, uncanceled history input targeting the focused current editable canvas,
outside event or editor composition. Unavailable steps bubble; retired callbacks cannot affect a later equal document.
History commands report application only when dispatch changes editor state; an absent or filtered transaction bubbles.
Caller key handling runs first; only a handled shortcut is consumed, while composition, read-only mode and retired
visits cannot dispatch history commands. History commands keep editor focus. Hiding the mounted editor for preview
or version history retains its history; controlled echoes and editability toggles retain it too. An external document
replacement clears both history stacks in the existing editor, and a replaced editor starts with its own history.
Keyboard, native input and visit acceptance extend the existing touch-bar `UndoRedo` story; the focused
inline-lifetime regression runs it alongside `InlineLifetimeJourney`, keeping the existing story inventory.
Its authored `InputEvent`s illustrate one-step history, empty stacks, cancellation, composition, replacement and
retirement; they do not establish native Edit-menu or mobile behavior. Verifier acceptance still owes both named
history/lifetime regressions and ordinary Studio/Knowledge native history, keyboard parity and private replacement;
original launch acceptance remains owed. Input dispatch is O(1) plus the existing bounded history transaction, with
no reads, polling, storage, listener fanout or per-consumer state.

This shared history capability is inherited by Studio Book/Column ([workspace](../../apps/web/src/studio/workspace.tsx)),
[native drafts](../../apps/web/src/studio/native-draft-composer.tsx),
[Threads new/reply/revision](../../apps/web/src/threads/composer.tsx),
[Knowledge private pages](../../apps/web/src/knowledge/private-page.tsx), catalogue
[authored fields](../../apps/web/src/features/catalogue/authored-field-view.tsx),
[Manga fields](../../apps/web/src/features/catalogue/manga-profile-field.tsx) and
[Recipe editing](../../apps/web/src/features/catalogue/recipe-editor-view.tsx). Import inventory finds no exception
requiring a page-local history binding. Equal bytes from a different owner/session/source still require the host's
existing editor key/remount; equality cannot identify a new private draft.

The shared schema's [DOM round-trip contract](../document/README.md#interoperability) is inherited automatically by
every `RichTextEditor` host: Studio workspace (Book and Column), native draft composer, thread/reply composer,
Knowledge private editor, authored catalogue field, Manga field and Recipe editor. Caller workflow migrations remain
with their owners: [Studio](../../apps/web/src/studio/README.md) owns its canvas and navigation, with the
[shared editing visit](../../apps/web/src/studio/workspace-language.md) owning save/preview/publication continuity;
[Knowledge](../../docs/knowledge-workspaces.md#writer-and-reader-experience) owns its pending workspace migration.
The other hosts inherit the schema repair within their existing workflows. Native writer and publication authority
remain in those owner contracts and the [catalogue editing contract](../../docs/catalogue-editing.md).

`RichTextEditor` also supplies optional `onSnapshotPending()` and `onSnapshotError(rawNodes)` callbacks. Pending is synchronous with a document update, before the existing debounced validated `onChange`. An update whose document is the one last published is an echo and reports no pending, so it keeps Send enabled. Error supplies only the live unnormalized editor node tree, for explicit local recovery; it is never a valid snapshot or a submission signal. The caller must retire its callback work with its existing visit. This adds no storage or second publication path.

`RichTextEditor` accepts an optional `lookupMention(handle, signal)` source. After a 200 ms typing pause, `@handle` offers one exact account match; stale lookups are aborted, keyboard or pointer selection inserts an inline `mention` with only its `accountId`, and Escape keeps the typed text. Without a source, `@` stays plain text. `DocumentBody` accepts a `mentions` map of account ids to current handles and a `locale` (English by default); it renders localized agent links, or a plain `@` for unresolved accounts. Handles are rendered as text, never HTML.

`DocumentBody` derives visit identity from sorted-key structural JSON, so renderer-supported snapshots remain readable,
equivalent property-key orderings keep disclosure, and changed document content resets it before paint. A changed
`visitKey` also retires disclosure, including equal document bytes from a new source or revision. Reader option,
locale, class name and callback updates keep the current visit's disclosure. The
[footnote integration contract](../document/FOOTNOTES.md) defines the public controls, labels and caller obligations.

Decision: custom block mappings retain only authored common fields on their rendered output: `id` as `data-block-id`, plus `lang` and `dir`. A code or table callback that returns its supplied `defaultContent` keeps the existing semantic markup; a replacement output receives a block wrapper carrying those fields.

`Prose` is the surface for documents, in the reading page (`DocumentBody`) and in the editor. Body text is interface text. Only a Work title, marked with the `work-title` class, takes the serif face. A line holds about 65 characters (36 em for Chinese, Japanese and Korean, where a character is an em wide), and CJK text gets more leading. The styles live in `src/prose.css`. Mixed-script reading stories set `lang` on the existing wrapper around `DocumentBody` so that measure and leading inherit from the document language rather than the Storybook interface locale. Mixed-script editor review stories set document language with the editor `lang` prop and keep Storybook locale on the shell; chrome labels stay the caller-supplied defaults. 390 and 1280 remain viewport review inputs, not a narrowed inner canvas.
