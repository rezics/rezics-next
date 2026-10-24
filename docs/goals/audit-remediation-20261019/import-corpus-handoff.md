# Import consumer handoff to the shared corpus producer

G-2791 owns preparation, backup and restore. This document supplies its import
consumer requirements; it introduces no producer or production interface.
Both import rows and all twelve persona cells remain pending. Baseline and
outcome QA are deferred until the shared producer, compatible retained backup
and explicit manager execution authorization are available. No corpus build,
restore, timing, baseline failure or successful product assertion is claimed.

## Consumer and frozen inputs

The consumer is `openImportFixture` and the exported `ImportCorpus` interface in
[tests/qa/support/import-outcomes.ts](../../../tests/qa/support/import-outcomes.ts).
Set `REZICS_IMPORT_OUTCOME_FIXTURE` to the producer's mode-0600 JSON manifest
inside the consuming worktree's `.temp`; the consumer defines no fixed basename.
Its profile is `import-outcomes-corpus-v1`. `REZICS_FIXTURE_ROOT` must resolve to
the same local directory as `fixtureRoot`, and `REZICS_QA_RUN_ID` must equal
`runId`, which differs from `backup.sourceRunId`. The manifest, fixture root and
backup manifest resolve inside that worktree's `.temp`, including after symlink
resolution. Retain Account identities through `realm: RetainedPersonaRealm`;
`restorePersonaRealms` signs them in normally without saved bearer tokens.

The executable selection owner is
[tests/qa/fixtures/catalogue/import-outcomes.json](../../../tests/qa/fixtures/catalogue/import-outcomes.json).
Preserve every source file/record/edge digest, exact key, original edge index,
inventory item and disposition. Both named selections are required by the
current consumer: `fate-goldberg-v1` (VNDB and MusicBrainz) and
`index-goldberg-v1` (Bangumi and the same MusicBrainz identities). These are
isolated command-created copies of retained bytes. The existing 113 shared Works
and source snapshots remain untouched; no network capture is needed or allowed.

`selectionDigest` is the support module's `digest(matrix)`, SHA-256 of
`canonicalJson` over the **whole corrected matrix**, including `baselineProduct`.
For this correction it is
`e86819db195bef7bc5d9a4e986ad628e521b748441ba9bd21d1788f18428c305`.
Recompute it from the executable matrix when emitting a manifest. Changing the
baseline pin changes this digest without changing any retained source digest.
The staged planning input and historical execution records are retained as-is.

`sourceRoot` supplies `snapshots/<matrix.sources[].id>/snapshot.json`. The loader
checks exact file bytes, snapshot identity/digest, selected record digests and
edge closure. `sources[sourceKey]` records actual `record`, `observation`,
optional successful `conversion`/`proposal`, and nonempty `parts` with actual
Source record and observation IDs, SHA-256 `rawDigest` and exact `rawBytesBase64`.
`reconstructIntake` checks the
parts against the retained normalized record, Bangumi API subject, or provider
payload as appropriate. Retain existing chunk framing rather than inventing
smaller successful provider responses. The retained Bangumi 404 is evidence of
failed acquisition, not a newly successful capture.

## Public commands and receipts

Use the existing source routes in
[sources.ts](../../../services/main/src/routes/sources.ts) and support routes in
[source-supports.ts](../../../services/main/src/routes/source-supports.ts).
The command sequence below names supported public operations; an unavailable
mapping or rejected command must be reported with its real response.

| Operation | Input and receipt required by this consumer |
| --- | --- |
| `POST /v1/sources/intakes` | `source-manual-intake-v1`, retained exact bytes, original provider/namespace/external ID and truthful rights evidence; retain returned record/observation IDs, byte digest and each chunk's bytes |
| `POST /v1/sources/observations/{observation}/conversions` | A mapping profile actually supported by that product revision; retain conversion/observation identity, `mappingRevision`, source digest and projection. The existing `bangumi-subject-map-v1` adapter does not establish VNDB VN or MusicBrainz multi-grain support |
| `POST /v1/sources/conversions/{conversion}/source-graph` | `source-mapped-values-v1`; retain the real graph result and its identity/receipt for later exact readback |
| `POST /v1/sources/conversions/{conversion}/proposals/native-work` | `source-native-work-proposal-v1`; retain the real proposal, including the Bangumi proposal used by negative authority cases |
| `POST /v1/sources/proposals/{proposal}/adoption/native-work` | `source-native-work-adoption-v1` with authorized acting subject and exact source title/language; bind only genuinely returned native Work/Main Version identities |
| Existing native semantic/relation/Structure and publication commands | Retain real resource/revision/occurrence, Definition revision, rights assessment and publication receipts. Do not substitute a same-name Work for a release, track, recording, composition or Agent |
| `POST /v1/works/{id}/source-title-applications/{candidateProposal}` | Retain the supported real request body, idempotency key and identity receipts for `refresh.command`; its candidate must derive from retained evidence or a distinct supported mapping revision |

`selections` contains both names and nonempty lists of `Command` receipts:
`{method: POST|PUT, path, body, key, status, identity}`. `identity` is a nonempty
map of RFC 6901 response pointers to the actual returned identity strings.
The consumer replays the request with the original key, accepts 200/201 and
compares each identity. Its allowlist is `/v1/sources/`, `/v1/semantic/changes`,
`/v1/works`, `/v1/relations/changes` and `/v1/compositions`; a receipt for another
command alone cannot satisfy selection replay. `status` records the observed
original response; it is not permission to turn a failed command into success.

Genuine preparation prerequisites are explicit `platform:catalogue-import`
exposure for the fixture operator, supported `grantFixtureAuthority` grants and
receipts (including `work:create:catalogue-import` / `work.create`), the owner's
scoped synopsis editorial authority, legitimate rights assessments/publication,
and restored identities/readiness. Sign-in, membership, ownership or moderation
does not supply import authority. Stranger/member/moderator retain no import
exposure. Preserve Bangumi attribution and CC BY-SA 3.0 synopsis obligations;
other text, images and source activity need their own truthful rights basis.
`authority.operatorAccount` must equal `realm.identities.operator.accountId`.

## Prerequisites versus proposed product results

`targets[sourceKey]` is a real `{resource, revision, kind, mainVersion?}` binding.
Populate it only from successful commands for the required original grain.
`relations[inventoryKey]`, when observed, supplies the exact native occurrence,
Definition and Definition revision. The tests can search public relations when
that receipt is absent. `music.release` and `music.track` are optional actual
bindings: their absence must reach the native release/track assertions, not
trigger a producer requirement that a missing proposed outcome already succeed.
`music.nameHead` is the actual native Bach name head used as the support CAS
basis. `hidden` records real private resource/observation/conversion/proposal
identities and an original fixture canary under a different principal. It is not
third-party source evidence and has no public existence basis.

The four proposals remain in the
[import outcome specification](import-outcomes.md#interfaces-proposed-for-review):
public source coverage/discovery, principal-private conversion inventory, support
for the existing native name slot, and Structure parts for genuine releases.
They belong to the existing source, field-support/name and Structure owners.
Do not make their successful responses preparation conditions. Leave missing
native fields, typed/inverse relations, classifications, releases/track parts,
coverage/inventory and name-support attachment/withdrawal to the unchanged
test-body assertions. No positive adopted binding may be relabelled source-only
to pass. Program reading and disposition are required before assigning a
separate implementation author. The earlier program-reading mail was rejected
because no program Goal was registered; delivery has not occurred.

Some real fixture inputs are still mandatory and cannot be supplied truthfully
by a missing interface. `assertOriginals` calls `target` for the VNDB/Bangumi
originals and MusicBrainz album, recording and composition; later checks need
the elected relation endpoints, unknown release, failed-lookup identity and Bach
Agent. Missing those bindings is a named `TEST PREMISE`, not an outcome failure.
The native Bach name must exist before its support adapter is exercised.
Existing inventory/editorial assertions still require real per-record
conversions at their point of use. A missing successful conversion may now be
represented by an absent `sources[key].conversion`, rather than a fabricated
ID; a proposed retained conversion is exercised in the outcome body. Report
failed current commands and distinguish a missing supported fixture path from
a reached product assertion. Negative authority cases still need the actual
Bangumi conversion/proposal they address.

`refresh` currently requires `sourceKey`, distinct real base/candidate conversion
IDs, a real supported source-title command and actual `oldGeneration` /
`newGeneration` public tokens. A successful refresh or new coverage API must not
be run merely to fabricate those tokens for setup. If that revision cannot
provide the required generations or native bindings, G-2791 must retain its
executable preparation stages and report the exact missing input to the manager;
this consumer cannot yet be declared ready. No test/helper changes here resolve
that prerequisite, and no missing token is represented as a guessed success.

## Joint retained-record and native verification inputs

The [joint admission contract](import-admission-contract.md) and
[local proposal types](../../../tests/qa/fixtures/catalogue/import-admission-contract.ts)
extend this handoff without changing the frozen selection digest above. G-2781
remains the pure adapter, G-2778 the only importer wiring owner and G-2791 the
only producer. G-2772 keeps independent native facts/attribution assertions and
joint Semantic/Statement exact target/value/head verification. No producer
adapter result is adoption, publication, source support or a successful native
verification receipt.

For the four `retainedAdmissionCases`, supply `sources[key].retainedRequest`
using the exact selected full `DatasetRecord`, pinned snapshot identity/digests,
ordered actual part-record/observation/byte receipts and exact assembled payload
metadata. The request is a proposed conversion input, not a successful result;
retain it even when no compatible command exists on the product baseline.
`parts[].record` must come from the real intake response. Normalized fields
outside `.data` are part of the record digest, not invented fields in provider
JSON. Do not rewrite bare payloads into envelopes or mark incomplete part
observations complete to satisfy conversion.

The test bodies call the existing conversion route with the proposed request,
observe its real result, and require its verified `retainedRecord` binding.
`retainedBinding` may contain a previously returned real result, but is not
required as successful setup. Tests keep new results separate from legacy
`record`/`conversion`/proposal/adoption receipts. Record/digest/byte/part-order
refusals and replays must leave the original binding unchanged. The native name
test then sends v2 support requests with exact record coordinates and native
head/value, checks wrong record/digest/conversion/target/value/head refusals,
and independently withdraws one real record support. No caller-supplied record
digest or mapping name is itself evidence admission.

Supply `synopsisSupport: {support, supportIdentity}` only if the actual
source-origin synopsis control command returned that support and its
principal-private management read returned the matching identity. After same-value human
confirmation, its withdrawal must preserve human control and public text. This
is an outcome-body assertion when the product has not returned that support;
do not fabricate a successful support receipt just to build a manifest.

Current real-command gaps are explicit: registered VNDB/MusicBrainz full-record
conversion and multipart/original-record binding, normalized-to-payload field
correspondence, the name adapter, and generic Semantic/Statement support
verification. Coverage, private inventory and genuine release parts remain the
original pending proposals. Unsupported fields, source languages, multiline or
oversized descriptions and exact numeric/date values retain their original
bytes and a reasoned unresolved disposition; they cannot be fixed by truncation,
locale guessing, scalar-slot substitution or fabricated successful receipts.
Positive Bangumi synopsis/domain fields, native relations and MusicBrainz grain
assertions remain mandatory.

Genuine fixture prerequisites still include explicit operator exposure/scoped
authority, truthful rights/publication receipts, actual native read/head inputs,
exact retained bytes and stopped-owner restore compatibility. Proposed interface
successes belong in test bodies. If those genuine inputs cannot be obtained
through current public commands on the original baseline, hand off the exact
refusal/missing command; no baseline product failure has then been established.

## Baseline compatibility, backup and later proof

For `phase: baseline`, `productRevision` and consuming checkout HEAD must both be
`69eac3ceeaf885be70205a70248bc951e9d81cc9`. Overlay only independently identified
authored declaration/test/support/matrix files onto that pristine product tree;
record the specification wave revision separately. A later product revision,
new mapping implementation or newer storage cannot silently replace the original
baseline. The existing consumer imports `reconstructIntake` and `canonicalJson`;
both exports exist at the original baseline by static inspection. This is not
an executed baseline compilation or compatibility result.

Use [createCorpusBackupDriver](../../../scripts/load/corpus-backup-driver.ts),
[retainStoppedOwnerBackup / restoreCatalogueBackup](../../../scripts/load/catalogue-backup.ts)
and their existing compatibility checks. The backup manifest format is
`command-catalogue-backup-v1`; retain its actual SHA-256, original `runId`, and
exactly `postgres_data`, `fuseki_data`, `rustfs_data` once, with all owner writers
stopped. It must pass the original baseline's storage compatibility requirements:
owner migrations, generated model, compose/text configuration and Account
dependency metadata. A backup built on the newer wave is not assumed compatible.
Static comparison at this handoff already finds changed `infra/dev/compose.yaml`
and the added `services/main/migrations/access/2605_discovery_refresh_disposition.sql`
relative to the audit baseline. A current-wave physical backup therefore cannot
be treated as the original baseline's compatible backup without resolving those
storage prerequisites through the existing owner.
Do not rewrite compatibility digests or introduce another backup/restore owner.

Record measured `preparation.{buildMs,restoreMs,startupMs,readinessMs,totalMs}`.
Build and each isolated restore/startup/readiness preparation are bounded by
600,000 ms; `totalMs` includes at least restore + startup + readiness. Preserve
the single consistent stopped-owner backup and use a fresh isolated restore for
each prove file. No success or timing has been measured by this continuation.

After the manager authorizes execution, run these files serially, each with its
own fresh restore of that same compatible backup and manifest environment:

```sh
bun /home/edge/projects/rezics/rezics-next/scripts/goal/goalctl.ts job -- bun scripts/goal/goalctl.ts test tests/qa/integration/outcomes/catalogue/import-fidelity.test.ts
bun /home/edge/projects/rezics/rezics-next/scripts/goal/goalctl.ts job -- bun scripts/goal/goalctl.ts test tests/qa/integration/outcomes/catalogue/source-coverage.test.ts
```

Both files exercise visitor, stranger, member, owner, moderator and operator.
Record baseline revision, specification revision, selection digest, backup and
restore IDs, preparation budget, exact body title and first reached assertion
for each persona. Hook/authentication/restore or missing-binding failures remain
unconfirmed premises. A green pending runner exit alone proves no cell.
