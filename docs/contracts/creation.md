# Native creation and reading

Creators draft and publish chapter Posts placed in a Book by occurrences. A
chapter adds no Work identity: the Book carries the creative scope, while its
Post carries publication and custody. The same Post can occur more than once
without copying its text or discussion. An independently authored, stand-alone
unit may also be identified as a Work under
[the identity decision](work-and-release.md#posts-texts-and-works).
Image-only and poll-only publications need no fabricated text document.
The [BOOK cases](../../scripts/qa/cases/book-and-creation.ts) and
[publication owner](../../services/main/src/modules/content-publication/) carry
the implemented command and exact-history behavior.

Unsaved local edits, shared editing state and published history are different.
Future collaborative editing needs an explicit session or qualified merge
protocol that preserves block identity, validates the resulting document and
keeps both inputs on conflict. [Client synchronization](client-synchronization.md)
owns offline command replay; presence alone promises no conflict-free merge.

Reading progress belongs to stable occurrences. Exact comments and citations
must retain revision and selector. Reuse in another Realm requires its own
acceptance and does not transfer contributor control. Large exports need
cancellable jobs, repeated disclosure checks and an explicit account of missing
coverage or losses.

[Post media](media.md#post-attachments-and-preview-selection) retains the pending
cover, banner and preview design. Its visual interaction belongs with the
frontend implementation and stories.

## Creator experience

Decision 21, product manager under maintainer delegation, 2026-09-29.
Prioritize manuscript safety, Main-owned scheduling with time zones, rights and
translation declarations, collaborators scoped to read/suggest/edit/publish,
a feedback inbox and a complete author backup. Publication rights are distinct
from edit access, and a scheduled release survives the browser closing.

The reason is dependable custody across the author's whole workflow.
[YouTube channel permissions](https://support.google.com/youtube/answer/9481328?hl=en)
provide a delegation precedent; [W3C time-zone guidance](https://www.w3.org/TR/timezone/)
explains why a local scheduled time alone is insufficient. Installed publication
commands above and the [job owner](events-and-jobs.md) carry the execution contract.

## Private worldbuilding

Decision 28, product manager under maintainer delegation, 2026-09-29.
Give authors a private World beside the manuscript: characters, places,
organizations, events, items and lore in versioned templates, not code. Selected
pages publish into the Work's Realm wiki without private history. A coherent,
re-importable export and the core world bible are never subscription gates.

Use [Leaflet custom-image maps](https://leafletjs.com/examples/crs-simple/crs-simple.html),
[Cytoscape.js relationships](https://js.cytoscape.org/) and
[D3 numeric scales](https://d3js.org/d3-scale/linear) for fictional chronologies
with uncertain dates; each visual has an accessible list. These libraries supply
mechanics, not the privacy or historical model. The reason is one maintained
source for the writer and selected reader knowledge, with portable custody.
An optional continuity assistant flags contradictions in the author's own notes
and manuscript; it never writes the chapter. Azgaar import and scene tracks wait.
