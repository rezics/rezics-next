# Resource presentation and Blocks

## Content and view separation

A Resource has eligible content/representations; Zone routes and mounts select a
view and typed context. The same content can appear in several Spaces without
copying its body. Blocks are declarative documents with stable major-node identity,
registered types and versioned payload schemas. Document AST and semantic graph
reference each other through exact resource/revision/selector contracts.

## Resource summaries

Every resource exposed as an object summary has a stable reference, resolved
display name and non-null `avatar` descriptor. This applies to works,
characters, concepts, Contexts, roles, relation definitions and other admitted resource
types. It is a shared read contract, not a mandatory universal database record.

`ResourceSummary.avatar` is a discriminated image-or-fallback value. An image
identifies the selected currently disclosable Media Use and bounded rendition;
a fallback identifies a stable admitted default keyed by readable resource/type
and display policy. A resource without uploaded media still has a renderable
avatar. A hidden image must produce a safe fallback without revealing the hidden
asset's identity or the reason it was suppressed. The Media owner supplies
[selection and lifecycle rules](media.md#universal-avatar-selection).

The resource itself must first pass the normal readable/available-state checks.
Avatar fallback cannot fabricate a resource summary or reveal a private object's
existence when that read is denied or unavailable.

Summary reads take explicit context/language/disclosure policy and return actual
selection provenance where readable. Batch hydration shares the caller's budget;
lists and graph views do not make one owner request per avatar. Cached summaries
bind name/media selection and disclosure generations, and stale media URLs cannot
outlive the owning delivery policy.

Display groups such as Appearance are fields in existing view/Block descriptors,
with admitted relation/property membership and order. They allocate no compulsory
Facet, Path, Expression or Sense object. Referencing an Appearance concept for a
group's label does not make the concept identical to the group. Renaming or moving
a group changes presentation only. Results come from the shared
[statement aggregation contract](search.md#statement-aggregation), including its
count grain, supporting identities and completeness.

## Interpretation and preference selection

The API distinguishes the resource's shared identity, an authored statement's
exact interpretation, the Realm's own selected interpretation, and a viewer's
preferences. A resource or concept can be read under different Contexts without
changing the original claims. Expose meaningful differences through readable
criterion/Context labels and an inspectable definition/evidence basis; display
names such as `後宮` alone cannot identify the selected meaning.

Show whether speech is personal or on behalf of a Realm, and retain the selected
semantic revision when quoting or sharing. A Realm default is a selectable
starting point, not proof that every member uses it. Do not silently substitute
the viewer's current Context for the author's. A separately named concept and a
contextual interpretation of the original may coexist in the same view.

Language, detail level, property emphasis, name/avatar and ordering preferences
have independent effects. Editing them cannot change a semantic filter, the
author's meaning or content publication. Response descriptors and shared links
carry exact semantic selection where meaning depends on it; private selection
or Context metadata is disclosed only to the admitted audience. Missing required
meaning stays unavailable instead of being replaced by Global.

## Rendering

Validate new writes strictly. Isolate malformed historical presentation nodes in
bounded render-safe fallbacks without rewriting authoritative content or allowing
executable HTML/URLs. Render only selected, currently readable dependencies.
Progressive disclosure exposes ordinary tasks directly and retains advanced
configuration, provenance, context and material consequences.

## Query Blocks and themes

Search/Feed/Graph/Collection Blocks compile typed descriptors through the same
server query contract. Share request budgets and cache by descriptor/context/
selection/disclosure generations. Saved UI layout does not create facts or grants.
Unknown Block types yield an explicit unsupported placeholder/export residual.

Themes use controlled tokens/presets by default. External-live executable themes
have the separately admitted [execution contract](custom-theme-execution.md).
Presentation changes cannot confer query capabilities, read private data or hide
consent/security consequences. Accessible navigation and keyboard behavior are
part of the experience contract.

## Implementation and acceptance

Use shared React renderers and typed locale resources for product UI; content
languages remain independent. SDK/API editors preserve unknown-to-editor advanced
fields. Qualify exact selection, malformed nodes, private embeds, query budget
composition, responsive/accessibility behavior and exported representation fidelity.
The universal summary/avatar and grouped-statement response shapes are adopted
contracts pending owner implementation. Their API acceptance belongs to the
backend Goal; frontend implementation and rendered acceptance remain outside its
current scope.
