# Imports and catalogue editing: design status

31 October 2026. Imports owns the catalogue editing and provider-review journeys end to end, including their
pages in `apps/web`. Web owns the shell, shared UI/patterns, Storybook organisation and visual review. Semantic,
Content, Search and Accounts retain their native contracts. [Subject pages](../subject-pages.md) owns the browser
behaviour; [conversion](../../packages/conversion/README.md), [importer](../../services/importer/README.md),
[Semantic](../../services/kernel/src/semantic/README.md), [Content](../../services/kernel/src/content/README.md)
and [statistics](../../services/kernel/src/rating/README.md) own their mechanisms.

## Connected journeys

| Journey                            | Current integration and remaining work                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider dump → proposals → reader | Four pure converters and the terminal importer retain provider identity, field-level evidence, bounded acquisition, fences, recovery and ordinary automated-account authority. Native batch proposal/retraction, media import and provider statistics feed the existing catalogue; unchanged input writes nothing.                                                                                              |
| Reader → create or correct         | Canonical subject routes connect generic initial-term creation, scalar cited correction, exact-slot relations/credits, current candidate review and selected public reading. Terms PATCH uses the generated native client, validates `{subject, revision}` and its strong ETag, and passes the returned Session to the current reread. The native Terms route host test covers that write, Session reread, noEffect, stale recovery and exact retry. Web visual review remains pending. |
| Reader → Edit facts                | The released Type drives a coherent multi-field workspace. It reuses scalar controls, stages an explicit bounded changed set and reports each existing candidate POST separately. Exact returned candidates lead to review; selection remains explicit. Web review and integrated native outcome verification remain pending.                                                                                   |
| Work → edition/release             | Creation retains the chosen work and independently identified publication grain, using emitted profiles and the existing native creation contract. Web review remains pending.                                                                                                                                                                                                                                  |
| Provider review queue → decisions  | Current prepared suggestions use bounded explicit per-candidate decisions. Acceptance does not imply adoption or publication. Web review and producer binding must be distinguished from a story sample.                                                                                                                                                                                                        |
| Sources and recorded changes       | Four reviewed importer registrations now journal ordinary public metadata POSTs after validated sealed acquisition, including old unchanged bindings. Sources consumes the actual current selected `sourceRecords` DTO and retains per-field references and separate cover/prose rights. The existing-fixture native outcome is added but unrun; Web visual review remains pending.                             |

The multi-field consumer uses the actual generated subject, definitions and candidate client through the existing
private session BFF. Its proposal bodies, keys and returned session tokens remain native. A story seam demonstrates
partial results and exact retries, without establishing runtime availability or a reviewed page. No second field,
permission, import administration or publication engine is introduced. Types with rich-document fields link to the
integrated Content-authored composer for new original-text candidates, retaining its independent native review.
Its Web/Root visual review and integrated native outcomes remain pending.

## Research retained

[Catalogue editorial research](catalogue-editorial-journey-design.md) supplies the generic immutable-assertion,
reference, multiplicity and work/edition patterns. [Pinned provider inventories](../../packages/definitions/sources/README.md),
[catalogue mappings](catalogue-filter-data-mappings.md) and [backpressure](importer-bulk-backpressure.md) retain
provider-specific design evidence. Bangumi summaries retain their adopted attribution/ShareAlike boundary;
VNDB database/content terms remain distinct from prose/images; Open Library asserts no blanket prose/cover licence;
Wikidata structured-data terms do not license linked text/images. Recipe-site instructions are not imported.

## Original deferrals and open bindings

- The approved four-provider metadata binding is implemented against the delivered native SourceRecords operation;
  native integration proof and Web review remain pending. General metadata queues/ACK programmes, other producers
  and complete reader attribution beyond this selected-support slice remain deferred. See the
  [changed importer contract](../../services/importer/README.md#reviewed-provider-metadata).
- The strict statistics clear is owner-delivered; the approved alias producer and zero-refresh/alias consumer
  are integrated in code, with native integration proof pending. Explicit zero clears; UNKNOWN partial values never clear. Preserve
  exact claim/fence identity, one subject/provider slot and independent native votes.
- Custom definition publication, advanced identity operations, reviewed vocabulary/seeds/classification/forms
  and measured-input expansion stay under their existing gates. No new scope is opened by a generic editor.
- The [broader discovery matrix](../goals/imports.capabilities.md) remains open/deferred where previously declared.
  Search owns discovery and public page composition; this work creates no Imports search or page pipeline.
- The safe revision-detail read is bound through the generated client in Changes and Why this value. Current
  reading metadata and recorded adoption selection remain distinct. The delivered terms tag preserves each field
  with its own languages. Terms PATCH and own-contribution deletion/restore use their generated native methods;
  source integration and type validity establish neither native outcome proof nor visual review.
- Delivered code, declared adapters, native binding and visual review are distinct states. Web owns the normal
  phone390/desktop1280 and both-theme review of the existing story IDs; Root samples direction. No capture restart
  is required by this read binding.
