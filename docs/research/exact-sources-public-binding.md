# Exact selected synopsis in Sources

Recommendation: extend the existing Sources producer with one independently admitted, Global-only selected match.
Compare the original admitted selection on the server; return its redacted fact and a match result, not document locators.
This is research for adoption, not an enabled capability or a new authority layer. Exact receiving remains unsupported;
“Visit general Sources” continues to read current facts independently and proves no selected synopsis binding.
Proposed owner decision: prefer a bounded server comparison over disclosing document binding metadata in Sources.
Adoption belongs in [Subject pages](../subject-pages.md#choose-a-supplied-work-synopsis), with the Sources correction
owner linking it; this report makes no owner-document, registry, endpoint, package or product change.

## Established call graph and boundary

The following are source-inspection facts, not executed acceptance results. Paths refer to this repository.

| Stage                        | Installed callable and consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synopsis page                | `loadSubjectPage` in [subject.tsx](../../apps/web/src/features/pages/subject.tsx) calls `client.pages.$read.post`; `subjectBody` extracts the native Subject result. This is not a separately reconstructed Sources reading.                                                                                                                                                                                                                                                                          |
| Native page                  | [presentation/http/pages.ts](../../services/kernel/src/presentation/http/pages.ts) probes the Subject, resolves the page Context, then uses `readPage` in [presentation/reads.ts](../../services/kernel/src/presentation/reads.ts). Document operations retain caller credentials and native session components.                                                                                                                                                                                      |
| Synopsis document projection | `pageDocumentReferences` in [composition/documents.ts](../../packages/composition/src/documents.ts) picks one best-rank, spoiler-safe document per property and preferred language, sorting candidate IDs. `readPage` calls existing `/v1/documents/:id`, checks Subject/candidate/document/digest/language, available state, canonical body and SHA-256.                                                                                                                                             |
| Web exact selection          | `synopsisChoices` / `synopsisReturnMatches` in [model.ts](../../apps/web/src/features/pages/subject-summary-reading/model.ts) keep same-language assertions separate. [overview.tsx](../../apps/web/src/features/pages/overview.tsx) uses `statementDocument`, or an explicit `readPublicSubjectDocument` retry, for the selected body. The page's initial single-document preference cannot stand in for the second choice.                                                                          |
| Native Subject               | `KernelClient.subjects({id}).get` / `SubjectRead` derive from mounted routes in [client/index.ts](../../packages/client/src/index.ts), including generated [subjects.d.ts](../../packages/client/src/kernel/semantic/http/subjects.d.ts). [semantic/http/subjects.ts](../../services/kernel/src/semantic/http/subjects.ts) owns `subject.get`, `/v1/subjects/:id`, and `ItemSchema`.                                                                                                                  |
| Native fact authority        | `readSubject` in [subject.ts](../../services/kernel/src/semantic/subject.ts) resolves current slots, release layers and Context; `slotView` omits hidden candidates; `supportedFacts` checks original revision support/fences; `disclosedTargets` independently admits item targets. Revision/security changes restart native admission under its deadline and session positions.                                                                                                                     |
| Ordinary Sources             | [subject-sources.ts](../../apps/web/src/features/catalogue/subject-sources.ts): `readSubjectSources` reads that native Subject; `explainSubjectSources` applies `bestRank`, `defaultReader` spoiler filtering and preferred document language. Document/media values become `somevalue`; `SourceFact` keeps statement ID, qualifiers and citations but no exact document binding. Global Context is not copied into `SourcesPageData`.                                                                |
| Sources BFF                  | [subject-sources-actions.ts](../../apps/web/src/features/catalogue/subject-sources-actions.ts): `loadSubjectSources` uses anonymous Global native reading; Realm instead uses `subjectKernelClient` → `loadSubjectPage` → `subjectBody`, retains page Context, and removes editorial links. `readCurrentSubjectSources` prepares the session, checks `expectedReader`, then reads current viewer advice independently.                                                                                |
| Mounted Sources              | [Sources route](../../apps/web/src/routes/subjects/$id_.$slug_.sources.tsx) validates `via` as return intent; loader dependencies currently contain Realm only. It uses a new visit UUID and a live effect for authenticated/signed-out refresh. [SubjectSourcesPage](../../apps/web/src/features/catalogue/subject-sources-page.tsx) and [useSourcesRetry](../../apps/web/src/features/catalogue/subject-sources-retry.ts) own presentation, Retry and focus. There is no exact receiver here today. |

`statementDocument` in [documents.ts](../../apps/web/src/features/pages/documents.ts) admits only a document keyed by
the assertion ID whose `id`, `subjectId`, `candidateId`, `digest`, `language`, available state and valid body agree.
The Subject exposes `id`, `context`, `release`, `revision`, and statements with `id`, property, rank and `rezics`
release/revision. A descriptive synopsis holder is that Subject/property slot; no separate public holder ID is supplied.
Context is the Subject's resolved Context, not a URL inference. Page selected Context and catalogue release are additional
observations: require their consistency where supplied, rather than replacing the native Subject's release with them.

Crucially, Subject document references are not Content document authorization. `readDocument` in
[document-read.ts](../../services/kernel/src/content/document-read.ts) independently checks stored Subject/candidate,
Access, candidate disclosure/security revision, immutable reference binding, original imported tuple fences and final
availability. It releases each home before acquiring another. `readCandidateDisclosure` reports disclosure, not current
best-rank selection; an old but disclosed document alone cannot prove a current selected assertion.
`publicDocument` / `PublicDocumentViewSchema` in [document-public.ts](../../services/kernel/src/content/document-public.ts)
can disclose imported erased metadata with `body:null`; authored erasures are concealed tombstones. Neither is an
available synopsis match. Image withholding suppresses its association, not the Subject. Content remains the document
disclosure/erasure and publication owner; Semantic remains the fact and Context meaning owner.

## Proposed tuple and minimal result

Let the comparison tuple be `(Subject, holder=Subject, schema:abstract, statement, resolved Context, Subject release,
document ID, digest, exact supplied language)`, plus any originally observed page release/Realm constraints.
The current statement's native rank/adoption and currentness basis must still admit this tuple. Never substitute a
same-language sibling, another preferred assertion, a replacement document, a merged holder or another language.

| Field                                                                | Already admitted source                                       | Proposed browser Sources output / server use                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject, statement, property                                         | Native `Item` / selected assertion                            | Public only after fresh admission; the returned statement is the exact row identity. Holder remains the native Subject, not parsed from href.                                                                   |
| Context, Subject release                                             | `Item.context`, `Item.release`                                | Include freshly admitted Context/release with the match. A request's claimed Global Context is only a constraint.                                                                                               |
| Page release, Realm, locale                                          | Original page observation / validated visit                   | Equality/scope constraints and lifetime inputs; no URL-derived Context authority. Realm and non-Global exact receiving remain unsupported.                                                                      |
| Document ID, digest, supplied language                               | Selected `value.content`; independently bound Content reading | Server comparison operands only in Sources. Retain the original admitted inputs privately for the pending attempt; do not echo or reveal them in the result, DOM, accessible names, telemetry or errors.        |
| Body, provider locator, Content rights                               | Content's separately admitted document                        | No body fetch from a locator by the browser; no prose or media rights derived from citations or source records. Existing Content admission may read a bounded body internally, but Sources never serializes it. |
| Qualifiers and references                                            | Exactly the matched statement                                 | Existing safe snak projection and whole-association spoiler gate. `citations: []` is admitted emptiness; filtered/withheld evidence is not an invented citation or a licence.                                   |
| `subject.sourceRecords`, cover credit                                | Independent selected support / cover admission                | Keep existing separate Sources presentation. Never attach these records as synopsis citations or use provider metadata as identity.                                                                             |
| Native revisions, security revisions, anchors, original tuple fences | Native authorities                                            | Server-only currentness operands; no bearer token, proof service, generic descriptor engine or browser security-revision comparison.                                                                            |

The current public synopsis reader admits the tuple across Subject and Content reads, not through one atomic combined
Sources contract. Copying `value.content` into `SourceFact` would bypass the intentional presentation redaction and would
not close that currentness gap. A human-readable row cannot reconstruct the lost binding after replacement.

Smallest recommended extension: pass one optional selected intent through the existing Sources read functions; use
the existing native Subject producer's current slot/support admission for one exact synopsis projection, then Content's
existing exact document admission. Return one native match bound to that same admitted assertion, not an echo of the
request. `explainSubjectSources` projects this single fact before ordinary preferred-language presentation can exclude it.
Keep ordinary fields and general navigation unchanged; render the exact fact in the existing Sources presentation.

This needs a native optional projection in the existing Subject route, with regenerated client types; a Web-only
comparison of two independent snapshots is insufficient. Reuse/factor `readSubject`'s authorization and current slot
logic, `slotView`, `supportedFacts` and target admission, and `readDocument`'s final checks. Do not resolve another
candidate through the candidate-review API or enumerate document alternatives. A narrow selected branch must avoid
the whole Subject scan/fanout where its cost is unbounded; it must not mislabel a partial Item as a complete Subject.
Exact query/result field spelling is provisional until Semantic and Content adopt the native seam; no such ABI exists.

## Request, serialization, refusals and currentness

Proposed logical request to existing BFF callables: `{id, locale, expectedReader?, selection?, returnTo?}`. A selection
contains the original tuple, not a caller-supplied fact or citations. Accept one selection only; reject unknown fields,
duplicates, malformed UUID/digest/language and inconsistent Subject/locale/Realm/Context. IDs use native UUID syntax,
digest is 64 lowercase hex characters, language uses the existing tag admission without rewriting identity spelling.
Reuse `synopsisVisit`, `summaryReadingReturn` and `subjectVisitReturn` validation; their parse success grants no access.
Keep the existing 2,048-character fragment and 2,048-byte encoded visit ceilings, charging the complete retained address.
An optional release constrains equality; absent historical release evidence is not invented. Fresh native Context must
be Global, and the original holder must remain current. No selected request silently follows the ordinary one-hop 308.

Proposed closed JSON result component: `{kind:"matched", subject, statement, property:"schema:abstract", context,
release, fact:SourceFact}` or `{kind:"unsupported"|"invalid"|"changed"|"missing"|"denied"|"unavailable"}`.
The enclosing current Sources result retains its existing shape; match failures contain no tuple, citations, labels or
candidate hints. Require exact subject/statement/property consistency between envelope and redacted fact, even if
transport data is malformed. Missing selection means ordinary reading, never a fabricated match. Do not serialize
`undefined`, commands, session credentials, draft data or additional binding fields. Use private/no-store responses.
Associate a result with the original immutable request and mounted attempt identity; comparing a response to the
latest URL alone is inadequate. A match has meaning only for those inputs and lifetime, not as a reusable credential.

Concealed native 404 maps to `missing`; a genuine 403 to `denied`; malformed input to `invalid`; known changed selection
to `changed` (the existing Sources `conflict` presentation may explain it); native 503/deadline to `unavailable`.
Do not turn absence/withholding into a diagnostic oracle. Non-Global Context or Realm yields `unsupported` before
Global fact/document resolution. Only a separately named deliberate general visit may drop Context. Optional label,
reviewed metadata or viewer-action failure stays a component failure; a failed document admission can never certify
the exact match, even if independent general facts remain readable. An empty citations list is not unavailability.

Before serialization, revalidate current Subject identity, release, security/current selection basis and original
document admission under native deadlines and session components. Content's final reference/fence checks are retained;
Semantic must add the missing selected-slot final check around that work. If either native basis changes, refuse this
attempt; do not recompute a different Global assertion. ETag `"revision"` alone omits document/fence/security changes.
Changed rank that excludes the selected assertion, retired assertion, digest/language/document replacement, merge,
hidden document or erasure cannot bind another row. A rank change that leaves the exact assertion admitted still
requires fresh native evaluation, rather than trusting the saved rank. No historical lookup restores old authority.

## Bounds derived from installed limits

| Work                   | Installed bound and proposed exact-path consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject assertions     | [RELEASE_LIMITS](../../packages/definitions/src/portable.ts): 64 properties/Type. [validate.ts](../../packages/definitions/src/validate.ts) caps 32 selections/slot, 16 qualifiers, 16 references × 16 parts. Expanded scalar `globalSlotView` shares 32 between selected/rejected; relation previews use 12 plus lookahead 13. Thus ordinary displayed capacity is `32*N+12*(P-N) <= 2,048`, not an unbounded candidate scan. Exact synopsis examines at most its 32 current slot entries and returns one row. |
| Synopsis metadata      | Existing selector admits at most 512 entries and 262,144 UTF-8 bytes including evidence metadata. Preserve both; native scalar 32 is tighter for this slot. Charge complete metadata before copying/grouping. Overbudget means unavailable, never truncate to a different choice.                                                                                                                                                                                                                               |
| Related identifiers    | Native Subject HTTP rejects more than 256 related IDs. One statement has at most `1+16+256=273` snaks; reject more than 256 unique related targets before added authority preparation/hydration. Do not treat the 256 transport helper as permission to scan or refill.                                                                                                                                                                                                                                         |
| Document metadata/body | Exactly one document identity, never 15 alternative hydrations. Native document body limit is 2,097,152 canonical UTF-8 bytes; imported source references retain their 128 limit. Prefer Content-owned metadata-only factoring of the same exact admission, not a second disclosure implementation. Reusing `readDocument` initially still charges its original bounded body reads; no document enters browser Sources.                                                                                         |
| Native calls           | One existing Subject operation per exact read; one internal Content admission and one final selected-slot validation, no per-reference native call. Definitions keep existing active-pointer/immutable-release reads (at most two on an uncached Web load). SSR plus hydrated current read is two separate attempts, at most six external native requests including definitions; exact merge refuses before following. Retry starts a new such attempt. These are request counts, not SQL statement counts.     |
| Returned rows/bytes    | Exact component: one redacted fact, at most 16 qualifiers and 16 citation groups/256 parts, at most 256 related identities. Proposed complete selected-component JSON ceiling: existing 262,144-byte synopsis metadata ceiling, measured as UTF-8 including labels/envelope; refuse before added fanout when admission cannot fit. Ordinary Sources has no installed aggregate byte ceiling; do not claim this bounds the whole page or relax an existing cap.                                                  |

`readPage` additionally enforces 16 native reads, cost 128, and at most 15 dependent documents before fanout; a synopsis
exact read must not consume those 15 to search for the second choice. It resolves the already-admitted statement ID
inside the bounded current slot even outside default language presentation; it never scans subsequent native pages.
Installed gaps matter: `slots-read-compact.sql` folds slot fact history; Subject merge support iterates originals;
`disclosedTargets` can prepare targets before the HTTP 256 check. Source-record count depends on actual proof points,
not a universal 32/128 limit. These prevent an honest whole-producer constant-cost claim from source inspection alone.
The following implementation must repair any exercised history/merge/target path within its existing authority,
or refuse exact projection before overbudget fanout without breaking ordinary disclosed support. Preserve the
[source attribution contract](../../services/kernel/src/semantic/source-record-attribution-contract.md#subject-projection-and-revocation):
metadata bounds depend on actual contributing proof points; fixed caps cannot silently discard required attribution.

Grow irrelevant same-Subject candidates, slot/revision history and source records separately at 64/512/4096 with the
selected statement/document/evidence fixed. Require fixed returned rows/bytes, constant examined rows and SQL statements,
logarithmic blocks including all native Access/Content/merge homes; measure removed rows too. History-fold growth is a
repair requirement, not a reason to weaken the fixture. Use `checkGrowth`, `capture`, `costOf`, `assertGrowthAccessPaths`
from [test/support/growth.ts](../../services/kernel/test/support/growth.ts); retain existing footprint rules/repetitions.

## Lifetime, ownership and following implementation brief

Anonymous direct visits and authenticated current reads use the same independent public admission; credentials do
not promote return intent into authority. General direct visits have no selection. Selected direct visits revalidate
from scratch. The installed route, its reader partition and `useSourcesRetry` retain control of refresh and focus.
Retire payload, reveal and pending focus on reader/session, Subject, Context/Realm, release, locale or selected-input
change, navigation and unmount. Give every attempt a fresh generation so A/B/A cannot revive A's first result;
ignore late results even if abort is ignored. Keyboard Retry preserves connected visitor focus under its current
rules; pointer Retry remains quiet. Fresh return rereads the original Subject and restores only an exact current
synopsis match; otherwise announce changed/unavailable and focus the current synopsis. Never replay retained prose.
Original uncertain commands and their immutable bytes, independent drafts and native action advice remain untouched;
no public read creates a command. Imports keeps Sources/editor integration; Web keeps mounted lifetime and navigation;
Semantic supplies exact public fact meaning; Content keeps document admission, erasure and publication.

> **Following implementation brief, after owner adoption:** Deliver one complete Global selected-synopsis Sources journey.
> Select the second same-language synopsis, inspect only its admitted support in the existing Sources page, and return
> to a fresh current reading. Include all native/projection/generated-client/installed-consumer repairs in this outcome.
> Adopt the minimal comparison result and its precise serialization in the existing Subject/Sources owner contracts;
> implement the narrow optional native projection in `subject.get`, using existing slot, support, Access, target,
> original tuple and Content document authorities. Repair currentness across document admission and final slot checks.
> Make the exercised native compact/history, merge-support and target fanout paths bounded before dependent work;
> preserve original document disclosure/erasure/growth and Sources attribution acceptance, including max-one pools.
> Regenerate the actual client route declarations and validate native and Web closed unions; never cast an invented
> response into `SubjectRead`. Wire the original selected input through `loadSubjectSources`, `readCurrentSubjectSources`,
> `readSubjectSources` and `explainSubjectSources`; expose one redacted matched row without preferred-language substitution.
> Update the actual Sources route's validated search/dependencies and mounted lifetime, then `SubjectSourcesPage`;
> reuse its renderer, Retry, focus, return and session refresh. Keep Realm/non-Global exact receiving unsupported and
> keep separately named general Sources independent. Keep the entire selected association inside its spoiler gate,
> including evidence, hrefs, labels, notices and accessible names; do not reintroduce an ungated selected link.
> Extend `apps/web/tests/catalogue-sources.test.ts`, `subject-sources-detail-family.test.tsx`,
> `subject-sources-retry.test.tsx`, `subject-summary-reading.test.tsx`, `subject-summary-reading-retry.test.tsx` and
> their existing recorded-response stories. Exercise the real mounted route, not only a model or HTML snapshot.
> Extend `apps/web/tests/native/catalogue-sources.host.test.ts` using `nativeTest`, `startAuthStack`,
> `startNativeWebStack`, `acceptCatalogueReviewCandidate` and `adoptCatalogueReviewSelection`; prepare two real
> same-language selected documents with distinct citations, and include an exact admitted empty-citation selection.
> Keep `services/kernel/test/content/document-http.test.ts`, `authored-document-http.test.ts`,
> `semantic/authored-documents.test.ts`, `growth-subject-pages.test.ts` and `growth-source-record-attribution.test.ts`
> acceptance meaningful; add the selected-projection native cases and growth axes through the existing harness.
> Use `observeSql(...).hold(...)` from `content/support/sql-observer.ts` to change adoption, candidate security,
> original fences or erasure between real native passes. Show a genuine positive reading before each revocation.
> Cover forged/malformed/duplicate inputs, another Subject/document's citation, second same-language and non-default
> language, changed rank/release, replacement digest/language, merge redirect, retired/withheld/erased assertion,
> 404/403/503 and optional component failure, metadata/count boundaries and UTF-8 expansion without raising caps.
> Cover anonymous/authenticated reads, A/B/A reader/selection/Context/release/locale, ignored abort, late settlement,
> direct visit, explicit Retry and fresh return; preserve draft and uncertain-command custody without any public write.
> Run original native document/growth, browser and source-reader lifetime acceptance after integration. Do not deliver
> a guard-only, proof-only or finish-only subset, another renderer/resolver, assertion writer or navigation framework.

## Primary-source comparison and confidence

Reused shallow clone: `.reference/catalogue-editorial-journey/wikibase`, revision
`f04124242a234a3c37f96d4be3b6ace69aebde17`, [upstream](https://github.com/wikimedia/Wikibase).
Inspected `lib/packages/wikibase/data-model-serialization/src/Serializers/StatementSerializer.php` and
`lib/packages/wikibase/data-model-services/src/Statement/StatementGuidParser.php`: serialization attaches rank,
qualifiers and references to a statement ID; parsing extracts holder identity, not current authorization.
The inspected PHP is GPL-2.0-or-later (headers; package `COPYING` and directory overrides). Design evidence only;
no upstream code is copied, installed, built or run. Its identity model supports keeping references on the exact
assertion, but supplies no REZICS Context, document rights or admission authority.

[RFC 9110 §§8.8, 13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1) describes representation validators
and conditional comparison, not application disclosure or a multi-resource binding. IETF Trust/BCP 78 applies;
no normative text is copied. Inference: this route's revision ETag cannot replace the tuple's native comparisons.
[React's official Effect guidance](https://react.dev/reference/react/useEffect#fetching-data-with-effects) explains
cleanup and ignoring obsolete asynchronous results. Inference: retain the existing route/controller and add attempt
identity there; abort alone cannot establish currentness. This is linked documentation, with no copied code or text.

Confidence is high in the inspected omission and the need for independent document admission; the proposed native
projection and final-check composition need owner adoption and measured implementation evidence. No installed callable
currently produces the combined exact match. Evidence of a safe existing combined producer, tighter native limits, or
a conflicting original-home disclosure requirement would change the seam, not justify guessing from a locator.
