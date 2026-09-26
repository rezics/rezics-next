# Export owner

`POST /v1/exports` verifies the Account `export:create` scope, registers and
claims an Access `export.create` admission, reads an exact owner position, and
seals a Content export manifest and receipt in one transaction. The receipt's
Content epoch and sequence settle the Access admission. `GET /v1/exports/:export`
requires `export:read` and rechecks the source and disclosure before serving the
sealed plan. Repeating a key returns the same manifest only while the source
basis still matches; an ambiguous owner failure returns a pending operation so
the retained receipt can reconcile the original admission.

Content migration 180 adds the owner position, canonical plan payload and
`export.create` receipt action to the tables introduced in migration 121. The
writer persists member, residual and rights-basis rows alongside the payload.
It never treats an Access position as a Content position. Stale, refused and
rights-blocked claims receive a rejected Content receipt, then an Access
terminal outcome.

`readers.ts` supports fixed Main releases, semantic revisions, sealed Structure
manifests and verification assessments.
The fixed-release reader verifies the graph and object source through the Work
owner, exports Main metadata, and records explicit residuals for the omitted
body and missing external releases. The semantic reader preserves the exact
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
current use and restriction. No linked external-release reader is exposed by
the fixed-release selection yet, so LIVE10 still needs an exact Main/source
release link and an export-operation path for it. The selected source matrix and
source-to-native value mapping still need live conformance before LIVE07 can be
declared complete. The current Structure writer's Book type IRI failure
prevents a full command-to-export COMP08 fixture; the export reader is tested
against retained graph and immutable-object seal bytes.

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
