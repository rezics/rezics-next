# Sealed VNDB and Wikidata CLI recovery

The frozen outcome is
[`cli-sealed-source-resume.test.ts`](../../../services/kernel/test/imports/cli-sealed-source-resume.test.ts).
The connected [caller](../../../services/kernel/test/imports/cli-sealed-source-resume-fixture.ts) invokes
`runImportCli` with an ordinary operator account key, one private SQLite path and real Auth/public transport.
One `openApiRuntime` owns both sources, native Access, the application and the registered worker. The key is
staged, approved and applied through Auth credential effects and written mode 0600 in tmpfs. The fixture uses
the existing `identitySupport`, `openApiObserver` and runtime `mediaBoundary`; it supplies no native reply,
authority, grant, identifier, receipt or worker result.

The earlier missing-caller gap was a binding gap, not evidence of a production failure. This slice supplies
the caller and local ordering proofs. A managed native pass and promotion must be recorded separately;
registration and local doubles do not establish either. The native command is:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-sealed-source-resume.test.ts
```

## Actual journey and acquisition decisions

Each source first publishes its bounded pinned fixture. A separate observer accepts one imported title,
creates and accepts an independent title, and adopts only the independent title in its own Context. A changed
generation then loses a real committed bulk response before local acknowledgement. All CLI handles close.
The fixture independently reopens `ImportSession`, reads RunStore pending envelopes and RecordBindings journals,
and queries exact native receipt anchors before scheduling recovery.

VNDB retains its existing archive-first contract. Complete ustar framing wraps the six pinned COPY/header files,
with actual native IDs `v123` and `v124`. Changes affect `v123` title, entry revision and licensed average;
`v124` remains unchanged. A late duplicate entry is rejected before Auth or application requests, while the
old RunStore baseline, pending bytes/keys and acquisition links remain identical. Valid replacement input is
fully consumed and validated before old work drains, but its grouped records are not enumerated for publication.
The completed generation still links to the original table acquisition. A later invocation acquires and
publishes the successor. Linked acquisitions are selected by actual RunStore generation, never a pending Map.

Wikidata retains its existing sealed-first scalar contract. Its pinned `Q571` fixture uses JSON-array framing
split across 127-byte stdin chunks. Replacement input deliberately lacks the closing array bracket. Recovery
must not advance that iterator at all. On a fresh invocation the same malformed bytes reach EOF, reject with
status 2 and leave the baseline and native effects unchanged. A subsequent well-framed stream publishes the
successor. Native revisions are the fixture's `24681012`, then `24681013` and `24681014`; VNDB uses 7/8/9 for
`v123` and retains revision 19 for `v124`. Persisted source digests and actual converter registrations are emitted
in the raw journey object rather than predicted by the fixture.

For both sources, successful replay is compared against the persisted pending body and keys. Exact original
bulk and statistic receipt rows, native subjects/candidates/retractions/revisions/statistics, bootstrap and old
proposal attachments, media journals and independently selected titles are observed. Successor write ordinals
must follow the old generation's final replay. VNDB requests retain the existing seventh
`source_statistic:write` scope; Wikidata uses the ordinary six scopes. Native nonzero statistic rows and public
mean/count are read through their actual native boundaries. No media intent is admitted by these two factual
fixtures; worker registration and absence of live Internet requests are observed, without inventing executed jobs.

The raw native log emits one credential-free JSON object tagged `cli-sealed-source-resume`, including both child
names, source/converter/bundle revisions, requests/responses, pending envelopes, receipt rows and selection
observations. No private JWK or bearer is included. Until that managed command completes, there is no native
receipt for this caller and no native success claim. The importer-local companion is a protocol-double proof
of the two acquisition policies and is explicitly separate from native acceptance.

Local preflight passed on `afcdc8c956`: both importer-local CLI cases, 46 assertions and zero failures;
the direct importer compiler checked 147 files without type errors. Formatting passed for all six changed
files. Subsequent caller observations also compare the completed baseline to the original persisted staged
rows, rather than reconstructing a digest or revision from replacement input. These local results do not
claim a native pass, a root typecheck or all-workspace regression coverage.

## Bounds, sources and limits

The caller uses existing input, page, projection, candidate, public envelope and retry caps. Reads use exact
source/record/generation, tuple, subject and receipt keys. Work follows supplied bytes and the existing
`O(input bytes + (S+D)(1+q)logR)` bound with bounded `q`; it performs no catalogue/history scan. Existing local
counted ceilings and canonical/derived native growth suites are unchanged. This outcome introduces no PG growth
series; native growth evidence for this connected journey remains missing. General SourceRecord metadata
ordering, richer licence inference, measured-word producers and six-surface discovery remain deferred.

Read sources: CLI and credential boundaries, Importer, ImportSession, RunStore, RecordBindings, source registry,
VNDB materialization/table/archive readers, scalar dump reader, both converters and their pinned fixtures,
native API runtime/observer, identity support and media boundary. The read-only reference index was inspected;
no reference implementation was required to bind these existing production contracts. No frozen acceptance
file or shared harness is changed. No production defect is inferred solely from missing caller coverage.
