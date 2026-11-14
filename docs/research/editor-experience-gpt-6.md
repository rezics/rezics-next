# Reusable editor experience

Inspected: 2026-11-15. Status: research recommendation; this report does not change the document contract or adopt a new product specification.

## Recommendation

Maintain `@rezics/editor` as a complete editing experience over Tiptap 3 and the existing `@rezics/document` contract. Use Docmost and Outline as primary references for the document workflow, AFFiNE and SiYuan for user preferences, Tiptap UI and reactjs-tiptap-editor for implementation, and BlockNote and Plate for block interactions. Umo is a useful additional reference for Chinese document authoring and view controls.

Reference quality and permission to reuse source are separate axes. Evaluate every useful product. Adapt source where its exact licence permits the intended use, retaining required notices; otherwise study public behaviour and implement it independently. Publicly visible code and commercial templates do not automatically grant redistribution rights. No upstream code was copied in this investigation.

The existing REZICS editor has substantial reusable functionality. It has not yet reached the completeness of a standalone editor product. Its most significant gaps are rich structural editing, settings exposed to users, and unified integration of existing host workflows. A package extraction should deliver these outcomes rather than only move files.

## Evidence and limits

The investigation read the current document contract, editor implementation, commands, related stories, writing inspection, settings interfaces and Studio document ports. Upstream source was retrieved through GitHub at the revisions listed below. Reference projects were not installed, built or executed from downloaded source.

Local Storybook was inspected with Chromium at 1280 × 900 and a touch context at 390 × 844. On desktop, selecting mixed Chinese/Latin text exposed the formatting toolbar. On the touch surface, the existing story converted a paragraph to a heading; reopening Blocks exposed the insertion sheet. Screenshots were captured and visually inspected. The JSON printed below the desktop surface is a story fixture diagnostic, not product UI.

No framework error overlay or uncaught page exception was observed in these two local flows. The desktop fixture emitted one resource 404 whose source was not classified; it is not a clean-console result. These observations do not prove the complete editor, publication lifecycle, native input methods, accessibility compliance or large-document performance. The broader existing test suite was inspected by source, not rerun.

The in-app browser host was unavailable. The Playwright MCP browser executable was also unavailable. Capture used the already installed Playwright package and Chromium executable, without installing dependencies. The local preview and browser processes were stopped after capture.

The live Plate homepage rendered its editor without page exceptions during capture. The public reactjs-tiptap-editor playground did not expose an editable surface and emitted `Cannot read properties of null (reading 'useId')`. This is an observation about that deployed demo, not proof that its current source or every integration fails. The Umo demo URL redirected to documentation, so its interactive demo was not assessed.

## Current REZICS maturity

| Capability | Existing implementation and exposure | Verification in this investigation | Remaining product work |
| --- | --- | --- | --- |
| Document integrity | Versioned Text/Blocks profiles, validation, normalization, canonical snapshots and document-local IDs | Contract and implementation read | Keep this authority when introducing external controls |
| Basic authoring | Headings, lists, task lists, quotations, marks, links, Markdown shortcuts and undo/redo | Source and stories read; desktop selection toolbar observed | Establish a consistent command surface and complete structural keyboard behaviour |
| Touch controls | Formatting bar, keyboard navigation and block insertion sheet | Touch story and reopened sheet observed at 390 px | Real-device soft keyboard and selection acceptance |
| Images | Paste/drop, upload status, retry, replacement and alternative text controls | Implementation and story scenarios read | Preserve upload lifetime and recovery in package integration; review resize/caption workflow |
| Mentions | Debounced exact-account lookup through an injected source | Implementation and stories read | Keep account lookup in the host; semantic references need their own authoring workflow |
| Tables | A command inserts a fixed three-by-three table; nodes preserve rows, cells and spans | Command and extension implementation read | Row/column actions, cell selection, merge/split, resizing, keyboard behaviour and safe paste |
| Block manipulation | Identity handling for moved units and a reordering story | Source read | Dedicated handles, discoverable block actions, keyboard movement and multi-block workflows |
| Domain notation | Ruby, language/direction, emphasis, spoilers and opaque extensions exist in the format or schema bridge | Contract, extension and command definitions read | Consistent creation/editing controls for the supported domain features |
| Saving and versions | Conditional revision, uncertain-result and stale-state handling exist in Web/Studio ports | Host source read | Present a consistent save/conflict/history workflow through host adapters; native lifecycle acceptance not repeated |
| Outline and inspection | A Web-owned writing inspection already offers summary, preview, outline and diagnostics | Source read | Reuse it or extract its generic part; avoid building a competing outline |
| User preferences | Editor props offer compactness, toolbar visibility and host controls; app settings cover other preference domains | Reviewed public props, editor files and settings types | A discoverable editor settings UI, persistence, reset, per-scenario defaults and runtime application |
| CJK input | Language-aware mixed-script stories and composition-aware code exist | Story explicitly describes composed text, not a native IME session | Actual Chinese/Japanese composition, selection, deletion, Enter and undo with native input methods |
| Large documents | Snapshot production has a 2 MiB byte ceiling and debounced publication | Source read | Measured typing, selection, paste, find and save performance on representative chapters and devices |

The principal owner files are [document contract](../../packages/document/README.md), [editor](../../packages/ui/src/components/rich-text-editor.tsx), [commands](../../packages/ui/src/components/editor-commands.ts), [schema bridge](../../packages/ui/src/components/document-extensions.ts), [snapshots](../../packages/ui/src/components/rich-text-editor-snapshot.ts), [mixed-script stories](../../packages/ui/src/components/editor-mixed-script.stories.tsx), [writing inspection](../../apps/web/src/threads/writing-inspection.ts), [Studio port](../../apps/web/src/studio/post-document-port.ts) and [preferences](../../apps/web/src/settings/preferences.ts).

In particular, storing table nodes does not supply a complete table editor. The reviewed editor registrations do not install the maintained table editing/resizing extension or expose row/column and cell operations. Likewise, supporting a node in a schema does not expose a usable control for authoring it. Maturity must be assessed at each of these layers.

## References ranked by the job they solve

### Complete document workflow: Docmost and Outline

Docmost is the closest primary reference for a modern knowledge document experience on React and Tiptap. Its editor component tree separates fixed and floating tools, slash commands, search/replace, tables, media, mentions, code, diagrams and document navigation. This is a better product completeness reference than an isolated formatting demo. Its actual user settings include page width, a fixed-toolbar preference and default edit mode; the fixed-toolbar setting is marked experimental in the inspected source.

Read: [editor component tree](https://github.com/docmost/docmost/tree/844828e285240f989065673ceaa3dc452f3082f2/apps/client/src/features/editor/components), [full editor](https://github.com/docmost/docmost/blob/844828e285240f989065673ceaa3dc452f3082f2/apps/client/src/features/editor/full-editor.tsx), [toolbar preference](https://github.com/docmost/docmost/blob/844828e285240f989065673ceaa3dc452f3082f2/apps/client/src/features/user/components/fixed-toolbar-pref.tsx), [width preference](https://github.com/docmost/docmost/blob/844828e285240f989065673ceaa3dc452f3082f2/apps/client/src/features/user/components/page-width-pref.tsx) and [edit-mode preference](https://github.com/docmost/docmost/blob/844828e285240f989065673ceaa3dc452f3082f2/apps/client/src/features/user/components/page-state-pref.tsx).

Outline is an equally valuable workflow and interaction reference. The inspected editor uses ProseMirror directly; it should not be described as a drop-in Tiptap component. Its source separates formatting, block, table, row, column, image and attachment menus. User preferences include document statistics, code line numbers, comment markers, separate versus seamless editing and smart text. These are useful examples of user choices affecting the writing environment rather than only developer configuration.

Read: [editor](https://github.com/outline/outline/blob/4554494ed88f66a12459cc6ab4dd1c8c9d551bf9/app/editor/index.tsx), [menus](https://github.com/outline/outline/tree/4554494ed88f66a12459cc6ab4dd1c8c9d551bf9/app/editor/menus) and [preferences](https://github.com/outline/outline/blob/4554494ed88f66a12459cc6ab4dd1c8c9d551bf9/app/scenes/Settings/Preferences.tsx).

Docmost core is AGPL-3.0 with separately licensed enterprise paths. Outline's inspected source is BSL-1.1 with an additional-use restriction. Both remain primary behaviour references; implementation strategy must account for the applicable source rights. Their application backends, permissions and persistence are not replacements for REZICS's existing owners.

### User preferences: AFFiNE and SiYuan

AFFiNE has an explicit typed editor settings schema. It distinguishes font family, custom font family, font size, full-width layout, document information, insertion affordances, new-document defaults, document-opening mode and code line numbers. This is particularly useful for designing a coherent preference model and defaults. Its underlying editor architecture differs from REZICS, so reuse the product separation and relevant patterns rather than adopting its document runtime as part of this work.

Read: [editor settings schema](https://github.com/toeverything/AFFiNE/blob/9c615502796516da5d0ff91bed1597b1476c7978/packages/frontend/core/src/modules/editor-setting/schema.ts). The repository licence identifies MIT-covered areas and exceptions for backend/native areas and incorporated components; check the exact file when adapting source.

SiYuan supplies the strongest inspected reference for detailed author control and keyboard customization. Its settings expose spellchecking, cursor context, block gutters, indentation, URL-paste conversion and numerous content-specific display choices. Its shortcut UI includes assigned/customized/unassigned/conflicting filters and reset behaviour. REZICS can adopt a much smaller set while preserving the underlying principle: settings are discoverable, explain their effect and can be reset.

Read: [editor settings](https://github.com/siyuan-note/siyuan/blob/be17ed1e0510bb6371cb8a162e16898a697fa118/app/src/config/tabs/editorTab.ts) and [shortcut settings](https://github.com/siyuan-note/siyuan/blob/be17ed1e0510bb6371cb8a162e16898a697fa118/app/src/config/tabs/keymapUi.ts). The inspected repository licence is AGPL-3.0. Its settings engine and editor runtime are not React/Tiptap components to install unchanged.

### React/Tiptap implementation: official UI and reactjs-tiptap-editor

The official [Tiptap Simple Editor](https://tiptap.dev/docs/ui-components/templates/simple-editor) is MIT-licensed and includes responsive formatting, lists, alignment, headings, images, links, search/replace and undo/redo. It is a useful maintained baseline for individual controls and mobile behaviour. The separate [Notion-like template](https://tiptap.dev/templates/notion-like-template) is a paid template; do not attribute its complete workflow to the free Simple Editor. Both can inform product behaviour, with different paths to obtaining or implementing code.

reactjs-tiptap-editor is the closest inspected source donor for the current React, Tiptap and shadcn stack. Its current 1.x API lets the host own the editor instance and compose controls, which is compatible in principle with a REZICS-owned schema. It has separate feature entry points and concrete table controls, resize support, search/replace, media, slash commands and other authoring tools.

Read: [1.x integration](https://github.com/hunghg255/reactjs-tiptap-editor/blob/496b84967ef58b85465edb1c4eae517de11fba73/docs/guide/getting-started.md), [table extension](https://github.com/hunghg255/reactjs-tiptap-editor/blob/496b84967ef58b85465edb1c4eae517de11fba73/src/extensions/Table/Table.ts), [table controls](https://github.com/hunghg255/reactjs-tiptap-editor/blob/496b84967ef58b85465edb1c4eae517de11fba73/src/components/Bubble/RichTextBubbleTable.tsx), [search/replace](https://github.com/hunghg255/reactjs-tiptap-editor/blob/496b84967ef58b85465edb1c4eae517de11fba73/src/extensions/SearchAndReplace/SearchAndReplace.ts) and [control configuration types](https://github.com/hunghg255/reactjs-tiptap-editor/blob/496b84967ef58b85465edb1c4eae517de11fba73/src/types.ts).

Its source is MIT-licensed. Nevertheless, importing every default extension would change the supported content model, visual primitives and CSS behaviour. The inspected package requests Tiptap `^3.33.0`, while REZICS pins `3.32.2`; integration must align workspace versions rather than introduce parallel incompatible copies. The guide's example version also trails its package metadata. Together with the public-demo failure, this makes it a promising source donor and integration candidate, not an already verified replacement.

Most of its configuration is a developer API. A host still has to supply the user's settings screen, persistence and reset behaviour.

### Block interactions: BlockNote and Plate

BlockNote has ready-made formatting, side menus, drag menus, suggestions, file panels and table handles, including a shadcn integration package. Study block discovery, movement, nesting, file operations and narrow-screen interaction. Its higher-level block model is not interchangeable with REZICS's existing document profiles.

Read: [React controls](https://github.com/TypeCellOS/BlockNote/tree/58a40d2f55553110266de6bd644026b863ae5445/packages/react/src/components), [formatting actions](https://github.com/TypeCellOS/BlockNote/blob/58a40d2f55553110266de6bd644026b863ae5445/packages/react/src/components/FormattingToolbar/FormattingToolbar.tsx) and [side menu](https://github.com/TypeCellOS/BlockNote/tree/58a40d2f55553110266de6bd644026b863ae5445/packages/react/src/components/SideMenu). The inspected core package is version 0.57.0 and declares MPL-2.0; XL packages have separate licensing. The [official terms](https://www.blocknotejs.org/legal/terms-and-conditions) distinguish these packages.

Plate provides a rich React component registry and editor kit over Slate. Its live editor was visually inspected. The useful reference is the command grouping, contextual controls, media, table, navigation and review interaction. Adapting these ideas does not require changing REZICS to Slate. The repository's Notion-like application template is separate from the public component registry.

Read: [editor registry](https://github.com/udecode/plate/tree/32e54c71582609ffbc8dd5fbb9618ac6fad11ffb/apps/www/src/registry/components/editor) and [editor kit](https://github.com/udecode/plate/blob/32e54c71582609ffbc8dd5fbb9618ac6fad11ffb/apps/www/src/registry/components/editor/plugins.ts). In particular, the file named [settings-dialog](https://github.com/udecode/plate/blob/32e54c71582609ffbc8dd5fbb9618ac6fad11ffb/apps/www/src/registry/components/editor/settings-dialog.tsx) explicitly identifies itself as demonstration-only and configures AI access/model choices. It is not evidence of a production editor-preferences subsystem. The root licence is MIT with package-specific exceptions.

### Additional useful references

Umo's open-source Vue 3/Tiptap 3 editor is useful for Chinese authoring, ribbon versus web-oriented controls, page options, zoom, outline, preview, theme and reset. Its source includes an actual theme menu backed by stored state, not just a theme prop. Study these user flows and adapt suitable extension logic; Vue controls need a React implementation. The inspected repository is MIT-licensed. The documentation also covers Next, Mobile and Server products, whose advertised features must not be assumed to belong to this open-source edition. Read [repository introduction](https://github.com/umodoc/editor/blob/aec4e45f6ea99ea94f878e638a9535c378a01baa/README.md), [default options](https://github.com/umodoc/editor/blob/aec4e45f6ea99ea94f878e638a9535c378a01baa/src/options/config/index.js), [view controls](https://github.com/umodoc/editor/tree/aec4e45f6ea99ea94f878e638a9535c378a01baa/src/components/menus/toolbar/view) and [page options](https://github.com/umodoc/editor/blob/aec4e45f6ea99ea94f878e638a9535c378a01baa/src/components/page-options.vue).

Milkdown Crepe is an MIT-licensed ProseMirror-based reference for a cohesive Markdown-first editing experience. Its builder composes clipboard, history, indentation, uploads and CommonMark/GFM features. Borrow suitable interactions; preserving REZICS's full JSON content through Markdown would require separate fidelity work. Read [builder](https://github.com/Milkdown/milkdown/blob/0655111f3bb8393e959ce3f3d107c83edce29c3a/packages/crepe/src/core/builder.ts).

Novel remains useful for a compact Notion-like composition, but the inspected default branch's latest commit is 2025-01-18. Its inspected licence is Apache-2.0. It should not be the primary maintenance reference without further evidence. Minimal Tiptap is MIT-licensed and appropriate for a small shadcn input, but that scope does not supply the requested complete authoring product. mui-tiptap is MIT-licensed and composable, but bringing its MUI presentation into REZICS would duplicate the current visual system. Read [Novel](https://github.com/steven-tey/novel/tree/fa95098e66476c466faebb8211baa5869c101a9c), [Minimal Tiptap](https://github.com/Aslam97/minimal-tiptap/tree/93b55598a206f809cd8d37a481d7391a829c6623) and [mui-tiptap](https://github.com/sjdemartini/mui-tiptap/tree/f5e3e62e1bdbeb5fb82e9751317772de4e18a82c).

## Proposed package boundary

`@rezics/document` continues to own the persistent format, profiles, identity rules, validation and canonical serialization. It remains independent of browser, account and application services.

`@rezics/editor` should own the Tiptap integration, domain editing controls, command metadata, fixed/floating/touch toolbars, slash and block menus, selection/history lifetime and the preference model/settings UI. Begin by extending the current shared command definitions; toolbar, slash menu, command search and shortcuts should consume the same command metadata.

Use separate exports for editing, static rendering and styles so a reader does not load an editor instance. The current `DocumentBody` imports the same schema bridge as the editor. If that bridge moves, migrate its consumer coherently. One workable arrangement puts `DocumentBody` and the bridge behind `@rezics/editor/reader` and schema exports, with both reader and editor using generic `@rezics/ui` primitives. `@rezics/ui` must then stop value-importing/re-exporting the moved editor. This preserves a one-way dependency from editor to UI and document rather than creating a package cycle. A final extraction should be checked against the module manifest.

Hosts continue to own persistence, permissions, publication selection, revisions, uploads, account/entity lookup, navigation and account preference storage. Inject adapters for these services. The editor may render their pending/error/conflict state but must not introduce parallel authorities. Preserve the existing snapshot-pending and raw-recovery distinction when extracting the component.

Provide writing, knowledge and compact presentation presets. Presets select appropriate controls and defaults over the supported profiles; they do not introduce separate persistent document formats.

## User customization contract to design

| Setting class | Useful first settings | Persistent effect |
| --- | --- | --- |
| Personal presentation | Typeface, text size, line spacing, writing width, toolbar mode, outline visibility | Changes the person's environment, not document JSON |
| Editing behaviour | Markdown shortcuts, spellchecking, URL conversion and default paste behaviour | Changes future input handling; existing content remains representable |
| Command layout | Visible/pinned controls and preferred order | Changes discovery; the command registry and schema retain meaning |
| Keyboard | Searchable bindings, conflict indicators and restore defaults | Applies without disrupting IME composition or essential platform shortcuts |
| Authored presentation | Headings, explicit alignment and semantic emphasis | Saved in the document when the profile admits it |
| Product capabilities | Allowed nodes, references and operations | Controlled by supported contracts and host authorization, not by personal preference |

Account-level preferences can provide defaults across devices. Session-only adjustments, such as temporarily showing an outline, should remain local unless the user elects to persist them. Offer immediate preview, explanations, save/error feedback and reset. Use the existing Accounts preference owner for synchronized storage instead of an editor-specific backend.

Hiding a control or turning off a creation shortcut must not remove the corresponding node from the parsing schema. An existing table remains a table when its insertion button is hidden. Applying a preference must retain current selection, undo history and the latest unsaved document. Support older saved preference versions through explicit defaults and migration.

The first product can expose bounded settings and templates plus developer extension hooks. A user-installable executable plugin ecosystem is a separate product contract, not a prerequisite for customization.

## Delivery outcomes to require

1. A writer opens a chapter, chooses comfortable typography and toolbar placement, writes with a native Chinese/Japanese input method, finds/replaces text, uses undo and returns to the same draft. Changing presentation does not change published content or reset editing history.
2. A knowledge author inserts a table, changes its structure and column widths, edits supported domain notation, moves content through pointer and keyboard controls, and sees the same semantics after save/reopen and in the reader.
3. A compact reply uses the same command rules with a smaller presentation. Multiple mounted editors retain independent menus, selection and uploads.
4. A user changes settings, sees them applied, restores defaults, and receives a clear result when account synchronization fails. Hidden tools leave existing content intact.
5. Existing host save, revision, conflict and publication operations are composed into the experience. Unknown save results remain recoverable; session undo and immutable revision history remain distinct.
6. Measured large-chapter and clipboard scenarios define the supported performance envelope. Representative native-device testing covers the virtual keyboard, composition, touch selection, menus, focus return and assistive navigation.

Complete these shared behaviours before treating a package move or a large collection of toolbar icons as delivery of a complete editor. Real-time team collaboration and computation remain subject to the current [public scope](../scope.md).

## Revision index

| Reference | Inspected revision | Commit date (UTC) | Inspected licence scope |
| --- | --- | --- | --- |
| Docmost | `844828e285240f989065673ceaa3dc452f3082f2` | 2026-11-14 | AGPL-3.0 core; enterprise exceptions |
| Outline | `4554494ed88f66a12459cc6ab4dd1c8c9d551bf9` | 2026-11-14 | BSL-1.1 and additional-use grant |
| AFFiNE | `9c615502796516da5d0ff91bed1597b1476c7978` | 2026-11-12 | MIT areas with backend/native/component exceptions |
| SiYuan | `be17ed1e0510bb6371cb8a162e16898a697fa118` | 2026-11-10 | AGPL-3.0 |
| reactjs-tiptap-editor | `496b84967ef58b85465edb1c4eae517de11fba73` | 2026-11-08 | MIT |
| BlockNote | `58a40d2f55553110266de6bd644026b863ae5445` | 2026-11-13 | MPL-2.0 core; separate XL terms |
| Plate | `32e54c71582609ffbc8dd5fbb9618ac6fad11ffb` | 2026-11-14 | MIT root; package/template exceptions |
| Umo | `aec4e45f6ea99ea94f878e638a9535c378a01baa` | 2026-10-30 | MIT inspected repository |
| Milkdown | `0655111f3bb8393e959ce3f3d107c83edce29c3a` | 2026-10-27 | MIT |
| Novel | `fa95098e66476c466faebb8211baa5869c101a9c` | 2025-01-18 | Apache-2.0 |
| Minimal Tiptap | `93b55598a206f809cd8d37a481d7391a829c6623` | 2026-03-30 | MIT |
| mui-tiptap | `f5e3e62e1bdbeb5fb82e9751317772de4e18a82c` | 2026-11-08 | MIT |

Commit recency is evidence of a particular branch's activity, not a quality score. Confidence is high for the inspected code structures, preference definitions, licence declarations and local observations; moderate for source-based integration suitability; unproven for comparative performance, full accessibility and complete device behaviour.

The recommendation would change if a candidate demonstrates a materially more complete experience while preserving REZICS's profiles, IDs, domain notation and host lifecycle at lower sustained maintenance cost. That requires a representative integration and acceptance evidence, rather than screenshots or a feature list alone.
