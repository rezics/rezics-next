# Sealed VNDB and Wikidata CLI recovery

The frozen outcome is
[`cli-sealed-source-resume.test.ts`](../../../services/kernel/test/imports/cli-sealed-source-resume.test.ts).
The connected [caller](../../../services/kernel/test/imports/cli-sealed-source-resume-fixture.ts) invokes
`runImportCli` with an ordinary operator account key, one private SQLite path and real Auth/public transport.
One `openApiRuntime` owns both sources, native Access, the application and the registered worker. The key is
staged, approved and applied through Auth credential effects and written mode 0600 in tmpfs. The fixture uses
the existing `identitySupport`, `openApiObserver` and runtime `mediaBoundary`; it supplies no native reply,
authority, grant, identifier, receipt or worker result.

The earlier missing-caller gap was a binding gap, not evidence of a production failure. The connected native
journey now passes at the revision recorded below. No production defect was reached or manufactured; the existing
CLI/Importer/materialization contracts supply the required behavior. Promotion remains separate. The native command is:

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
observations. No private JWK or bearer is included. The importer-local companion is a protocol-double proof
of the two acquisition policies and is explicitly separate from the native receipt below.

Local preflight passed on `afcdc8c956`: both importer-local CLI cases, 46 assertions and zero failures;
the direct importer compiler checked 147 files without type errors. Formatting passed for all six changed
files. Subsequent caller observations also compare the completed baseline to the original persisted staged
rows, rather than reconstructing a digest or revision from replacement input. These local results do not
claim a native pass, a root typecheck or all-workspace regression coverage.

## Native receipt

The managed command above tested `fc2509fd177143bafb3a4f598bb0db43c55337a8` and exited 0. The exact frozen
outcome passed: one test, two source children (`vndb`, `wikidata`), 1,686 assertions, zero failures and no
load reruns. The log contains no TypeScript diagnostics. The first native attempt passed; no reached native
failure remains. This selected result is not a root typecheck, full-kernel or main/promotion claim.

The raw journey object is line 75 of
`.temp/goal/checks/worker-check-2026-10-30T08-56-05.553Z-0c77eeff.log`; lines 78–81 record the test result and
assertion count, and line 93 records exit status 0. Its `sources[].originalReceiptRowsBefore/After` retain the
exact native principal/partition/command/key, transaction and response anchors. All 39 original receipts remained
identical: 20 VNDB and 19 Wikidata, including both original VNDB statistic receipts. Two committed responses
were lost before local ACK, leaving one pending envelope per source, with eight VNDB and twelve Wikidata keys.
Both interrupted calls returned 130; replay and successor calls returned 0; fresh invalid inputs returned 2.
No duplicate native effect rows appeared and all three native subject IDs and both independent selections survived.

VNDB validated 7,168 replacement archive bytes before draining the original acquisition. Its malformed
replacement produced no Auth/public effects and left the pending snapshot identical. Wikidata consumed zero
replacement bytes while resuming; the next invocation rejected that malformed stream without effects.
VNDB replay ended at captured write ordinal 41 and successor writes began at 57; Wikidata used ordinals 86
and 99. The registered worker was observed with zero executed jobs and no live Internet requests, consistent
with these sources' lack of admitted media intents.

The actual definition catalogue version was `1.0.0`, bundle digest
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`.
Persisted source rows recorded these revisions and digests:

| Source record   | Converter    | Initial revision/digest                                                       | Drained revision/digest                                                       | Successor revision/digest                                                     |
| --------------- | ------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| VNDB `v123`     | `vndb@7`     | 7 / `be85d221eb60f71db38c70670a8614bad6f93adf7b2f12891255108a50a21a72`        | 8 / `06118c67bfbd388725e25c4f06c844fe32b15169ac585d3398a660d7bd6b11f9`        | 9 / `c61d53e9f684123f74528a46fbf43571dcd6a26ba9a0a7692d864f1d70f2b8e8`        |
| VNDB `v124`     | `vndb@7`     | 19 / `5a4efb4f3b94872b82121c8b7156187c01b55c2b13b5b81052dd97bc18b14448`       | unchanged                                                                     | unchanged                                                                     |
| Wikidata `Q571` | `wikidata-4` | 24681012 / `a821066f040241caf607fd52b34fa79c5696588acc39060e9ee183e3d40d58ba` | 24681013 / `46e125c8d55ca14cc76ca273375a6aeb7856769abe955cfdda4c070cd7740282` | 24681014 / `5561bc9e1849ab8e02eb7c133538508b473e20e213ae1ed8db5fe596ff5998b0` |

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
