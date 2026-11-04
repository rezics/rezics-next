# Album contents reader

The ordinary MusicAlbum overview offers bounded public album contents beside its current facts. The
[platform coverage audit](../../../../../../docs/research/api-first-platform-coverage.md#musicbrainz) distinguishes
album, release, medium, track and recording identities; this reader preserves that distinction whenever the
released vocabulary supplies it. The [Subject page contract](../../../../../../docs/subject-pages.md#imported-music-and-live-action-profiles)
owns composition. Native [relations](../../../../../../services/kernel/src/semantic/README.md#relations) own
membership, order, slot qualifiers, summaries, disclosure, freshness and continuation.

Use the existing work-parts owner's canonical `bf:hasPart` forward and `schema:isPartOf`, `wdt:P179`,
`wdt:P1433`, `wdt:P361` inverse streams only when the effective Release admits them. Story arcs keep their
separate owner. Each stream stays separate, in native order; a row is keyed by holder and statement, never by
recording or label. All qualifiers and reference parts retain their native value state and precision with
released labels or the raw property ID. Unknown source vocabulary remains visible in provenance and the
existing correction reader. No local date, disc position, target type, release association or recording is inferred.

Missing configuration is unavailable, distinct from an admitted empty page. A missing summary stays withheld:
there is no guessed title or destination. A failed continuation retains the previous admitted window and retries
only that exact opaque address; withheld/invalid results retire its rows. Repeated cursors and over-bound pages
are unavailable. There is no refill, accumulated page bodies or targets, per-row hydration, prefetch or automatic
retry. The only retained history is the eight most recent prior exact native addresses; Previous performs that exact
read and the oldest address leaves first. Start and stream selection request a new first window. Currentness copy
reflects native eventual freshness.

Decision: exact subject destinations and existing membership correction open in a new tab, keeping the album
window mounted; returning restores the keyboard origin when it is still meaningful, otherwise the region heading.

Decision: One selected membership opens a single in-page inspection, and every accepted page replacement clears it.

The destination uses the ordinary Subject reader until a specialized Recording reader is installed. Membership
correction goes to the existing holder's relation editor with its normal recovery and context restrictions;
Album correction, classification and Library owners retain their interfaces. This public reader creates no
commands and does not publish native configuration or import bindings. In particular, the bundled MusicAlbum
profile does not supply a complete release/track vocabulary. Admitted generic contents are not proof of a
published track-specific presentation.

The whole window retires on subject, context, realm, locale, source observation, Query provider, session or
exposure replacement, even after an away/back change. Delayed responses check that original observation before
changing rows or focus. A fresh source is needed after retirement. No old public reading, cursor or target control
is rebound to replacement viewer authority. The stable heading receives focus if a removed row held it.

## Cost

One initial window costs one exact album read, one active-definition read, one immutable Release read and at most
one relations/links page. Each deliberate next/retry/stream/restart repeats that same bounded plan. Definition
reads retain their existing 4 MiB, 1,024-Type and 4,096-property limits; at most 64 streams are retained. The
ordinary scalar profile has its own existing three-read plan. This reader starts no session/exposure or target
reads and performs no writes. Only one request can be initiated at a time per window; no polling or prefetch runs.

A native window admits at most twenty rows, each at most 128 KiB serialized UTF-8 JSON, within a total
2,686,976-byte JSON page cap. An over-bound result is unavailable rather than partially presented. An opaque
cursor is at most 4,096 UTF-16 units. One current page, one pending address and one keyboard origin are retained;
old windows are replaced. Normalization retains each accepted assertion, qualifier, reference, bounded summary
and related labels without target hydration. Labels/types are projected only for that window. Retained normalized
JSON is O(page bytes); duplicate serialized strings, parsed objects and JS overhead are additional real memory.
Admission temporarily serializes the page and one row at a time; unaccepted transport input is outside these
accepted-window bounds. Projection/rendering are O(N + admitted bytes), N ≤ 20, independent of total album size.

Stories are source examples, not native publication or rendered passes. Focused tests exercise generated native
operation seams, identity/order/qualifier retention, unavailable continuation, exact retries and retirement. Phone
390/desktop1280, both themes and all eight locales use wrapping shell/domain components and 44px controls;
browser and native verification remain with integration.
