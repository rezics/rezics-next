# Reactjs Tiptap Editor controls

Source: [Reactjs Tiptap Editor 1.0.48](https://github.com/hunghg255/reactjs-tiptap-editor/tree/496b84967ef58b85465edb1c4eae517de11fba73),
revision `496b84967ef58b85465edb1c4eae517de11fba73`. The adjacent MIT license applies to the adapted source.

| Local source | Upstream source | Adaptation |
| --- | --- | --- |
| `action-button.tsx` | `src/components/ActionButton.tsx` | Local Base UI controls, accessible names, explicit pressed state, existing toolbar focus ownership. |
| `table-controls.tsx` | `src/components/Bubble/RichTextBubbleTable.tsx` | Complete row/column, merge/split and delete control groups; local editor/locale/visit props replace global stores. Controls stay in the document's interface flow, with the public command menu on narrow screens and an accessible toolbar on wider screens. |
| `table-labels.ts` | `src/locales/en.ts` table action names | Existing labels can override each action; per-instance inherited interface language supplies defaults for all eight supported locales. Document language stays independent. |

The adapter in `../../editor-table-commands.ts` supplies maintained ProseMirror table operations, selection,
paste, resizing and cell navigation against the existing table nodes. It does not import upstream schema,
history, persistence, service clients or global stores. Header row/column actions extend the upstream groups.
All controls use the current editor instance and existing document IDs, attributes, schema and history.
Formatting and history controls in the existing touch and selection toolbars use the adapted `ActionButton`.
The table toolbar supports Alt+F10 entry, a single visible Tab stop, directional arrow/Home/End travel and
Escape return. Cell navigation and column resizing come from the maintained table implementation.

This bounded adoption covers table editing and shared action controls. The broader block/slash, table-size picker,
link and media composition remains assigned to the shared editor owner. Source delivery does not establish
runtime, keyboard, touch, IME, RTL, screen-reader or caller save/publication acceptance.
