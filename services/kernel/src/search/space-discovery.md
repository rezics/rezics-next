# Space discovery adapter

`nativeSpaceDiscoveryAdapter` binds Search to Content's `spaceDiscoverySource` and
`readSpaceDiscoverySummaries` in `services/kernel/src/community/space-discovery.ts`. The Search leaf identifies one
Space as `{ owner: 'content', kind: 'space', route, id }`; the stable document id is
`discovery-v1:space:<space UUID>`. A hosted Realm is carried in `realm_id` and the current summary's `realmId`; it
enriches the same Space hit and never creates a second identity. Search text uses the producer's `name` and
`description`, while current summaries also carry the currently authorized Realm presentation avatar.

The source page is a complete native keyset page of Space candidates for one partition. It carries the exact
partition position, up to 100 eligible current Space projections, and a continuation key that records the last
examined native Space key. The source does not refill after filtering. `count` is only a generation census of all
retained native Space identities, including ineligible ones; it is not a public kind count or permission to infer a
zero-result query. The adapter validates the complete page, key order, partition and exact bigint position before it
returns a frontier. It re-reads page identities at the current native position before producing index/delete actions,
so a withdrawal or deletion during indexing becomes a newer delete and a restoration indexes the same Space identity
at its newer position. Invalid or missing producer coverage propagates as readiness; Search never substitutes a
sitemap sample or a point-reader census.

Content's producer admits public Spaces with anonymous `space:read` eligibility. A hosted Realm is retained only
when its current public Realm read and discovery gate are ready; a protected or removed Realm slot does not turn into
a standalone Space. The indexed revision is the current Space head or, when hosted, its public Realm head. Current
hydration re-runs the producer's native anonymous checks and omits withdrawn or unauthorized rows instead of using
indexed fields as authority. The generation owner must retain native position ordering when it consumes actions;
these summaries are display hydration, not indexed permission evidence.

The shared Search discovery registry, hydration union and generation writer own mixed-pipeline registration and
publication. This adapter exports the validated source, projection and current hydration leaf for that assembly and
does not create another route, feed lane or client merge.
