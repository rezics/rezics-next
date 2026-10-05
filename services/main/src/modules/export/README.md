# Export owner

`POST /v1/exports` verifies the Account `export:create` scope, registers and
claims an Access `export.create` admission and seals a Content export manifest
and receipt in one transaction. After commit the Content sequencer numbers the
receipt; its exact epoch and sequence settle the Access admission. `GET /v1/exports/:export`
requires `export:read` and rechecks the source and disclosure before serving the
sealed plan. Repeating a key returns the same manifest only while the source
basis still matches; an ambiguous owner failure returns a pending operation so
the retained receipt can reconcile the original admission.

Content migration 180 adds the owner position (since migration 791 read from the
manifest's receipt by operation), canonical plan payload and
`export.create` receipt action to the tables introduced in migration 121. The
writer persists member, residual and rights-basis rows alongside the payload.
It never treats an Access position as a Content position. Stale, refused and
rights-blocked claims receive a rejected Content receipt, then an Access
terminal outcome.

`readers.ts` supports fixed Main releases, semantic revisions, sealed Structure
manifests and verification assessments.
The fixed-release reader verifies the graph and object source through the Work
owner, exports Main metadata, and rechecks each linked external release against
its frozen source run before adding a separate source member. It records
residuals for the omitted body, absent external links and unknown edition
parents. The semantic reader preserves the exact
owner value alongside a portable scalar for unknown, language, temporal,
quantity and numeric forms. The Structure reader pages a retained seal and
keeps each occurrence and its missing or undisclosed target explicit. The
assessment reader verifies graph claim and assessment revisions and reads
Content evidence metadata only for its owning Access principal. It excludes
private anchors and labels an uncalibrated score as method output. No edition
or global cross-owner snapshot is invented.
`VerifiedExportMember` must come from an owner reader, never from the request.
Owner readers attach the exact rights-material key and governance target for
each member; the Content rights owner resolves that key before evaluating the
current use and restriction. Linked fixed-release exports carry distinct native
and source owner positions without implying a global snapshot. The selected source matrix and
source-to-native value mapping still need live conformance before LIVE07 can be
declared complete. The Structure seal export remains tested against retained
graph and immutable-object seal bytes.

`LicenseScopeHook` is the G-051 rights extension point. Until an exact rights
adapter is supplied, the fallback returns `uncertain` for every member. A
prohibited basis blocks sealing and records a terminal rejection. Unknown or
conflicting bases remain explicit; neither authorizes expressive reuse.

## Cost contract

The planner admits at most 256 members, 1,024 residuals, 256 bases, 1 MiB of
canonical output, depth 16 and 16,384 traversed JSON nodes. Its work is
`O(M + R + B + L + K log K)` for members, residuals, bases, basis links and
sorted object keys. The `work` object exposes counts and serialized bytes.

The Content seal writes one receipt and one manifest, then `M + R + B + L`
child rows in one transaction. It uses a single idempotency-key lookup and a
single terminal receipt position; the read path uses the manifest primary-key
lookup and receipt-position lookup. An authorized GET performs one indexed
active-principal lookup before reading and repeats it after exact source and
disclosure revalidation; a missing or changed principal withholds the manifest.
This adds a fixed two Access checks independent of export size. A focused
integration test inserts 1,000 unrelated manifests and checks an indexed read
plan. This is a bounded SQL shape, not a full write-amplification measurement.
The fixed-release reader
performs the Work owner's exact graph/object reads. The semantic reader performs
one root Access decision and one per distinct referenced resource, plus one
exact graph/object revision read with at most 255 properties. The Structure
reader makes one owner lookup and at most three seal
page reads, each with up to 100 Access target decisions; 256 members including
the root is the limit. The assessment reader reads two exact graph records and
one indexed principal-filtered Content evidence manifest. Remote attempt and
byte counters, native Jena work, and multi-scale contention remain unqualified
under `docs/testing/complexity.md`.

## Scoped judgments

The existing export selection accepts an exact `projection-revision`, a
`rating-aggregate` for one target and RatingContext, or a `rating-rollup` with
explicit members and formula. GET replays each owner selection before returning
its sealed manifest; stale positions and changed disclosure remain failures.
Aggregate and roll-up positions come from their sealed owner evidence, never the
current graph counter. Each member retains the Context revision and last sealed
admission per contributing target. The export operation verifies `rating:read`
from the caller's assertion for both creation and retrieval, then runs the owner
read through `targetRead` with that principal and acting subject.
Projection coordinates come from the selected immutable revision, with current
part disclosure and dimension resolution. The resource uses
`prov:specializationOf`; this does not give the projection its subject's type.

Target aggregates use `dqv:QualityMeasurement`, `dqv:computedOn` and a
RatingContext question metric (`dqv:isMeasurementOf`). REZICS extension terms
retain scale, population, histogram, sum and display threshold. Withheld means
and roll-up values are absent, including withheld means inside roll-up members.
Native aggregates and derived roll-ups carry distinct origin markers. Unavailable
roll-up members stay in coverage and produce residuals. These readers do not
convert imported source statistics into native observations.
Every measurement has a deterministic IRI pinned to its owner evidence and
formula. `dqv:computedOn` contains the available pooled contributors, or the
members meeting the threshold for mean-of-means; unavailable and rejected
members remain in the explicit member list.

Personal library bundles retain own target ratings as `oa:Annotation` resources
in `raw.annotation`, motivated by `oa:assessing`. Each body retains its value,
scale, RatingContext and language-tagged question; projection targets include
the exact resource's subject and coordinates. A withdrawn rating retains its
revision and an explicit residual without inventing an annotation body. The
person's value and revision survive an unavailable Context with a
`context_unavailable` residual; a currently private projection dependency leaves
the known target IRI and a `private_dependency` residual.
The
principal-filtered target-head inventory participates in the resumable bundle
fence. Retained rows avoid importing a scoped opinion as a context-free Work
score.

The projection reader adds one exact revision query of at most eight coordinates
and a bounded target-resolution batch of the subject and frames. Aggregate and
roll-up reads reuse their owners' sealed-component budgets; export adds one
member and, for roll-ups, at most 200 member residuals. Library pages hydrate up
to twenty scoped ratings plus one lookahead. One live-head probe covers the
page; the existing rating and Context owner readers share one bounded SELECT
batch, with one further batch for v4 acceptance declarations. Context manifest
reads share a 1 MiB budget. A SELECT batch may exceed the ordinary per-probe byte
ceiling, but consumes the same enclosing 4 MiB graph budget and deadline.
Projection hydration resolves all page projections
together, reads their exact revisions in one query, then discloses distinct
subjects and coordinates in batches of at most 64. A missing dependency affects
only its own row. MainVersion ratings also share one hydration query per page.
The library fence aggregates only the exporting principal's own rating heads;
its work grows with that person's library, not the population of raters.
