# Four-provider imports: design status

30 October 2026. **Primary research exists; the operator-to-reader journey is substantially designed and exposed,
but its browser editorial entry and general attribution delivery are incomplete.** This covers exactly the
[Provider imports and bridges In row](../scope.md): Bangumi, VNDB, Open Library and Wikidata. It records evidence
and recommendations, not another contract or fresh acceptance. Promotion is paused.

Authority remains [conversion](../../packages/conversion/README.md), [importer](../../services/importer/README.md),
[Semantic](../../services/kernel/src/semantic/README.md), [Content](../../services/kernel/src/content/README.md),
[source statistics](../../services/kernel/src/rating/README.md), [source attribution][attribution] and
[subject pages](../subject-pages.md). The [capability manifest][manifest] distinguishes design, exposure and
recorded outcomes; older audit gaps do not override newer owner handoffs.

## Research and rights

Existing primary evidence includes pinned [Bangumi/VNDB inventories](../../packages/definitions/sources/README.md),
[catalogue mapping research](catalogue-filter-data-mappings.md) and [bulk backpressure research][backpressure].
Reuse the [Bangumi](imports-audit/bangumi.md), [VNDB](imports-audit/vndb.md),
[Open Library](imports-audit/open-library-native-fields.md) and [Wikidata](imports-audit/wikidata.md) audits as
implementation evidence, with their stated limits.

Primary sources consulted on **2026-10-30**:

| Source | Relevant constraint |
| --- | --- |
| [Bangumi Archive README][bangumi-archive], [copyright][bangumi-rights], [CC BY-SA 3.0][cc] | Periodic wiki exports; retain the adopted CC-BY-SA-3.0 summary attribution/ShareAlike policy. Covers retain separately credited rights-holder/`LicenseRef-unknown`; exclude ratings and user posts. |
| [VNDB dump documentation][vndb-dumps], [official dump licence source][vndb-rights], [pinned inventory](../../packages/definitions/sources/vndb.yaml) | Pinned COPY/schema admission; ODbL-1.0 database, DbCL-1.0 contents, VNDB attribution, separately conditioned prose/images. Live dump-page access failed; the retained dump README evidence and official source change support these bounded claims. |
| [Open Library dumps][ol-dumps], [licensing][ol-rights] | Monthly five-column TSV; the no-new-rights statement acknowledges existing rights. It supplies no blanket prose/cover licence. |
| [Wikidata dumps][wd-dumps], [licensing][wd-rights] | Weekly mixed Item/Property JSON array; structured data CC0, not permission for linked images/text. |

[OpenRefine reconciliation][reconcile] separates matching from human approval; [Elastic's retained bulk operations][elastic]
(Apache-2.0) and [RFC 9110 §9.2.2][http] distinguish replay safety from delivery success. Shared pattern and
recommendation: retain native identity/provenance, stage bounded work, replay exact requests and review candidates
before selection. Documentation is evidence, not copied material; no reference clone or executable was needed.

## Connected journey

| Boundary | Actual interface and status |
| --- | --- |
| Operator → conversion | Terminal `bun services/importer/src/cli.ts --source … --dump … --state …`: file/stdin acquisition, counters/exit status and same-state recovery. Four public `convert*` exports remain pure. No browser importer console is required. |
| Private state → Auth | SQLite completed baseline, sanitized SHA-256 digest, native/converter revisions, source ownership, returned IDs and immutable request/ACK journals; ordinary automated-account `POST /signin/key` → `POST /token`, current Access grants. |
| Auth → server storage | `POST /v1/subjects:batchWrite` creates/resolves the exact source tuple then proposes/retracts candidates; `GET /v1/sourceFences:check` guards each field group. Semantic owns PostgreSQL claims/candidates/receipts. `POST /v1/media:importFromUrl` → `GET /v1/media/{id}:importStatus` reaches Content object storage/available variants. VNDB uses `PUT /v1/subjects/{id}/source-statistics/{source}`. |
| Editor → public reader | `POST /v1/subjects/{id}/candidates/{candidate}:accept`, then `POST /v1/subjects/{id}:adopt`; `GET /v1/subjects/{id}`, `POST /v1/pages:read`, `GET /v1/subjects/{id}/source-statistics` and `GET /v1/media/{id}:authorizeDownload`. Browser `/{locale}/subjects/{id}/{slug}` and `/{locale}/search` consume selected data through ordinary pages/search/facets. Search owns the [released Book integration][book]; no parallel Imports pipeline. |

[Community callers](imports-audit/community-converter-caller.md), [CLI Auth](imports-audit/cli-native-auth.md),
[four-source reappearance](imports-audit/cli-source-reappearance.md) and [cover recovery](imports-audit/cover-native-recovery.md)
connect these boundaries. Unchanged input writes nothing after current-fence checks; changes append proposals;
vanished records retract only owned candidates. Mass disappearance stops before effects for operator review.
Takedown prevents recreation/disclosure. Lost responses resume original sealed requests with current authorization;
independent adoption survives. [Composed pixel recovery](imports-audit/cover-recovery-pixels.md) already closes its
older missing witness: no replacement slice is needed.

## Minimum remaining work

| Owner / consumer | Interface / smallest whole outcome |
| --- | --- |
| Web/Semantic, catalogue editor | Existing accept/adopt endpoints above are connected through API callers, but no served candidate-review entry exists in current [Web routes](../../apps/web/src/routes/subjects). Attach review/selection to the existing subject journey and show the selected public result; this is the concrete UI design/implementation slice. |
| Imports, existing statistic consumer; Content producer | Default strict clear is owner-delivered; approved alias support has one Content producer and the same Imports zero-refresh/alias consumer. Finish that pending handoff using `POST /v1/subjects/{id}/source-statistics/{source}:clear`: explicit zero clears, UNKNOWN partial fields never clear. Preserve exact facts/claim/fence identity, one `(subject,provider)` score slot and independent native votes. No new producer/consumer dispatch. |

General `POST /v1/source-records:setMetadata` → `subject.sourceRecords` catch-up/ACK delivery remains an
[explicit deferral][attribution], so complete reader attribution is unproved. Reviewed vocabulary/seeds/forms/
classification/measured-input expansion and the [broader discovery matrix][manifest] remain deferred/open,
not complete or inapplicable. Do not redispatch them from this report. No tests or workspace typechecks apply
to this documentation-only change; none were run.

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
