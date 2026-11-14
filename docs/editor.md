# Editor product

The editor is one reusable product for chapters, knowledge documents, authored catalogue fields and discussions.
It uses Tiptap 3 with the versioned [Document profiles](../packages/document/README.md). The research in
[editor experience](research/editor-experience-gpt-6.md) informs the workflow and settings; the existing licensed
Reactjs Tiptap Editor control adaptation remains the implementation source where applicable. Docmost and Outline
inform complete document workflows; AFFiNE and SiYuan inform user preferences. Source reuse follows the exact-file
licence and notice requirements in [agent conduct](development/agent-conduct.md#external-source).

## Package and authority

`@rezics/document` owns persisted structure, validation, normalization, profile names, IDs and canonical bytes.
`@rezics/editor` owns the editing instance, commands, controls, selection/history lifetime, preference contract and
settings UI. Its root exports editing, `/reader` exports static reading, `/schema` exports the Tiptap schema bridge,
`/preferences` exports a browser-independent preference model, and `/styles.css` supplies shared typography.
The reader does not instantiate an editor. Editor depends on generic UI primitives and Document; UI does not import
Editor. The pure preference entry has no React, DOM, account or service imports and can be validated by Accounts.

Hosts own identity, authorization, document retrieval, uploads, mention/entity resolution, navigation, saving,
immutable revision history, comparison and publication. They inject capabilities and preserve their existing
conditional/idempotent commands. Account preference storage uses the existing account-preferences resource and
version; there is no editor-specific persistence service or alternate document body store.

Move existing shared editor and reader consumers together, including stories, tests, styles, module ownership and
public type imports. Preserve existing story identities and native acceptance. Shared controls continue using the
current UI Menu/BottomSheet, localization, target-size and focus conventions. Carry the licensed upstream source,
revision and adaptation notices with the moved files.

## Complete authoring

Writing, knowledge and compact presets select controls and defaults for their jobs over the same Text/Blocks
profiles. Writing emphasizes continuous input, navigation, search and annotations. Knowledge exposes block and
table operations. Compact input presents a smaller control set. A preset or hidden button never removes a node
required to represent an admitted document. All commands derive availability from the current schema and host
capabilities. Fixed, floating and touch toolbars, slash insertion, block actions, command search and shortcuts use
one command vocabulary and operate on the same editor, selection and undo history.

Supported authoring includes headings, lists/tasks, quotations, code, links, emphasis/underline/spoilers, language
and direction, ruby, footnotes, and admitted Blocks tables/media/components. Existing opaque components preserve
their complete payload and fallback when their implementation is unavailable. Unsupported input is reported
without publishing a flattened or partially stripped snapshot. A stored document is never round-tripped through
HTML, Markdown or plain text merely to display a control.

Lists use maintained ProseMirror split/lift/sink/join semantics for Enter, Tab, Shift+Tab and Backspace, including
empty-item exit and nested lists. Task controls change checked state through an ordinary undoable transaction.
Table controls create a chosen size, insert/delete rows and columns, toggle headers, select cells/rows/columns,
merge/split, align and resize. Cell navigation, multi-cell paste and undo use maintained table mechanics. Persist
spans, widths and IDs; enforce Document's expanded-table bound before expansion. Read-only surfaces cannot mutate.
Physical rows fully covered by earlier rowspans may contain no own cells, matching maintained table mechanics.
The complete table still requires a positive rectangular grid with an actual cell and no uncovered or overlapping
positions. This is an additive profile acceptance change; ordinary snapshots retain their meaning.

At a collapsed caret or selected unit, block actions support turn-into, move, duplicate and delete by pointer and
keyboard. Moving preserves the full subtree's IDs; copying/duplicating assigns new IDs throughout. Deleting the
last editable block leaves a valid empty paragraph. ID repair and movement remain in the editor's transaction
pipeline rather than a later destructive normalization.

Ruby controls preserve base text and marks while editing its reading/position. Language/direction controls retain
BCP 47 spelling and support clearing an explicit override. Footnote controls use the already delivered
[reference/definition contract](../packages/document/FOOTNOTES.md), support insertion and editing, and never create
unresolved references or nested notes. Panels bind their target to the current editing visit; stale actions cannot
change another selection, document or account.

Find/replace supports next/previous matches, case and whole-word options, current/all replacement, keyboard entry
and clear no-match feedback. Replacement is undoable and preserves marks and non-text nodes. A command palette
provides searchable available actions and keyboard access. An outline/statistics surface reuses the existing
writing inspection where the host supplies it; a standalone editor can expose its own local bounded projection.

### Bounded bulk text execution

Bulk replacement retains the maintained native steps, maps and history semantics. It must not retain a complete
intermediate document per match, coarsen unchanged positions into a paragraph replacement, or impose a logical
match-count cap. The measured ordinary transaction construction exceeds 6 GiB for 100,000 admitted single-character
matches; merely limiting decorations or hiding Replace all does not repair this class.

Adopt a private, version-pinned compact transaction adapter for proven monotone, closed inline-text replacements.
It records native steps/maps, materializes prefix documents lazily with bounded internal retention, caches exact
inversions for their owned step/prefix, and joins final text once per resulting mark run. Native step prototypes,
serialization, mapping, merging and foreign-prefix inversion remain correct. This is an owned execution path,
not a replacement for arbitrary ProseMirror transactions or a new document format. Unknown, structural or mixed
operations retain the maintained verified path; their identity-repair processing cannot be suppressed.

The existing history commands and visit-bound browser history-input handlers use the same bounded construction
for undo/redo. No global EditorState prototype mutation, custom StepMap, collapsed mirror identity or rewritten
history branch is adopted. Prefix observations must preserve immutable Node/Fragment values and document/selection
identity rules. Resolve virtual prefixes without retaining a native resolution cache for every prefix, and expose
a real final document to the live editor. Explicit selection restoration preserves direction, bookmark and stored
marks; it is part of the owned command rather than an invisible flag equivalence claim.

Owned history evaluation may index native map sequences to skip only provably untouched contiguous segments.
Native StepMaps, mirror identities and leaf recovery/deletion results remain unchanged. The index is an exact
private Mappable evaluator, not a new map representation. It must honor inverted input ranges, slice boundaries,
append/copy-on-write views and the actual mirror-array identity; unknown or unindexable cases use native evaluation.
The reached remap CPU failure and differential requirements are recorded in
[native mapping research](research/editor-native-mapping-gpt-6.md).

Only a factory-proven topology/ID-preserving whole append batch may bypass redundant UniqueID step replay. Mixed
or unknown batches follow normal identity repair. Content/profile validation and outgoing snapshot limits always
remain active. Check encoded output expansion before allocation/dispatch, and validate the complete result. Clear
transient find decorations before mapping a bulk edit, then rebuild them against the admitted result.

The implementation must establish native differential equivalence for step JSON, prefix contents, inversions,
maps/deletion flags, selection, bookmarks, mixed fallback and partial non-history edits. Real dispatch, history
application, undo and redo must meet measured memory/interaction bounds on dense, spaced and near-ceiling content.
Forward construction alone does not satisfy this contract. The comparison and proof obligations are recorded in
[bulk text research](research/editor-bulk-text-gpt-6.md).

## User preferences

The portable preference model contains sparse overrides over documented preset defaults. It validates closed
fields and bounded numeric/string/array values. Presentation choices include sans/serif/mono/custom font, text size,
line spacing, writing width, fixed/floating/automatic/hidden toolbar and outline visibility. Input choices include
Markdown shortcuts, spellchecking, sanitized-rich versus plain-text paste and URL conversion. Command choices
include pinned/hidden controls and their order, plus custom bindings for supported commands. The settings UI offers
search, explanations, immediate preview, visible save/error state and restore defaults.

Account defaults synchronize through the existing account preference API. The caller may apply device/session
overrides; it must distinguish them visibly from synchronized preferences. Signed-out use stays device-local.
Account or editing-visit replacement retires pending preference work and clears private account state before the
replacement commits. Account patch/reset, shared-version conflict, no-op and retry use the existing preference
command and receipt semantics. Reset removes the editor overrides, not other preference domains.

Private typography and control layout do not alter authored document bytes. Authored heading, alignment and
emphasis remain document content. Hiding an insertion action retains the corresponding parsing/rendering schema.
Changing a preference preserves the editing instance, selection, undo history and unsaved work, including a pending
validated snapshot. Input rules and keymaps read current settings without recreating the document. Shortcut UI
identifies conflicts and reserved/platform input chords and restores defaults. Composition events must reach the
native input method without command interception.

## Integration and recovery

The editor publishes only validated snapshots and distinguishes pending work from raw local recovery data. A host
cannot submit a stale acknowledged snapshot while a newer edit is pending. Save state distinguishes dirty, saving,
saved, failed, conflicted and uncertain results where its existing producer supports them. An uncertain save retries
the same command. Revision restore produces an explicit new draft through the host; editing and preview do not
publish. Existing hosted-book and account-draft publication reviews remain independent.

Uploads retain current visit/selection ownership, status, retry, replacement, alternative text and meaningful
failure feedback. Multiple mounted editors have independent menus, targets, uploads, locale, editable state and
history. On retirement, late callbacks cannot mutate or focus the replacement. Controls remain keyboard reachable,
restore focus to the owning editor, and respect touch safe areas, the virtual keyboard and RTL placement.

## Acceptance

Completion requires the product outcomes below on the integrated candidate, with exact check results and rendered
evidence. Implementation, source integration, build and functional acceptance remain distinct. Existing public
scope still governs collaboration, computation and publication; a complete editor does not require a new team
collaboration service or a paginated office suite.

1. The independent package is consumed by all existing editor/reader surfaces without a UI/editor dependency cycle;
   editing imports do not enter the static reader path. Existing document/footnote round trips retain their meaning.
2. An author enters a representative chapter, uses formatting, find/replace, command search and outline, changes
   typography, and undoes/redoes without losing selection or content. Chinese/Japanese native composition, deletion
   and Enter work while shortcuts are enabled and disabled; synthetic composed text alone is not this proof.
3. Native list/task and table journeys cover the operations above, including rectangular selection, merged cells,
   paste, resizing and undo. Existing unit IDs survive edits/moves; new/duplicated units receive new IDs. Text and
   read-only profiles expose only valid operations.
4. Ruby, language/direction, spoilers and footnotes can be created, edited, removed and read again. Non-target text,
   formatting, references and extension payloads survive. Stale panel submissions have no effect.
5. Pointer and keyboard block movement/duplication/deletion work for nested content and the final block. Empty,
   populated, selection, no-match, unavailable and invalid-operation states are accessible and understandable.
6. Preferences apply during an unsaved edit without resetting history. Account save/readback, conflict, no-op,
   reset, retry and account replacement hold through the real preference API. Device/session overrides and their
   reset are distinct; hidden controls do not strip stored content.
7. Existing Studio, knowledge, catalogue and discussion hosts use the shared editor. Representative real-host
   journeys prove snapshot pending/error, save/conflict/recovery, revision comparison/restore and explicit
   publication using the current native producers. A component fixture does not prove those backend outcomes.
8. Desktop and phone, both themes and supported locales cover toolbars, settings, tables, annotations, uploads,
   keyboard navigation and focus restoration. Page identities, console failures, overlays and screenshot evidence
   are inspected. Assistive-technology and real virtual-keyboard limits are reported honestly.
9. Representative chapter sizes and structures have measured typing, selection, paste, search and snapshot costs.
   Work is bounded by the admitted document and table limits; chapter loading never fetches a whole book. A byte
   ceiling or one fast empty document does not establish performance acceptance.

Acceptance lives alongside the editor's focused browser/unit suites, existing document suites, Accounts preference
native suite and the existing Web author/reader journeys. New stories cover complete Writing, Knowledge, Compact,
Settings, Structural editing and Domain annotations journeys, plus their error/read-only/phone states. The package
and account workers name their exact focused commands; integration selects the affected Web and native scenarios.
