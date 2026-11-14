# Hosted append lifecycle

Decision: retain exact hosted identities and shared bases; extend existing native erasure work with bounded,
replayable payload disposition before append exposure. A changed head, withdrawal or account tombstone alone
does not authorize deleting a stream. The bounded persistence/page seam and both native workflow receivers are
implemented; append exposure remains separate.
Release selection and exposure remain owned by
[hosted-chapters.md](hosted-chapters.md#receiving-exposure-and-verification).

Decision: private titles use explicit `(title = NULL, title_redacted = true)` tombstones, authorized only by the
native irreversible `purge_started_at` fence or retained-published `author_erased` authority; exact 100-row
revision, placement and self-base stream pages use catalogue-home command receipts for replay.

Decision: native Post purge drains hosted pages after its irreversible eligibility marker; account erasure drains
them after each Post's old-body disposition and before locator acknowledgement. Stable exact-anchor page receipts
resume each range, and completion remains independent of Post-only `purge_completed`.

## Sources and current evidence

Read before design: the exposure/representation sections of `hosted-chapters.md`; `README.md`'s hosted profile
and account-erasure inventory; `db/content/migrations/20261111120000_hosted_chapters.sql` and
`20261113025800_hosted_root_append.sql`; `erased-post-cleanup.ts`, `account-erasure-authored.ts` and their SQL;
`work.ts`'s erased-Post workflow; `commands.ts`'s `hostedPostAuthorization`; `reads.ts`'s retained Post metadata;
`hosted-chapters-{reads,disclosure}.ts`; and `test/content/{hosted-root-append,hosted-append-read,
account-erasure-authored,erased-post-cleanup-work}.test.ts` with `support/hosted-chapters-fixture.ts`.
These paths are relative to Kernel, with source basenames relative to `src/content`. The main checkout's
read-only `.reference/INDEX.md` was consulted; no external source implementation is needed for this local extension.

The adopted producer history adds the redaction migration, generated schema, lifecycle page receiver and the
`hosted-chapters-store.ts` tombstone rejection while retaining the append storage revision `a675131f08` and mixed
readers. Descriptors bind a sealed legacy base and inclusive prefix; publication reads use separate manifests.
`erased-post-cleanup.ts` and `account-erasure-authored.ts` now invoke hosted disposition under the existing native
eligibility fences. `guard_hosted_snapshot` still rejects updates/deletes to occurrences, revisions and descriptors;
only the two payload tables use the narrow title guard below.

## Three native traces

| Operand                                        | Immediate authority and disclosure                                                                                                                                                                                                                                                                                                                                                                            | Deferred physical disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Erased catalogue anchor `f.catalogueId`        | `hosted-chapters-reads.ts` requires available native anchor metadata before placements and closes that retained observation before response. `hostedPostAuthorization` checks original authorship, container admission and `post:revise`, then rejects erased chains in authorize/finalize. Neither an old link nor an append receipt restores authority.                                                     | `work.ts` consumes `content.post.erased.v1` into `content.erasePostRevisions`; `start-post-purge.sql` requires the committed erased Post and permanent erasure or expired 30-day soft tombstone (account erasure bypasses the delay). `null-erased-revisions.sql` clears at most 100 revisions per action; `page-erasure-media.sql` selects only actually claimed media for object purge. The native receiver clears hosted private titles after the retained eligibility marker and before Post completion. |
| Erased chapter target `concealed.firstPost.id` | `prepareHostedTargetMetadata` requires the exact thread/Post/revision/digest and retained author/licence observation. Native erased metadata returns null. Pages retain only occurrence/parent/position/kind, advance the raw cursor, and withhold title, target, digest and attribution; exact opening supplies no document. Initial or final loss has the same result.                                      | Target Post revision bodies/digests/search text and owned media follow their own erasure job. No reverse scan of every hosted catalogue is needed for disclosure. Target erasure alone grants no authority to delete another author's occurrence, label or immutable manifest.                                                                                                                                                                                                                               |
| Account erasure of published, available anchor | `account-erasure-authored.ts` proves the account-home obligation, then `account-erasure-authored-mark.sql` records `author_erased`. `account-erasure-authored-item.sql` keeps the Post and its current body revision, clearing only non-head revisions. Current account admission revokes the author's commands/private structures; public releases still require current anchor and exact target disclosure. | The account participant pages at most 50 author-item keys and 100 older revisions per step, with receipts across homes. A retained published Post emits mechanical moderation cleanup, not a Post-erased event. Thus adding work only to `content.erasePostRevisions` would miss its private hosted outline. Published target old revisions cleared by account erasure become unavailable, never silently substituted with a head revision.                                                                  |

## Retention and purge boundary

Permanently retain catalogue/revision/occurrence identities, occurrence kind and original target Post binding,
source-revision references and exact release membership/order. Keep retained receipts unchanged. Retain descriptor base/count/watermark
and stream offsets needed to interpret those identities. Removal from a new draft cannot recycle an occurrence.
Native Post purge clears `revision.body`, `body_sha256`, `search_text` and owned media objects while keeping
revision IDs, licences and reference skeletons; it does not delete the independently saved target Post identity.

Hosted tables contain no body copies. Titles are authored payload, not identity. For an eligible erased anchor,
its private outline titles require purge; account erasure also requires disposition of private structure titles
beside a retained published anchor. Published manifests retain their permitted labels and exact revision/digest
bindings under current disclosure, including explicitly addressed historical releases. Target erasure withholds
those bindings; it does not authorize rewriting old manifests. Hosted digests are retained exact-selection
bindings, not a promise that native revision bytes survive. No title/digest is disclosed for an unavailable target.

## Implemented private-title pages

`20261113035450_hosted_private_title_redaction.sql` retains every identity, exact target binding, source header,
placement coordinate, descriptor count and watermark. Both payload tables have a nullable title and a checked
`title_redacted` flag. Inserts require an ordinary non-null title. Updates permit only the one-way transition
from an existing private title to the explicit null tombstone; all other columns must remain byte-equivalent.
Deletes, restoration, retargeting, count/watermark edits and any publication-label update remain forbidden.
Rollback refuses retained tombstones rather than inventing a title. `hostedPlacement` rejects a null tombstone
instead of constructing an admitted editable placement, available part or publication label.

The trigger requires the exact catalogue anchor and a structure revision. It locks the native Post and accepts
only erased availability with non-null `purge_started_at`, or an available published Post with `author_erased`.
Native purge start already checks permanent/expired-soft/account-erasure eligibility and becomes irreversible;
the hosted seam neither sets that fence nor accepts an erasure-bypass flag. A young reversible soft tombstone,
a live exact draft, replacement, withdrawal, target erasure or an author ID alone supplies no authority.

`hosted-append-lifecycle.ts` exposes three internal functions: `pageHostedLifecycleRevisions`,
`redactHostedLifecyclePlacements` and `redactHostedLifecycleStream`. Each runs one catalogue-home command with
the existing partition epoch/deadline/retry rules. Admission locks the exact catalogue/native anchor and checks
its original author before receipt lookup, including replay. Receipts bind author, catalogue, operation and exact
cursor; they freeze returned candidates and the next frontier atomically with redaction. Changed payload pages
emit the existing mechanical moderation-erasure event without titles or targets. Read-only and duplicate ranges
use no-effect commands and retain receipts. Each invocation releases its connection before the next action.

Revision inventory includes at most 100 legacy, append and publication headers, ordered by UUID primary key.
It returns immutable descriptors and captures a stream's terminal offset only on its self-base descriptor with
one descending primary-key seek. Only those entries start stream work. The receivers persist each returned page
and continuation through stable native command receipts, then carry the revision and active per-revision/stream
cursor until exhaustion. They process private placements with an occurrence-ID keyset and each self-base stream
once with an offset keyset bounded by that captured high water.
All offsets/counts cross JSON and PostgreSQL as decimal text. Publications select no private payload candidates.
Already redacted candidates still advance the same frontier under a new receipt key; the original key replays
the original result, including changed flags. A full 100-row page returns its last raw key as continuation and
requires a later range to prove exhaustion. No sentinel, OFFSET, count, dependent-prefix rescan or author census
is needed. These are internal typed operands; native receivers persist and reuse the captured bound.

Workflow completion is the exhaustion of all returned revision, placement and stream ranges; native Post-only
`purge_completed` remains independent. Account item and late-item locators stay present until those ranges finish.
Append exposure remains pending.

## Workflow integration and completion

`erased-post-cleanup.ts` begins hosted reception only after the retained purge marker proves native eligibility;
it can resume a previously started purge even when Post completion already exists. `account-erasure-authored.ts`
finishes each Post's hosted ranges after its existing item transaction and before deleting that item's locator,
including late-item replay. Each producer page has its own catalogue partition receipt and deadline, handles at
most 100 hosted candidates, and releases its connection before the next page. Post-revision and author-item
budgets remain separate. Neither receiver marks hosted completion through Post-only `purge_completed`.

An erased anchor locates one catalogue by `(route,catalogue_id=postId)`; there is no Post/author catalogue census.
Use these indexed keysets, each with fixed leading route/catalogue and `LIMIT 100`, never OFFSET or counts:

| Purpose                                       | Key and continuation                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Retained revision/descriptor inventory        | `hosted_structure_revision` and `hosted_append_descriptor` primary keys; `revision_id > afterRevision`. Include legacy/publication headers, not descriptors alone. |
| Legacy/private payload page                   | `hosted_placement` primary key; fixed revision, `occurrence_id > afterOccurrence`. Publication manifests are classified and retained.                              |
| One sealed base's dependents                  | `hosted_append_descriptor_base_idx`; fixed `base_revision_id`, `revision_id > afterDependent`.                                                                     |
| One stream's prefix payload                   | `hosted_append` primary key; fixed `stream_id`, `append_offset > afterOffset AND append_offset <= capturedHighWater`. Preserve bigint/text offsets.                |
| Exact occurrence's stream bindings, if needed | `hosted_append_occurrence_idx`; fixed `occurrence_id`, `stream_id > afterStream`. This is not a target-Post reverse index.                                         |

Capture stream bounds under native lifecycle authority: only a self-base descriptor starts its stream page;
seek that stream's primary key descending with `LIMIT 1` to freeze its last offset, without aggregating dependent
descriptors. Process each base stream once, rather than revisiting its prefix for every descriptor.
A durable revision frontier plus active stream/offset frontier can
resume after a crash. Author/container authority must prevent new writes during terminal disposition; ordinary
draft edits or replacement supply no such proof. Account workflow replay and late-item completion must include
these hosted frontiers, without exceeding the existing author-item/revision budgets.

Shared-base proof: descriptors `D1=(B,0)` and `D2=(B,1)` both need B's placements and prefix offset 0; replacing
the current head with C does not retire either exact draft. The self-referencing descriptor FK protects B's
descriptor, but not B's placement payload or a prefix used only through `high_water`. Neither a newer head nor
absence from the current release proves those rows dead. All retained exact drafts count, not just current heads.
Publication manifests independently copy selected placements and retain a source-revision FK; prove both the
header reference and unchanged manifest resolution. No row deletion is authorized by this contract. Any future
reclamation must prove every retained descriptor/reference no longer needs the affected rows, serialize against
new references in the catalogue home and preserve permanent identities; lacking that proof, retain the base.

## Acceptance for implementation

`test/content/hosted-append-lifecycle.test.ts` exercises the real Post purge receiver with a 101-row shared-base
stream, a frozen release, a young tombstone, an injected crash after the first committed stream page, resume and
duplicate delivery. It pins one traversal of the shared stream, bounded offsets, private-title disposition,
preserved identities/release rows, and an unrelated hosted catalogue plus a non-hosted Post.
`test/content/account-erasure-authored-hosted.test.ts` exercises the real account participant with a retained
published Post, preserved current body and release labels, cleared old bodies/private titles, locator ordering and
late-item replay. The producer fixture continues to pin the page contract and exact authorization.

Contract-named sources read before implementation: `hosted-append-lifecycle.md`, `hosted-append-lifecycle.ts`,
`erased-post-cleanup.ts`, `work.ts`, `account-erasure-authored.ts`, its mark/item/delete SQL, the hosted store,
`hosted-chapters.md`, both hosted migrations and `db/content/schema.sql`; the erased-Post and account-authored
fixtures with hosted fixture support; and the read-only main `.reference/INDEX.md`. The adopted producer commit
contains the bounded page receiver and history. No external implementation was used.

The dev verifier runs the focused fixtures after landing. Native/default-worker receiving, query-plan/growth,
installed/promoted revision qualification and mounted HTTP/browser checks remain deferred. Source formatting,
scoped lint and the affected Kernel typecheck are this attempt's checks; the focused tests are not run here.

## Cancelled sealed Book candidate reclamation

Decision: cancelled sealed whole and explicit-selection Book candidates become reclaimable at their original
expiry deadline through the existing indexed retention drain. Cancellation remains `cancelled`; only a live
sealed source reaching expiry transitions to `expired`. The durable candidate claim records the source's actual
terminal status, and step receipts read that retained status alongside their original frontier and row count.
Existing expired claims and receipts are unchanged. Downgrade refuses cancelled claim evidence rather than
rewriting or deleting outcomes.

The stage lock precedes the claim, candidate and generation locks. Both terminal states require the same exact
source seal, owner epoch, expected revisions, frozen selection input and generation head/snapshot binding.
Retained revisions, current public/draft pointers, other candidate checkpoints, activation/baseline checkpoints
and active ordered receiving holds still prevent the claim. Generation retirement fences new descriptors and
writes before any deletion. Previously activated or otherwise referenced generations remain retained.

Pending insertion and bounded legacy adoption already include cancelled stages; neither filters by terminal
state. The existing due index seeks `(available_at, route, catalogue_id, stage_id)` and also requires the stage's
expiry deadline. A deferred cancelled source resumes on its existing retry time. Each segment still scans at most
100 due keys, adopts at most 100 old keys and advances one cleanup step of at most 100 rows; the hourly sweep
still stops after 16 segments. No stage census, new sweep or scheduling change is needed. Cleanup retains source
seals, staging inputs and observations, build pages, command receipts and public selection.

Sources read for this extension: `hosted-version-candidate-cleanup.ts`, its pin query, `hosted-publication-retention.ts`
and due/adoption SQL; `hosted-publication-staging.ts`'s cancellation/expiry fence; the staging, candidate-cleanup,
selection-retention and retention-drain migrations; `hosted-chapters.md`'s activation and retention contracts;
`test/content/hosted-{publication-retention,version-candidate-cleanup}.test.ts`; and the read-only main
`.reference/INDEX.md`. This extends the existing native mechanism without external implementation code.
