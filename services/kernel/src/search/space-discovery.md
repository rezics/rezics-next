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

## Native dependency readiness handoff

`SpaceDiscoveryAdapter.source.dependencies()` forwards the Content source's exact `SpaceDiscoveryDependencyReadiness` observation. Search does not synthesize a ready state from a zero census, an empty page, or settled inverse installation. The current Content export reports `preparing` or `unavailable`; its source-fence capability remains unavailable until the native Space tuple producer is delivered. The generation owner must use this observation before claiming complete Space coverage, and the query owner must keep current anonymous hydration authoritative. The existing generation and query owners retain publication and result ownership; this method is the single capability seam for their caller binding.

Decision: keep Content dependency readiness unchanged at the Search source boundary; absent a complete native source-fence capability, no Search observation certifies complete Space coverage.

## Cost touch and growth check

Search validates full raw pages and admits at most 100 candidate keys per page/read/hydration call. Page progress follows examined keys, including sparse ineligible windows. A complete admitted step must satisfy `C_dependency(D) + C_seek(B) + ceil(B / H) * C_summary(H, D) + C_final(D)` for `B <= 100`; `H <= 100` at the Search adapter boundary. `D` and the native statement/row terms are not admitted or measured while Content has no complete source-fence capability and exact final dependency reobservation contract. Census and current summary reads do not fill that gap.

The required installed-path 1x/4x/16x growth run, including sparse rejection and currentness invalidation, remains unmeasured until Content supplies that native capability. Record statements, examined/returned rows, seeks, actions, retained candidates, and total resumable preparation/catch-up separately when it can run. The worker's focused adapter test covers only the constructed preparing/unavailable contract case; it is not native growth evidence.
