# Collection discovery adapter

Decision: the clean base has neither Commerce's native Collection discovery producer nor Collection support in the shared mixed registry, so Search exposes a validating adapter seam and keeps it unavailable or preparing until those owners supply complete source coverage and registry integration.

## Identity and indexed fields

Keep the existing Collection UUID as the `collection` primary identity. Do not reinterpret a Collection as a Subject or merge identities by title, curator or destination. The native source returns only eligible public Collections, with the full UUID, native Collection revision, owner-approved title and public description. Private and unlisted rows are rejected at the adapter boundary; they cannot contribute text, exclusion, page order or population counts.

The source seam is `PublicCollectionDiscoverySource` in `collection-discovery.ts`, the minimal named interface for Commerce's planned `publicCollectionDiscoverySource(pool)`:

- `read(partition, ids)` accepts at most 100 canonical full UUID keys and returns the complete requested eligible subset with the actual partition position.
- `count(partition)` returns the position and public eligible population size for a generation census. It is not a query-count proof.
- `page(partition, after, limit)` uses the full `(route, id)` key, accepts limits from 1 through 100, and returns rows in strict native key order. Each row revision must be at or before the page's actual native partition position. A non-null frontier is the final emitted key, and may leave the adapter only after the producer marks the whole page complete.

Rows contain only `id`, `visibility: 'public'`, `revision`, `title` and `description`. The adapter projects exactly those fields and never carries through extra producer columns. It does not read Collection rules, pins, private facts, occurrence notes, member Subjects, or curator/member subjects.

## Current summaries and lifecycle

The producer's `readPublicCollectionDiscoverySummaries` is represented by the adapter's `readSummaries(ids, context)` callback. It runs on each hydration with the current Search read context; summaries are not cached. It may omit an identity when the Collection is no longer currently readable. Returned summaries are allowlisted to the current public title, description and the producer's canonical native destination. Unknown keys, mismatched identities and malformed fields fail closed.

Commerce's source remains authoritative for owner reduction, publication currentness and lifecycle. At its observed native position, withdrawal, deletion or loss of eligibility must remove a Collection from reads and complete pages; restoration must appear at a newer native revision. An incomplete source page is `preparing`, never a false empty page. Search's mixed generation/currentness owner must suppress stale indexed positives immediately during lag and keep missing native coverage in readiness until a complete population is available. A follow or Zone mount is not disclosure authority.

No producer is installed on base `b52273a1675ba90c9e6cd24aa3d911d7732ad08a`. The shared `discovery.ts`/registry/hydration union also has no Collection registration. The adapter therefore returns typed `unavailable` when the producer is absent, preserves producer `preparing`/`unavailable`, and validates pages when a producer is supplied. The shared union and common projection/generation outcomes remain with their owner; completing the one call-site integration requires that owner to consume this seam.

The focused tests cover the adapter seam and validation only. They do not establish Commerce's native population, current authorization, lifecycle behavior, or production generation readiness.
