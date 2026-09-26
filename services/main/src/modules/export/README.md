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

`readers.ts` currently supports fixed Main releases and verification assessments.
The fixed-release reader verifies the graph and object source through the Work
owner, exports Main metadata, and records explicit residuals for the omitted
body and missing external releases. The assessment reader verifies graph claim
and assessment revisions and Content evidence metadata, excludes private
anchors, and labels an uncalibrated score as method output. These are partial
exchange profiles; no edition or global cross-owner snapshot is invented.
`VerifiedExportMember` must come from an owner reader, never from the request.
G-093 owns the outstanding source readers needed for LIVE07 and LIVE10; a
sealed Structure manifest reader is still needed for COMP08.

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
lookup and receipt-position lookup. A focused integration test inserts 1,000
unrelated manifests and checks an indexed read plan. This is a bounded SQL
shape, not a full write-amplification measurement. The fixed-release reader
performs the Work owner's exact graph/object reads; the assessment reader reads
two exact graph records and one indexed Content evidence manifest. Remote
attempt and byte counters, native Jena work, and multi-scale contention remain
unqualified under `docs/testing/complexity.md`.
