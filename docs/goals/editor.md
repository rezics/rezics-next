# Complete editor product

## Outcome

People write chapters, knowledge documents, authored fields and discussions through one complete, configurable
editor product. They can edit supported document structures, choose their writing environment and retain their
work through saving, recovery and revision operations. The [editor product contract](../editor.md) owns behaviour;
[public scope](../scope.md) retains publication and collaboration boundaries.

## Done when

- `@rezics/editor` owns editing, static reading, the schema bridge and portable preferences; all existing consumers
  use its public entries with one-way dependencies. The independent Document contract retains its semantics.
- The complete authoring and user-preference outcomes in the product contract are implemented and exposed across
  Writing, Knowledge and Compact presentations, including structural editing and domain annotations.
- Existing account preference storage provides synchronized editor overrides with native conflict, no-op, reset,
  retry and account-replacement behaviour. Device/session overrides remain explicit.
- The product contract's nine acceptance clauses pass on the integrated candidate: native preference and existing
  author/reader lifecycle evidence, focused editor interaction suites, desktop/phone rendered review, input-method
  evidence and representative chapter performance. Missing or indirect evidence remains unfinished.
- Scoped source is integrated with the existing development/release process, and the exact promoted revision has
  the required acceptance evidence. A package move, source commit or component screenshot alone does not close it.

## Scope and ownership

Editor owns `packages/editor`, the extraction from UI, affected consumer bindings and editor-specific settings.
Web retains routes, application sessions, navigation, authoring lifecycle and publication. Accounts retains the
existing preference API, version, command and account authorization. Document retains the content format. The
editor work coordinates necessary changes in these owners and reuses their installed interfaces.

Existing rich media, footnotes, ruby, language/direction, opaque components, IDs, disclosures and validated snapshot
recovery must survive extraction. Team collaboration and computation remain on their existing later-version road;
the editor does not introduce another backend or require office pagination.

## Dependencies and acceptance

Use the current Tiptap/ProseMirror engine, existing licensed control adaptation, UI primitives, Document profiles,
Accounts preference operation and Web Studio/discussion/knowledge/catalogue interfaces. Exact checks are selected
from the affected workspace scripts and existing native author/reader scenarios after implementation. Tests prove
their actual covered outcomes; fixture UI never substitutes for native authority. The product contract owns the
required scenario set, avoiding a second definition in this brief.
