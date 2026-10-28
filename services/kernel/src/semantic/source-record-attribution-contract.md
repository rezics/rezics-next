# Source record attribution

This is the owning native specification, **not an implemented producer**. The two acceptance suites use the
migrated database, mounted kernel HTTP API and real Access. Missing operations, 404 and 503 are failures, not
readiness successes. No schema, generated DTO or importer implementation is delivered by this document.

## Existing authority and missing surfaces

Current exports used by this contract are:

- `SourceSchema`, `checkBatchWrite`, `BatchCommand`, `Source` in `@rezics/definitions/bulk`;
  facts `rights` is rejected, while summary rights and media credit remain separately scoped.
- `tupleRoute` in `content/imported-contract.ts`; `batchRoute`, `batchCommand`, `statementDigest`,
  `guardBatchAuthorization` in `semantic/bulk.ts`; `bulkRoutes` in `semantic/http/bulk.ts`.
- `readSubject`, `createSubject` in `semantic/subject.ts`; `Item`, `FactRow`, `itemFacts`,
  `statementSlotId`, `relationSlotForApi` in `semantic/item.ts`.
- `resolveSlot`, `slotView`, `latestAdoption`, `currentAcceptance`, `expandSlot` in `semantic/slots.ts`;
  `candidateSources`, `fencedIds`, `withoutFencedEntries`, `sourceTuple` in `semantic/fences.ts`;
  `statementAudience`, `privateLinks`, `keepStatementPrivate` in `semantic/statement-disclosure.ts`.
- `resourceAuthorization`, `globalContextAnchor`, `runCommand`, `noEffect`, `requestDigest` and native
  `core.receipt` bookkeeping. Access uses `access/permission.ts`, not an application SQL approximation.
- Imports' `createSourceRegistration`, `Importer`, `RecordBindings` and `createImportTransport`. Registration currently
  binds a native kind to a configured alias/converter; it does **not** yet supply this general metadata.
- Web's `Subject = Read['subject']` in `apps/web/src/subject/types.ts`, `loadSubject` and `SubjectSources`.
  Composition's `readSubject` read declaration is in `packages/composition/src/registry.ts`.

The following are **MISSING**, to be implemented by the producer: `SourceRecord`, `SourceRecordMetadataCommand`,
`SourceRecordMetadataResult`, `writeSourceRecordMetadata`, `readSourceRecords` in
`semantic/source-records.ts`; `sourceRecordRoutes` in `semantic/http/source-records.ts`; its mount; native
`semantic.source_record` storage; and `Item.sourceRecords`/Subject read HTTP and generated consumer types.
These names designate future production ports, not an invitation to add successful placeholder exports.
The tests use structural types at HTTP boundaries, so their deliberate red is never a missing-module TS error.
Facts rights remain unsupported: `checkBatchWrite` returns the exact `/commands/0/rights` / `unsupported`
violation, and native bulk reports command-local 400 `invalid_request` with that pointer and no effects.
There is no adopted status change. Metadata validation and idempotency retain their specified 422 responses;
metadata conflicts retain 409. Source licence metadata is not facts rights.

## Identity and closed command

Identity is precisely `(source, external_id)`. Home is `tupleRoute(realRouteKey, source, external_id)` and its
partition is `partitionOf(home)`, independently of the current subject or any merge. Reuse the shared Source
constraints: source matches `^[a-z][a-z0-9_-]{0,31}$`, external ID has 1–255 characters; record and converter
revisions have 1–64 characters, digest is 64 lowercase hex. Tuple routing also rejects C0, DEL and C1 controls.
Preserve native validator string-length semantics and UTF-8 routing bytes, including Unicode identifiers;
do not truncate or normalize identities or substitute Content's unrelated metadata byte limits.

The one new AIP136 operation is `POST /v1/source-records:setMetadata`, operationId
`source_record.set_metadata`, `x-exposure: public`, `x-action: subject:batch_write`, bearer authentication,
write rate family with one unit. It reuses existing **trusted bulk authority on Global**. It is not a new
permission, URL ownership check, per-subject editor permission or facts-rights command.

Closed request (`additionalProperties: false` at every object):

```ts
{
  source: string;
  external_id: string;
  metadata: { name: string; url: string; licence?: { id: string; url?: string }; attribution?: string };
  expected_metadata_revision: number | null;
}
```

Use the existing quoted `Idempotency-Key` header conventions and command receipt kind
`source_record.set_metadata`. The body has no record_revision, digest, converter_revision, subject or date.
`requestDigest(kind, verifiedActor, body)` identifies the immutable body. Metadata storage is a single
`semantic.source_record` point keyed by `(route, source, external_id)`, with `metadata_revision`, `record`
(the closed metadata JSON) and `recorded_transaction_id`. The future schema owner supplies the migration.
Metadata may precede a subject claim; it never creates, rebinds or changes an external claim.

Authorize with the existing Access formula and Global anchor, using `resourceAuthorization` for the tuple
partition and native authorization-before-receipt on **every** attempt, including replay. Release the authority
connection before acquiring the tuple owner. Ungranted ordinary users and editors with only editorial grants
receive 403 forbidden; suspended accounts receive 403 account_suspended. Scope, account state, grants and all
current native operands remain mandatory. A denied attempt must neither inspect a receipt nor write metadata.
Possession of a source alias, record URL or previously successful receipt supplies no authority.

`name` is required nonblank scalar text, at most 255 characters; attribution, when supplied, is nonblank scalar
text at most 500 characters. Reject malformed Unicode (unpaired surrogates), NUL and control characters. URLs
are actual absolute HTTP(S) record/licence URLs under the existing URL datatype convention, at most 2048
characters, without credentials or controls; reject a provider home URL substituted for a known record URL in
trusted registration. Do not derive a licence from a hostname. Licence ID uses existing `isSpdxLicense`
(current SPDX IDs or valid LicenseRef, length at most 128). No nullable optional fields or extra rights fields.
The future shared schemas must express these constraints without changing SourceSchema's existing limits.

## Fill, correction, replay and rollback

`expected_metadata_revision: null` means fill missing fields only. A missing row is installed at revision 1
and returns 201. Existing equal fields are retained and previously absent optional fields can be filled;
a successful fill advances the metadata revision once and returns 200. A different value for any present field
(including licence ID/URL) returns 409 `source_record_metadata_conflict`; no implicit overwrite. Treat licence
as closed scalar leaves: filling its missing URL is allowed, changing its ID is a conflict. Omitting a present
optional leaf in fill mode retains it. An identical duplicate with a new key returns 200 noEffect and retains
revision, metadata transaction and outbox position. It may record its own native receipt.

A positive safe integer `expected_metadata_revision` selects the **same operation's correction/CAS path**:
replace the complete record only if the current metadata revision equals it. Omitted optional fields are removed
only on this explicit correction path. Missing/stale revision returns 409 `source_record_metadata_conflict`;
an identical correction at the correct revision is noEffect. A changing correction advances revision once.
A new record with a positive expected revision conflicts. Concurrent conflicting fills have one winner and one
conflict; compatible fills serialize and retain both additions. Two changing corrections against the same
revision have exactly one winner. Native uniqueness/serialization retry must reread metadata state.

Closed success body is `{record: SourceRecord, metadata_revision: positive integer,
effect: 'filled' | 'corrected' | 'noEffect'}`. An exact key/body retry returns its original status/body and native
receipt component, even after a later correction. Same key with different body returns 422
`idempotency_conflict`, without effects. Response carries the existing session component. Failed validation,
conflict, authorization, transaction or outbox/receipt fault rolls back row, revision, receipt and events together.
NoEffect must use native bookkeeping, not a fabricated revision or fake successful receipt.

Neither fill nor correction touches semantic subject revision, original subject ID/binding, source revision,
digest/converter revision, existing citations, Content rights, or the lifetime bootstrap receipt/body. Replaying
the old create command must still return exactly its old response after metadata writes and native retries.

## Producer integration obligation

Imports must add a distinct metadata effect/journal identity under the exact tuple owner. A trusted registration
snapshot explicitly provides provider display name, actual record URL and optional licence/attribution. Bangumi
CC-BY-SA-3.0 is supplied only when explicitly registered that way, including when native Bangumi is configured
under another alias. Unknown aliases cannot acquire a name or licence by spelling or URL matching.

`Importer.bootstrap` currently returns immediately for a bound claim and reuses one lifetime
`operationKey(owner, 'bootstrap')` with its original bytes. The unchanged-record shortcut occurs before conversion.
The new bounded **current-run** metadata step must execute before both shortcuts, for bound and unchanged records
as well as new ones, within the same sealed admitted run. Keep its own durable request bytes, signature and acknowledgement through actual
`RecordBindings`/`createImportTransport` dispatch. Do not mutate retired/bootstrap journals, forge a source revision or
converter bump, or enumerate the archive/backfill history. This integration is required followup owned by Imports;
the native snapshot fixture here does not simulate or claim that delivered importer wiring.

Complete acquisition, validation and seal, including mass-disappearance admission, precede **all remote effects**.
Acquisition and pure conversion emit zero metadata, bootstrap, proposals, statistics or media. Malformed,
truncated, duplicate and mass-loss input preserve the accepted baseline. Never write metadata in the acquisition
loop. After admission, each row follows trusted configured metadata → distinct tuple-home effect → actual ACK →
new lifetime bootstrap → normal proposals/statistics/media. Metadata validation, authorization, conflict or
transport failure prevents all new public material and record completion. Legacy bound material can predate a
catch-up; failure does not rewrite or relabel it. Catch-up is bounded to exact tuples and journals in this run,
never an archive or history backfill loop. After a crash following metadata ACK, retry the same metadata
receipt before the same original bootstrap bytes. After bootstrap ACK loss, preserve its lifetime key/body.
Neither upstream nor converter revision changes merely to fill attribution.

| Evidence boundary               | State and required native proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server metadata before claim    | Specified HTTP cases: actual metadata ACK with no external claim, rollback on receipt fault, exact replay before creation, bootstrap terms read, unchanged old bootstrap receipt/body after correction. Native red until the missing server ports exist.                                                                                                                                                                                                                                                                                   |
| First-party sealed admitted run | **NOT YET FROZEN**: `ImportTransport` in `services/importer/src/import-contract.ts` has no metadata effect method, `SourceRegistration` has no reviewed descriptor binding, and `RecordBindings` has no metadata effect journal/ACK binding. `createImportTransport` in `import-client.ts` exports batch/fence/statistics transport, no metadata dispatch. No importer-order test can use that missing binding yet.                                                                                                                        |
| Importer native integration     | Imports must test actual `Importer` run, `RunStore.seal`/mass-disappearance admission, `RecordBindings` journal and native transport: new success; metadata failure zero new material/completion; metadata ACK loss; bootstrap ACK loss; bound and unchanged catch-up before shortcuts; malformed/truncated/duplicate/mass-loss acquisition zero metadata/bootstrap/proposals/statistics/media and baseline unchanged. Resume/drain must respect the same barrier before dispatch. Fixture call order proves none of these run guarantees. |
| User capability and release     | No producer, generated consumer DTO or rendered Sources capability is delivered here. Manager review/freezing of these specified API cases precedes producer implementation. Passing native API and growth acceptance, actual importer binding, Web integration and main/root gate are separate evidence.                                                                                                                                                                                                                                  |

Existing insertion points are `Importer.run`'s acquisition/staging loop followed by `store.seal`, the resumed
`drain`, `plan`'s unchanged shortcut, and `bootstrap`'s bound-claim shortcut. `RecordBindings.claim`, `journal`,
`prepare` and acknowledgement currently preserve lifetime bootstrap operations, not the distinct metadata effect.
These are integration obligations, not a fabricated importer callback in the Semantic fixture.

### Reviewed descriptor scope

Use the same closed single licence/attribution DTO for every explicitly configured provider. No licence arrays,
new scope fields, SPDX expressions, alias matching or URL inference are introduced. Native acceptance writes and
reads these descriptors through the same generic operation; it does not claim registration delivery.

| Reviewed metadata | Single descriptor and limits                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VNDB              | Contents licence `LicenseRef-DbCL-1.0`, URL `http://opendatacommons.org/licenses/dbcl/1.0/`; attribution credits VNDB and also states database `ODbL-1.0` with `http://opendatacommons.org/licenses/odbl/1.0/`. Explicitly excludes images and creative descriptions and any blanket output-database licence. |
| Bangumi           | `CC-BY-SA-3.0`, `https://creativecommons.org/licenses/by-sa/3.0/`, reviewed wiki metadata only; covers, images and user writing have separate rights.                                                                                                                                                         |
| Open Library      | `CC0-1.0` bibliographic metadata only; prose rights unknown and covers/media separate.                                                                                                                                                                                                                        |
| Wikidata          | `CC0-1.0` structured data only; external references, text and images retain their own rights.                                                                                                                                                                                                                 |

The inventory evidence is `packages/definitions/sources/vndb.yaml` snapshot licence database/contents URLs and
`packages/conversion/src/vndb.ts`'s `sourceMetadata.databaseLicense`/`contentsLicense`; Bangumi's snapshot licence
is in `packages/definitions/sources/bangumi.yaml`. `open-library.ts` retains `bibliographyPermission` and separate
prose/media policy; `wikidata.ts` emits structured source metadata. Do not discard VNDB's database scope when
serializing the contents licence, or invent a source/converter revision. Omit a licence when its actual scope
cannot be expressed rather than guessing. Record URLs remain the actual source-record URLs.

## Subject projection and revocation

The placement is `GET /v1/subjects/{id}` → `subject.sourceRecords: SourceRecord[]`, so Web's existing Subject DTO
can render Sources. Empty/unknown metadata yields `[]`; omit unknown records, never invent names from aliases.
Deduplicate exact tuple identity before hydration; collapse identical final wire records. Keep deterministic
first displayed-support order. The array has every distinct original source supporting **currently disclosed, actually returned/rendered**
terms and selected statements in this response. Native references/citations remain intact.
Source records of multiple originals in a merge must survive when both actually support the rendered result.
Bulk bootstrap type/labels/descriptions/aliases with a Source envelope already disclose native metadata before
candidate adoption: their actual returned terms ARE support. A metadata row alone is not support. Unregistered
aliases without a metadata row remain unknown. An unselected/private candidate supplies no public attribution,
unless a different currently disclosed contribution genuinely uses that same tuple.

Selected `schema:name` or fact replacement does not replace bootstrap labels/aliases. When A's terms remain and
B's selected fact appears, return A+B; suppressing/retracting/hiding B's statement leaves A while A's terms remain.
When the current facts fence hides A's contribution, remove both its attribution and its sourced text. Never
omit attribution while still leaking licensed text, and never retain stale sourced terms as a successful fence.
A fence for another field group must not erase unaffected facts support.

Current native gaps are explicit: `read-subject.sql` joins term facts to their recorded transaction's revision,
but does not project `revision.source`; `asFacts` retains `fact_revision` without Source. `resolveItem` folds
label/description/alias puts/retractions independently of selected `schema:name`. `withoutFencedFacts` currently
collects only facts with a statement ID and therefore does not fence returned bootstrap terms. The producer
must retain each final returned term's exact original `(subject, fact_revision)` locator, resolve that exact
revision's Source, and apply current Content fences and original/terminal Access before hydration. It must
not fabricate a candidate ID for a term or scan all revision history. Native red freezes the missing provenance
and final term disclosure behavior; the current term leak is not blessed.

There is no general public term replacement route in `semantic/http/subjects.ts` or the bulk command union.
`updateSubjectIdentity` is an internal identity writer, outside this specification's API boundary. Actual term
replacement via HTTP is therefore NOT YET FROZEN until an owning API exists; selected-name replacement is tested
now and must keep the still-returned bootstrap terms. No new replacement API or test-only privileged writer is
invented here.

Use native compact and expanded slot rank/adoption semantics, suppression, acceptance and retraction, original
and terminal/current subject Access, audience, public consent, tuple fences and foreign target disclosure. A
private record can appear only to its authorized audience while its supporting fact is actually returned.
Proposed, unselected, withheld and retracted contributions alone reveal no metadata; independent disclosed
terms from the same tuple continue to supply their own support. Hiding one source/candidate/target,
retracting a statement removes its support; fencing a tuple must remove its affected payload and attribution with ordinary projections paused; a partial fence keeps
unrelated visible records. Metadata correction alone can never revive a fact or consent. It grants no permission.
Summary CreativeWork rights and cover/media credit remain separate; do not label either as general fact rights.

Collect provenance while resolving displayed support, retaining all selected original proof points rather than
choosing just a representative. Do not traverse a whole relation or enumerate history to discover sources.
Hydrate grouped exact `(home, source, external_id)` points after releasing the previous owner. Current proof is
request-local and never a stored reusable permission. Pool max 1 must complete, including cross-source homes.

## Cost

### Set metadata

- Touches: bounded native Access operands, one tuple metadata point and one native receipt point; native
  transaction/outbox bookkeeping only on a changed record.
- Bound: O(1) rows and statements in catalogue/history population, logarithmic index blocks; one connection at
  a time. The native Access inverse cap remains 1000, not a new metadata list budget. No source-history scan.
- Growth check: metadata fill, exact replay, duplicate noEffect, correction and denied writes with unrelated
  record/history populations 64, 512 and 4096, captured on every original instrumented pool.

### Read displayed attribution

- Touches: final returned terms, current selected support and their exact original/terminal Access, audience, target and tuple fence
  proof points, then distinct metadata tuples grouped by home. Count cross-source proof points too.
- Bound: let P be the pinned subject type's native property set, N its nonrelation slots, and E_p the selected
  proof points actually contributing to each displayed fact. Subject relation previews are 12 entries per
  property (13 is lookahead); scalar slot selection is at most 32. Thus displayed fact capacity is
  `32*N + 12*(|P|-N)`; with T final returned term proof points, attribution tuple count D is at most
  `T + sum(E_p)` for those facts, deduplicated by tuple. Term puts superseded/retracted in the native fold do not
  add support. Count all native term-fold work, exact revision lookups and fence probes, not just hydration.
  This is not a universal 32/128 source-key cap: multiple originals supporting one fact still count. Metadata
  hydration examines at most D records; with K native exact proofs it is O(D+K), with constant statements for
  fixed displayed support and logarithmic blocks. Existing 100-tuple fence batches and 256-id helpers are
  transport chunks, never a disclosure truncation rule. No whole-degree or reverse/global scan.
- Growth check: independently grow unrelated records/history and the same subject's irrelevant candidates at
  64/512/4096 while fixing returned support; capture rows including removed rows, shared blocks, statements,
  request/response bytes and backend connections across the full original pool. Run public/private/hidden,
  foreign/fenced and replay paths and a max-1 pool read. Native acceptance must first obtain genuine positive
  data, then revoke it; an absent route or 503 cannot supply a cost or disclosure pass.
