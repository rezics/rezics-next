# Bangumi conversion completion evidence

Reviewed checkout: `50253f81316a8e975d67971fb62ed42db3145c10`.
This is scoped review evidence, not an additional source contract or acceptance gate.
The imports manager brief was read completely from the supplied read-only path.
Its Done-when requires main integration and a passing root gate; neither is established here.
All file:line references below are relative to this checkout unless marked `legacy-final`.

The review covers Bangumi conversion, its shared helpers, source reader/registration,
and source-specific fixtures and test bindings. Public API coverage is mapped by inspection;
authorization, general reconciliation, mass disappearance, fences and root-gate execution
belong to their independent reviews. No root/kernel check, remote check, installation,
or product test was executed. Only the report-existence acceptance is run for this change.

Status vocabulary: **proved-by-current-code-and-tests** means implementation and actual
test assertions agree by inspection, not that a passing execution was observed here.
**incomplete/contradicted** identifies a missing surface or conflicting current evidence.
**unverified** means this review cannot establish the requirement at its owning boundary.

## Requirement findings

1. **proved-by-current-code-and-tests — pure per-record conversion.**
   `packages/conversion/src/bangumi.ts:84` copies only declared data descriptors;
   `:134` synchronously returns commands, diagnostics and deferred media requests.
   It has no transport/storage call. Unknown/private trees are not traversed (`:73`, `:273`).
   `specs/imports-bangumi.test.ts:214` compares repeated results and unchanged input while
   intercepting I/O; `packages/conversion/tests/bangumi-growth.test.ts:55` independently
   installs fetch, filesystem, socket, process and SQL traps around the real export.
   These guards cover exercised JavaScript entry points, not arbitrary native side effects.
   Helper memoization and an inaccurate retention claim are distinguished below.

2. **proved-by-current-code-and-tests — explicit stable converter revision.**
   `packages/conversion/src/bangumi.ts:20` exports literal `bangumi@2`; `:140` accepts
   a trusted registration override, and `:166` includes it in hashed command identity.
   Source payload revision claims are ignored. `packages/conversion/tests/bangumi-growth.test.ts:94`
   asserts default/override revision, identical data digest, target rebinding and privacy;
   `packages/conversion/tests/source-registration.test.ts:21` asserts isolated alias keys.
   `services/importer/src/source-registry.ts:45` registers the same exported constant/function;
   `:119` validates configuration and `:131` forwards the revision explicitly.

3. **proved-by-current-code-and-tests — proposals with citations.**
   `packages/conversion/src/bangumi.ts:161` builds actual `schema:url` references;
   `:184` emits original/Chinese name candidates and `wdt:P5732` external identity;
   `:218` emits a literal Text-profile summary. Original language stays `und`, Chinese `zh`.
   Cover statements reference both record and image source (`:241`, `:254`).
   All output commands pass the production portable validator (`:264`).
   `specs/imports-bangumi.test.ts:113` follows pointers into statements and references,
   checks the actual portable shape, and `:268` checks every supported type/title mapping.
   Bootstrap labels are metadata without statement references, as the test explicitly permits.
   Tags/platform/infobox/date/NSFW remain source data plus omission diagnostics (`:271`);
   that is the conversion README's present mapping (`packages/conversion/README.md:126`).

4. **proved-by-current-code-and-tests — two-phase conversion; unverified — uniqueness.**
   `packages/conversion/src/bangumi.ts:207` emits one metadata-only create without a subject;
   `:217` emits only proposals against the caller's resolved real subject ID otherwise.
   Command keys include source, external ID, revision, digest, converter, group, field and target
   (`:166`); no random/time-generated target exists. Deferred assets have no container until bound.
   `packages/conversion/tests/bangumi-bootstrap.test.ts:6` checks one create, no embedded
   statements, bound proposal targets, unchanged digest and production command validation.
   Its target UUID is supplied by the test, not returned by an actual create-or-resolve API.
   The converter cannot itself prove the server's durable `(source, external_id)` uniqueness.
   The README's public-response rebinding example (`packages/conversion/README.md:94`)
   documents that obligation; server bootstrap/restart proof remains outside this review.

5. **proved-by-current-code-and-tests — revisions and SHA-256 detection.**
   `services/importer/src/dumps.ts:173` initializes revision to null; the Bangumi branch
   (`:214`) extracts the native ID without inventing a dump-date revision.
   `packages/conversion/src/bangumi.ts:155` serializes absence as `unversioned` and preserves
   supplied non-null revision. `packages/conversion/src/support.ts:193` canonicalizes a
   sanitized JSON snapshot and hashes SHA-256 (`:125`), independent of target/configuration.
   `packages/conversion/tests/support.test.ts:12` checks exact envelope revisions; `:27`
   checks canonical order and input sensitivity. Bangumi growth assertions (`:94` in its
   test file) check digest changes for accepted platform data and stability for private fields.
   Digest coverage is the accepted projection, not every byte of an untrusted source record.

6. **proved-by-current-code-and-tests — summary rights and separate cover credit.**
   `packages/conversion/src/bangumi.ts:221` attaches CC-BY-SA-3.0, Attribution,
   ShareAlike and the linked Bangumi-contributors attribution to each summary proposal.
   `:235` credits covers to `(c) rights holder`, with linked `via Bangumi`, unknown licence
   and cover provenance; it never assigns the metadata licence to image copyright.
   `specs/imports-bangumi.test.ts:299` asserts exact full decoded summary and rights pointers;
   `:327` checks separate cover rights, deferred requests and supplied available-media mapping.
   Its media UUID is a fixture binding: no bytes are downloaded or media job run by that driver.
   **unverified — complete metadata licence/attribution delivery.** Facts have source citations
   but no explicit metadata licence/contributor attribution in their commands or sourceMetadata
   (`packages/conversion/src/bangumi.ts:177`, `:286`). Current bulk validation deliberately
   rejects rights on non-summary commands (`packages/definitions/src/bulk.ts:287`), and
   API tests require no facts rights (`specs/imports-api.test.ts:341`). The source inventory
   records CC-BY-SA-3.0 (`packages/definitions/sources/bangumi.yaml:13`); this does not by
   itself establish how metadata attribution reaches readers. Do not add a facts rights body
   by inference; the existing bulk contract must remain authoritative. Disclosure proof is missing.

7. **proved-by-current-code-and-tests — bounded accepted values without truncation.**
   `packages/conversion/src/bangumi.ts:79` rejects invalid/oversized strings; `:112` rejects
   more than 64 tags; `:129` rejects normalized JSON beyond 64 KiB. Titles cap at 500,
   tags at 200 each. `packages/conversion/src/support.ts:331` rejects summary text or its
   serialized document beyond 32 KiB; literal Markdown/CRLF is preserved, not interpreted.
   `packages/conversion/tests/bangumi-growth.test.ts:37` exercises 1/8/64 tags and rejects 65;
   `:125` decodes actual summary, compares complete text and rejects oversized snapshots.
   Bound commands are at most five: external ID, two names, summary and mapped cover.
   `packages/conversion/tests/logical-growth.test.ts:127` calls the real export across unrelated
   populations; `:145` measures entire actual returns at three sizes, largest above 90% of
   the source byte guard. This proves serialized footprint assertions, not heap or time bounds.
   Wider mapping obligations from the current inventory have a separate mismatch below.

8. **proved-by-current-code-and-tests — required subject JSON-lines reader.**
   `services/importer/src/dumps.ts:94` uses the bounded streaming byte/line helper and
   fatal UTF-8 decoder; `:213` parses each JSON object, validates ID/type and yields the full
   payload. Limits are explicit (`services/importer/src/dumps-bytes.ts:12`).
   `specs/imports-dumps.test.ts:66` compares complete fixture payloads, ID strings and null
   revisions across byte splits. `:115` covers CRLF/final complete line without newline;
   `:153`, `:163`, `:254` cover malformed/truncated/invalid-UTF-8 rejection.
   `services/importer/tests/dumps-driver.ts:234` binds `read` directly to production `readDump`;
   `services/importer/tests/dumps-outcomes.test.ts:5` launches that unchanged suite.
   `specs/fixtures/imports/dumps/bangumi-subject.jsonlines:1` contains raw string infobox
   and multiline escaped summary; no API-style infobox array is required to read it.
   This proves decompressed subject-record framing, not archive extraction or other tables.

9. **proved-by-current-code-and-tests — community API and importer share conversion.**
   `packages/conversion/package.json:6` exports the Bangumi source module publicly;
   `services/importer/src/source-registry.ts:3` imports that package subpath directly.
   `:81` preserves native output and aliases normalizedRecord for the importer, without
   a separate semantic conversion. `services/importer/tests/source-registry.test.ts:14`
   calls the actual registration and asserts configured envelopes/revision, valid commands,
   rebinding equality and rejection of a mismatched source context.

10. **proved-by-current-code-and-tests — user posts are excluded.**
    The projection at `packages/conversion/src/bangumi.ts:84` never reads posts, comments,
    reviews or account identifiers. `specs/imports-bangumi.test.ts:386` compares the whole
    result to the same record with hostile extensions removed, including normalized data.
    `:465` adds nested forged rights/source/revision and unknown private values.
    The reader preserves source payload; it is the converter that removes those extensions.

## Current mismatches and deterministic follow-up evidence

- **incomplete/contradicted — infobox cover mapping.** The merged source inventory says raw
  infoboxes are parsed and image/cover keys feed the cover group
  (`packages/definitions/sources/bangumi.yaml:43`), whereas the converter retains infobox
  only as opaque text (`packages/conversion/src/bangumi.ts:120`, `:273`). Small input:
  `{id:1,type:2,name:"A",infobox:"{{Infobox animanga/TVAnime\n|image=https://lain.bgm.tv/cover.jpg\n}}"}`,
  external ID `1`, revision null, no target. Expected under that inventory: a deferred
  cover-group asset referencing the stated image; actual by inspection: `coverAssets: []`
  and `unsupported_infobox_mapping`. Smallest owner boundary: conversion's Bangumi parser.
  A regression sketch compares that asset URL/provenance to conversion of the equivalent
  `images.large` record. Existing API fixture supplies *both* representations
  (`specs/fixtures/imports/api/bangumi.jsonl:1`), so its cover scenario misses this gap.
  The README still explicitly permits opaque infobox omission; this report does not resolve
  that contract mismatch or authorize extending all inventory mappings.

- **incomplete/contradicted — supported source scope.** Inventory excludes music/live action
  (`packages/definitions/sources/bangumi.yaml:32`), but converter/reader accept types 3 and 6,
  and `specs/imports-bangumi.test.ts:270` expressly requires them. Input
  `{id:1,type:3,name:"A"}` produces a MusicAlbum create, rather than omission under the
  inventory. Type 6 likewise produces TVSeries. Boundary: Bangumi conversion/reader contracts.
  Existing tests cannot settle the conflicting current scope; none was edited here.

- **incomplete/contradicted — retention evidence, not an observed conversion failure.**
  `packages/conversion/README.md:248` says no per-record state is retained across calls.
  Actually `packages/conversion/src/support.ts:315` memoizes 64 summary texts/snapshots;
  `:233` also memoizes accepted cover bodies. Two calls with summary `"A"` reuse the same
  document snapshot (`textDocument` at `:322`); a strict identity assertion demonstrates it.
  Snapshots are frozen (`packages/document/src/index.ts:209`); bounded memoization does not
  demonstrate nondeterminism or mutation. Smallest boundary: conversion README's evidence claim.
  Equality/serialized-growth tests cannot establish the stronger no-retention statement.

## Source-specific public API coverage and remaining limits

`services/kernel/test/imports/api-outcomes.test.ts:5` binds the suite to `api-driver.ts`;
`api-fixture.ts:25` delegates runs to runtime. `api-runtime.ts:680` reads actual dump bytes,
`:682` calls production importer with the shared registration; its injected fetch dispatches
Requests through `app.handle` (`:449`, `:504`). This is an in-process HTTP boundary, not a
live socket transport. `api-fixture.ts:133` also exposes the actual pure converter separately.
Synthetic bytes/IDs and media-source setup (`api-runtime.ts:268`) replace live Bangumi data.

`specs/imports-api.test.ts:371` requires a disclosed complete summary and available cover;
`:177` compares stored/disclosed document bytes, digest, rights and transaction observations;
`:199` checks actual media credit, transitions, public request and shared image pipeline.
`api-fixture.ts:30` obtains those observations from the media boundary and captured request.
`specs/imports-api.test.ts:930` adds hostile posts and checks rejection of oversized summary.
Restart/change/disappearance/fence scenarios exist in that suite, but their general API and
lifecycle proof is deliberately not duplicated here. None of these API scenarios was run.

Reference reads: `legacy-final:packages/conversion/src/bangumi.ts` and `errors.ts` were read
only for identity/type/title validation and pure conversion; obsolete grain/slot output was
not adopted. The read-only reference index was inspected; no additional reference project
was needed for this evidence review. Existing merged contracts take precedence over discussion.

No outside-path file was changed. Decisions: treat memoization separately from observable
purity, preserve current bulk rights shape, and expose inventory conflicts without choosing
new policy. The scoped implementation/test trace supports the qualified findings above;
main integration, executed root-gate results and complete metadata-rights disclosure remain
unverified. Known central check-host saturation is not evidence of a product defect; no host
was contacted and no overload workaround or product change is proposed by this report.
