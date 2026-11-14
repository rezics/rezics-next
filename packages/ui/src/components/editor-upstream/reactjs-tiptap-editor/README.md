# Reactjs Tiptap Editor controls

Source: [Reactjs Tiptap Editor 1.0.48](https://github.com/hunghg255/reactjs-tiptap-editor/tree/496b84967ef58b85465edb1c4eae517de11fba73),
revision `496b84967ef58b85465edb1c4eae517de11fba73`. The adjacent MIT license applies to the adapted source.

| Local source | Upstream source | Adaptation |
| --- | --- | --- |
| `action-button.tsx` | `src/components/ActionButton.tsx` | Local Base UI controls, accessible names, explicit pressed state, existing toolbar focus ownership. |
| `table-controls.tsx` | `src/components/Bubble/RichTextBubbleTable.tsx` | Complete row/column, merge/split and delete control groups; local editor/locale/visit props replace global stores. Controls stay in the document's interface flow, with the public command menu on narrow screens and an accessible toolbar on wider screens. |
| `table-labels.ts` | `src/locales/en.ts` table action names | Existing labels can override each action; per-instance inherited interface language supplies defaults for all eight supported locales. Document language stays independent. |
| `command-list.tsx`, `block-menu.tsx` | `src/extensions/SlashCommand/{renderCommandListDefault.ts,components/SlashCommandNodeView.tsx}` | Format/insert groups, aliases, icons, query filtering and active-item traversal use installed shadcn Command. The existing slash plugin owns editor focus/IME and range admission; the explicit block picker uses the public responsive Menu. No global command signal or event bus is retained. |
| `create-table.tsx` | `src/extensions/Table/components/CreateTablePopover.tsx`, `src/constants/index.ts` | Retains the 10×10 grid, 2×2 initial size, pointer hit testing/capture and drag selection. Adds keyboard grid travel, numeric dimensions, a visible header-row choice and localized labels. The existing responsive dialog keeps the size draft mounted across presentation changes. |
| `control-labels.ts` | REZICS locale adapter | Optional control labels retain existing caller maps and inherit interface language independently of document language. |

The adapter in `../../editor-table-commands.ts` supplies maintained ProseMirror table operations, selection,
paste, resizing and cell navigation against the existing table nodes. It does not import upstream schema,
history, persistence, service clients or global stores. Header row/column actions extend the upstream groups.
All controls use the current editor instance and existing document IDs, attributes, schema and history.
Formatting and history controls in the existing touch and selection toolbars use the adapted `ActionButton`.
The table toolbar supports Alt+F10 entry, a single visible Tab stop, directional arrow/Home/End travel and
Escape return. Cell navigation and column resizing come from the maintained table implementation.

Table creation adapts the selected dimensions through `../../editor-table-commands.ts`, using one transaction
for slash removal and insertion. Canceling keeps the typed slash; a changed or retired target cannot insert.
The original blank paragraph retains its identity as the paragraph following the new table. Paragraph conversion
is available in both block entry points. The existing labeled toolbar, docked touch presentation and wrapping
caller action slot remain in place.

Link and media composition remains assigned to the shared editor owner. Source delivery does not establish
runtime, keyboard, touch, IME, RTL, screen-reader or caller save/publication acceptance.
