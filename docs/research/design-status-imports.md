# Four-provider imports: design status

30 October 2026. **Primary research exists; the operator-to-reader design is substantially connected, with
browser editorial entry and attribution delivery gaps.** This covers one [In row](../scope.md): Bangumi, VNDB,
Open Library and Wikidata. Evidence only; promotion is paused.

Authority: [conversion](../../packages/conversion/README.md), [importer](../../services/importer/README.md),
[Semantic](../../services/kernel/src/semantic/README.md), [Content](../../services/kernel/src/content/README.md),
[statistics](../../services/kernel/src/rating/README.md), [attribution][attribution] and
[pages](../subject-pages.md). The [manifest][manifest] distinguishes designed, exposed and recorded outcomes.

## Primary research

Existing research includes [pinned inventories](../../packages/definitions/sources/README.md),
[catalogue mappings](catalogue-filter-data-mappings.md) and [backpressure][backpressure]. Reuse bounded audits:
[Bangumi](imports-audit/bangumi.md), [VNDB](imports-audit/vndb.md),
[Open Library](imports-audit/open-library-native-fields.md), [Wikidata](imports-audit/wikidata.md).

Primary sources consulted **2026-10-30**:

| Source | Distribution / rights boundary |
| --- | --- |
| [Bangumi Archive README][bangumi-archive], [copyright][bangumi-rights] | Periodic wiki exports. Adopted summaries: [CC-BY-SA-3.0][cc], attribution/ShareAlike; covers: separate rights-holder credit/unknown licence. Exclude ratings/user posts. |
| [VNDB dumps][vndb-dumps], [official licence source][vndb-rights], [inventory](../../packages/definitions/sources/vndb.yaml) | Pinned COPY/schema; ODbL-1.0 database, DbCL-1.0 contents, VNDB attribution; prose/images separate. Live dump-page access failed; retained dump README evidence and official source change support these claims. |
| [Open Library dumps][ol-dumps], [licensing][ol-rights] | Monthly five-column TSV; no newly asserted rights, existing rights possible. No blanket prose/cover licence. |
| [Wikidata dumps][wd-dumps], [licensing][wd-rights] | Weekly mixed Item/Property JSON array; structured data CC0, linked images/text separately licensed. |

[OpenRefine][reconcile] separates matching from human approval; [Elastic bulk operations][elastic]
(Apache-2.0) and [RFC 9110 §9.2.2][http] separate replay safety from delivery success. Shared pattern/recommendation:
retain identity/provenance, stage bounded work, replay exact requests, then review candidates. No source copying,
clone or execution was needed. Never import copyrighted recipe-site method text.

## Connected journey

| Boundary | Existing interface / storage |
| --- | --- |
| Operator → conversion | Terminal `bun services/importer/src/cli.ts --source … --dump … --state …`: acquisition, counters/exit status, recovery; four pure `convert*` exports. CLI is the operator UI. |
| Private state → Auth | SQLite baseline/digest/native and converter revisions, source ownership, returned IDs, request/ACK journals; automated-account `POST /signin/key` → `POST /token`, ordinary Access grants. |
| Public writes → storage | `POST /v1/subjects:batchWrite`: exact tuple claim/bootstrap, proposals/retractions into Semantic PostgreSQL claims/candidates/receipts; `GET /v1/sourceFences:check`. `POST /v1/media:importFromUrl` → `GET /v1/media/{id}:importStatus`: Content jobs/object storage/available variants. VNDB: `PUT /v1/subjects/{id}/source-statistics/{source}`. |
| Editor → reader | `POST /v1/subjects/{id}/candidates/{candidate}:accept` → `POST /v1/subjects/{id}:adopt`; `GET /v1/subjects/{id}`, `POST /v1/pages:read`, `GET /v1/subjects/{id}/source-statistics`, `GET /v1/media/{id}:authorizeDownload`. Browser `/{locale}/subjects/{id}/{slug}` and `/{locale}/search`; `POST /v1/subjects:search` and `POST /v1/subjects:facets`. Search owns the [released Book integration][book]. |

[Community caller](imports-audit/community-converter-caller.md), [CLI Auth](imports-audit/cli-native-auth.md),
[reappearance](imports-audit/cli-source-reappearance.md) and [cover recovery](imports-audit/cover-native-recovery.md)
provide connected evidence. Unchanged input writes nothing after fence checks; changes append proposals;
vanished records retract owned candidates only. Mass disappearance stops before effects for operator review.
Takedown prevents recreation/disclosure. Response loss resumes original sealed requests under current authorization;
independent adoption survives. [Composed pixel recovery](imports-audit/cover-recovery-pixels.md) already closes
its older gap: no new slice.

## Minimum gaps and ownership

| Owner / consumer | Interface / smallest whole outcome |
| --- | --- |
| Web/Semantic, catalogue editor | Accept/adopt endpoints above work through API callers; current [subject routes](../../apps/web/src/routes/subjects) expose no candidate-review entry. Add review/selection to the existing subject journey and display its selected public result. This is the concrete missing UI slice. |
| Imports statistic consumer / Content producer | Default strict clear is owner-delivered. Finish the approved alias producer and SAME Imports zero-refresh/alias consumer using `POST /v1/subjects/{id}/source-statistics/{source}:clear`. Explicit zero clears; UNKNOWN partial fields never clear. Preserve exact facts/claim/fence identity, one `(subject,provider)` slot and independent native votes. Pending handoff, no additional producer/consumer. |

General `POST /v1/source-records:setMetadata` → `subject.sourceRecords` catch-up/ACK remains [deferred][attribution];
complete reader attribution is unproved. Reviewed vocabulary/seeds/classification/forms/measured-input expansion
and the [broader discovery matrix][manifest] remain deferred/open, not complete or inapplicable. Do not redispatch
them or create an Imports search/page pipeline. Documentation-only: no tests or workspace typechecks run.

[manifest]: ../goals/imports.capabilities.md
[attribution]: ../../services/kernel/src/semantic/source-record-attribution-contract.md
[backpressure]: importer-bulk-backpressure.md
[bangumi-archive]: https://github.com/bangumi/Archive/blob/master/README.md
[bangumi-rights]: https://bgm.tv/about/copyright
[cc]: https://creativecommons.org/licenses/by-sa/3.0/
[vndb-dumps]: https://vndb.org/d14
[vndb-rights]: https://g.blicky.net/vndb.git/diff/util?h=2.9&id=414daab355c8392dc21d5623cd458426d221fedf
[ol-dumps]: https://openlibrary.org/developers/dumps
[ol-rights]: https://openlibrary.org/developers/licensing
[wd-dumps]: https://www.wikidata.org/wiki/Wikidata:Database_download
[wd-rights]: https://www.wikidata.org/wiki/Wikidata:Licensing
[reconcile]: https://openrefine.org/docs/manual/reconciling
[elastic]: https://github.com/elastic/elasticsearch-js/blob/acf9711ba7f55064ac70dbe1439b931501ccc7d2/src/helpers.ts#L581
[http]: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2
[book]: imports-audit/released-book-search-demo.md
