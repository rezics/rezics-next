# Reactjs Tiptap Editor controls

Source: [Reactjs Tiptap Editor 1.0.48](https://github.com/hunghg255/reactjs-tiptap-editor/tree/496b84967ef58b85465edb1c4eae517de11fba73),
revision `496b84967ef58b85465edb1c4eae517de11fba73`. The adjacent MIT license applies to the adapted source.

| Local source                         | Upstream source                                                                                 | Adaptation                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `action-button.tsx`                  | `src/components/ActionButton.tsx`                                                               | Local Base UI controls, accessible names, explicit pressed state, existing toolbar focus ownership.                                                                                                                                                                                                                                                                      |
| `table-controls.tsx`                 | `src/components/Bubble/RichTextBubbleTable.tsx`                                                 | Complete row/column, merge/split and delete control groups; local editor/locale/visit props replace global stores. Controls stay in the document's interface flow, with the public command menu on narrow screens and an accessible toolbar on wider screens.                                                                                                            |
| `table-labels.ts`                    | `src/locales/en.ts` table action names                                                          | Existing labels can override each action; per-instance inherited interface language supplies defaults for all eight supported locales. Document language stays independent.                                                                                                                                                                                              |
| `command-list.tsx`, `block-menu.tsx` | `src/extensions/SlashCommand/{renderCommandListDefault.ts,components/SlashCommandNodeView.tsx}` | Format/insert groups, aliases, icons, query filtering and active-item traversal use installed shadcn Command. The existing slash plugin owns editor focus/IME and range admission; the explicit block picker uses the public responsive Menu. No global command signal or event bus is retained.                                                                         |
| `create-table.tsx`                   | `src/extensions/Table/components/CreateTablePopover.tsx`, `src/constants/index.ts`              | Retains the 10×10 grid, 2×2 initial size, pointer hit testing/capture and drag selection. Adds keyboard grid travel, numeric dimensions, a visible header-row choice and localized labels. The existing responsive dialog keeps the size draft mounted across presentation changes.                                                                                      |
| `link-controls.tsx`                  | `src/extensions/Link/components/{LinkEditBlock.tsx,LinkViewBlock.tsx}`                          | Labeled URL field, validation, apply/cancel and open/edit/unlink composition use local Base UI controls. The adapter captures an exact mark range, preserves the original caret and rejects retired commands. Text replacement and target rewriting are omitted to preserve annotated text and existing link attributes; URLs still pass the existing safe-URL boundary. |
| `image-upload.tsx`                   | `src/components/SlashDialogTrigger/RenderDialogUploadImage.tsx`                                 | Upload dialog, native file chooser, alt field and explicit insertion use the existing responsive dialog and upload port. File/alt state survives presentation changes. URL insertion, blob persistence, cropping, inline-image schema, global editor state and demo upload services are omitted: media IDs and authorization remain host-owned.                          |
| `control-labels.ts`                  | REZICS locale adapter                                                                           | Optional control labels retain existing caller maps and inherit interface language independently of document language.                                                                                                                                                                                                                                                   |

The adapter in `../../editor-table-commands.ts` supplies maintained ProseMirror table operations, selection,
paste, resizing and cell navigation against the existing table nodes. It does not import upstream schema,
history, persistence, service clients or global stores. Header row/column actions extend the upstream groups.
All controls use the current editor instance and existing document IDs, attributes, schema and history.
Formatting and history controls in the existing touch and selection toolbars use the adapted `ActionButton`.
The table toolbar supports Alt+F10 entry, a single visible Tab stop, directional arrow/Home/End travel and
Escape return. Cell navigation and column resizing come from the maintained table implementation.

Table creation adapts the selected dimensions through `../../editor-table-commands.ts`, using one transaction
for slash removal and insertion. Canceling keeps the typed slash; a changed or retired target cannot insert.
The original blank paragraph retains its identity following the new table, or in its required leading position
inside a list item. Paragraph conversion
is available in both block entry points. The existing labeled toolbar, docked touch presentation and wrapping
caller action slot remain in place.

The link and image files outside this directory retain only their range/node-view/upload integration alongside
the adopted presentation. Link draft text survives equal controlled echoes; changing its captured content retires
it. Deferred focus does not reclaim another control that received focus after dismissal. Image alt editing also
restores the existing node view's missing `getPos` binding. No engine, dependency, document schema or host workflow
was replaced, and no HTML/Markdown conversion was introduced.

Acceptance remains deferred: no tests, type checks, lint, formatter, build, install or browser verification ran.
After source integration, the next independent outcome is one existing-document journey: use block and inline
formatting, insert a chosen table through both entry points, cancel a size draft, undo/redo, edit one of two
adjacent links, cancel a media insertion, then save and return through a caller's existing port. Include keyboard,
touch, IME, RTL, controlled echoes, read-only transitions and two simultaneous editors. These controls are source
delivery, not a runtime or accessibility acceptance claim.
