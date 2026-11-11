# Receive admitted Season identity and Episode covers

The current Bangumi Episode source contract exposes an Episode ID, parent Series ID, source sort, kind and text fields. It has no TVSeason key and no image field. Direct Episode membership is delivered, with source `sort` retained as `schema:episodeNumber` and valid relative order exposed as `schema:position`.

Implement an admitted producer that supplies all of the following from one source record set:

- A stable, source-owned ID for each real `schema:TVSeason` and the exact parent `schema:TVSeries` ID.
- Exact `schema:isPartOf` containment for Series → Season and Season → Episode, with source-backed order qualifiers. Preserve Episode number and kind as separate facts; do not derive Seasons from offsets, sequel titles, or gaps.
- A source-backed Episode cover asset and rights/provenance input accepted by the existing media resolver, resulting in the current native `schema:image` relationship and a public available cover.
- Exact provider citations and source fences, delivered through the existing cross-media proposal, authorized acceptance/adoption and current projection path. Keep the existing Screen reader and `CrossMediaGraph`; add no second writer.

The missing producer is the operation that joins stable Season identity, ordered Season membership and a rights-bearing Episode image into the ordinary selected-import graph. Add its smallest source fixture and native case, then independently read both membership directions and the public cover response before claiming the Series → Season → Episode return journey.
