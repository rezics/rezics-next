# Library archive entry and private-label recovery

`/library/recover-archive` is the Library navigation destination for a person's completed REZICS Library export.
It is separate from [private export](private-export/contract.ts) and provider-list import visits. The native owner is
[Library archive review and merge](../../../../docs/library-archive-merge.md); the installed file format is owned by
[Library export](../../../../docs/library-export.md). This guide owns the Web visit.

## Current admission

Decision: keep production file selection disabled until generated merge methods and exact review-version confirmation
are both available; the transport-neutral visit seam never claims artifact admission or native results. Explain scope
and keep the person's completed file on their device.

The server mounts `libraryArchiveMergeRoutes` and includes it in its source composition. However, the installed
`packages/client/src/kernel/http/kernel.d.ts` omits that composition member and there is no generated archive merge
route declaration. `KernelClient` therefore does not expose `libraryArchiveMerges`. Eden's runtime proxy is not a
capability probe: arbitrary property access can manufacture methods. Web must not cast that proxy to a handwritten
interface or treat the decoder as an HTTP method.

There is a second native continuation. `PATCH /:id/review` returns only `{ordinal,status}`; preview returns the saved
review without `review_revision`. `POST /:id/apply` accepts only `{ordinals}`. Although the native journal binds a
command to the stored review revision and current entry incarnation/revision, another review can replace that
stored decision between Web confirmation and apply. Web cannot express which reviewed effects the person confirmed.
Commerce must deliver an immutable review identity or expected review revision in preview/review and selected apply,
reject replaced selections, and preserve the original binding during uncertain replay. Regenerating the client alone
does not close this gap. This continuation has been sent to Commerce.

The current page accepts no file, holds no private preview and issues no archive request. Its route requires sign-in,
prepares existing exposure, marks responses `private, no-store`, uses noindex metadata and caches no private loader
data. Scope text is prospective and explicitly says no file has been admitted: it is not a fabricated inventory or
successful empty capture. There are no local upload endpoints, alternate native commands or restoration receipts.

## Native bounds for the continuation

The values below come from `LIBRARY_ARCHIVE_MERGE_LIMITS`, its decoder limits and the installed export format,
not an illustrative Web fixture.

| Operand                                                    | Installed bound                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Raw upload U                                               | 34 MiB (35,651,584 bytes)                                                 |
| Decoder depth                                              | 32                                                                        |
| Archive records                                            | 100,000                                                                   |
| Encoded archive records                                    | 32 MiB (33,554,432 bytes)                                                 |
| Producer page / maximum encoded record admitted by decoder | 120,000 bytes                                                             |
| Preview or result page P                                   | 100 records; native default 50                                            |
| Selected review / apply                                    | 20 items each                                                             |
| Evidence cleanup                                           | 100 child rows per explicit command                                       |
| Native evidence retention                                  | Seven days from upload                                                    |
| Export capture lifetime                                    | Fifteen minutes; an expired completed capture remains historical evidence |

The decoder validates the final manifest, fourteen declared sections, overall `rows` and compact `recordBytes`.
Version 1 has no declared per-section counts. Native coverage computes `present`/`empty` counts and distinguishes
`requires-explicit-mapping` from `retained-unsupported`. The Web continuation must show actual native inventory,
overall totals and omissions, explaining computed counts separately from manifest declarations.

The archive limit does not establish a delivered maximum response-byte constant B. Preview can include evidence
and review objects in addition to record bytes; generated response types and an array cap alone do not prove B.
Derive the composed response bound with Commerce/Performance before claiming O(P+B) observed cost. Current admission
holds no upload/page/selection/result state and performs zero archive reads or effects, independent of archive size.

## Remaining visit

Decision: prepare transport-neutral bounded visit custody while keeping raw upload unavailable until generated
merge DTOs and immutable native review confirmation are delivered.

`archive-entry-recovery/selection.ts` owns at most twenty deliberate entry, label or assignment choices;
unsupported sections cannot enter that selection. `archive-entry-recovery/visit.ts` owns one upload identity,
one projected page of at most one hundred rows, that selection, one confirmed operand and one result page.
It copies and freezes JSON values, replaces pages, invalidates review on choice changes, preserves exact original
uncertain operands and keeps acknowledged receipts during cancellation. Stale admission retains choices as context
and requires a fresh review. Viewer, credential/CSRF epoch, source, route, replacement and deadline retire private
callbacks. The mounted adapter must provide the current binding reader and retire the visit on unmount and session
events; no private state is connected to the unavailable page yet.

These modules define local custody rather than a handwritten HTTP client or a native review-version schema.
The generated adapter must project bounded native pages without duplicating their rows in page context, carry the
native exact review identity and original request credentials/keys, and enforce native admission and receipts.
Local state tests do not establish artifact admission, native effects, response-byte bounds or mounted completion.

After the native continuation, use only generated methods for raw upload, owner status, indexed preview/results,
selected review/apply, cancel and expired-evidence pruning. Keep one upload, one current page, one bounded selection
and one current result page in visit memory. No archive JSON decoder, full-page walk, per-row hydration, automatic
refill or whole-job polling belongs in Web. First/deep/terminal page changes replace the current page.

Entries, private labels and assignments require explicit choices. Archived state/label evidence stays separate from
the current Subject, state and label identity. Equal label names never imply a mapping. Only the native validated
create-label operation may create a label. Show unresolved identity, unavailable old vocabulary, local conflict,
already equal, explicit create and preserved local edit distinctly. Preserve current work by default and never
remove unrelated labels. Confirm exactly the selected, freshly admitted review operands; stale review retains
private choices as context but requires new admission. Do not apply a replacement review silently.

Sessions, units, history, holdings, Collections, pins, occurrences and provider evidence remain unsupported here.
Ratings, financial data and other omitted sources gain neither a fabricated count nor a restoration claim. Recovery
does not publish notes, complete progress, replace all entries or install archived revisions, timestamps or pins.

Bind visit memory and every late callback to the current viewer, CSRF session/credential epoch, source, route, upload
identity and native retention deadline. Retirement drops private reads; another account cannot resume them. Keep file
contents, previews, choices and receipts out of URLs, persistent browser storage, shared query caches, errors and
public metadata. Reopening requires an actually delivered owner read. Historical evidence never grants current
account permission.

An uncertain effect retains the original sender, credential, key and body for explicit retry. Native per-item
receipts distinguish partial success from unresolved effects; selected retries must not manufacture replacement
commands. Cancellation stops unstarted effects. Evidence deletion does not undo acknowledged Library changes.
Link only admitted successful canonical Subjects or the current Library.

## Presentation and verification

The unavailable upload state has eight localized versions, a visible current step, a disabled native file control,
scope and privacy explanations, and wrapping 44px Library/export destinations. The existing Storybook route harness
connects this state without a second publisher or native success fixture. Review, conflict and partial-result stories
belong to the remaining delivered journey, not simulated availability.

Focused tests pin discoverability, localized scope and unavailable upload admission. They do not establish native
execution or completion of recovery. The continuation needs an actual final producer artifact, malformed/incomplete
and unsupported format refusals, state/label mapping, conflict preservation, changed revision/incarnation refusal,
partial receipts, original replay, cancellation and mounted source/session retirement. Exercise supplied pages at
1/50/100 rows while independently varying unrelated archive rows at 64/512/4096; navigation, review, apply, retry
and cancel must not add account-size reads. Controller acceptance and Storybook/browser inspection remain deferred.

References read for this visit: the native owner and export format above; the portability criterion in
[API-first platform coverage](../../../../docs/research/api-first-platform-coverage.md#gaps-ranked-for-vndb-and-bangumi-users);
`legacy-final:apps/web/features/library/library-import.tsx` and `library-import-rows.tsx` (upload, deliberate row
resolution, conflict choices and result recovery, with all-row loading to replace); and the older app's
`apps/web/features/progress/components/progress-import-dialog.tsx` (token-help navigation, not history import).
