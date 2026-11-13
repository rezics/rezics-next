# Hosted append lifecycle

Decision: retain exact hosted identities and shared bases; extend existing native erasure work with bounded,
replayable payload disposition before append exposure. A changed head, withdrawal or account tombstone alone
does not authorize deleting a stream. This is a receiving contract, not implemented cleanup or route approval.
Specification-only acceptance is written below; no runnable tests or runtime changes are added in this slice.

After the overlapping release writer lands, insert a link to this note in
[hosted-chapters.md](hosted-chapters.md#receiving-exposure-and-verification)'s lifecycle exposure prerequisite.
Keep lifecycle detail here; release selection and exposure remain owned there.

## Sources and current evidence

Read before design: the exposure/representation sections of `hosted-chapters.md`; `README.md`'s hosted profile
and account-erasure inventory; `db/content/migrations/20261111120000_hosted_chapters.sql` and
`20261113025800_hosted_root_append.sql`; `erased-post-cleanup.ts`, `account-erasure-authored.ts` and their SQL;
`work.ts`'s erased-Post workflow; `commands.ts`'s `hostedPostAuthorization`; `reads.ts`'s retained Post metadata;
`hosted-chapters-{reads,disclosure}.ts`; and `test/content/{hosted-root-append,hosted-append-read,
account-erasure-authored,erased-post-cleanup-work}.test.ts` with `support/hosted-chapters-fixture.ts`.
These paths are relative to Kernel, with source basenames relative to `src/content`. The main checkout's
read-only `.reference/INDEX.md` was consulted; no external source implementation is needed for this local extension.

The supplied base already includes the append storage revision `a675131f08` and mixed readers; no cherry-pick
is needed. Descriptors bind a sealed legacy base and inclusive prefix; publication reads use separate manifests.
Neither native erasure path visits append tables. `guard_hosted_snapshot` rejects every UPDATE/DELETE on
placements, occurrences, revisions, descriptors and prefix rows. Indexes and foreign keys are retention
affordances, not a payload-purge implementation. Existing tests prove selected read/authority behavior and
Post cleanup, not hosted payload removal or bounded lifecycle execution.

## Three native traces

| Operand                                        | Immediate authority and disclosure                                                                                                                                                                                                                                                                                                                                                                            | Deferred physical disposition                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Erased catalogue anchor `f.catalogueId`        | `hosted-chapters-reads.ts` requires available native anchor metadata before placements and closes that retained observation before response. `hostedPostAuthorization` checks original authorship, container admission and `post:revise`, then rejects erased chains in authorize/finalize. Neither an old link nor an append receipt restores authority.                                                     | `work.ts` consumes `content.post.erased.v1` into `content.erasePostRevisions`; `start-post-purge.sql` requires the committed erased Post and permanent erasure or expired 30-day soft tombstone (account erasure bypasses the delay). `null-erased-revisions.sql` clears at most 100 revisions per action; `page-erasure-media.sql` selects only actually claimed media for object purge. Hosted rows currently remain.                     |
| Erased chapter target `concealed.firstPost.id` | `prepareHostedTargetMetadata` requires the exact thread/Post/revision/digest and retained author/licence observation. Native erased metadata returns null. Pages retain only occurrence/parent/position/kind, advance the raw cursor, and withhold title, target, digest and attribution; exact opening supplies no document. Initial or final loss has the same result.                                      | Target Post revision bodies/digests/search text and owned media follow their own erasure job. No reverse scan of every hosted catalogue is needed for disclosure. Target erasure alone grants no authority to delete another author's occurrence, label or immutable manifest.                                                                                                                                                              |
| Account erasure of published, available anchor | `account-erasure-authored.ts` proves the account-home obligation, then `account-erasure-authored-mark.sql` records `author_erased`. `account-erasure-authored-item.sql` keeps the Post and its current body revision, clearing only non-head revisions. Current account admission revokes the author's commands/private structures; public releases still require current anchor and exact target disclosure. | The account participant pages at most 50 author-item keys and 100 older revisions per step, with receipts across homes. A retained published Post emits mechanical moderation cleanup, not a Post-erased event. Thus adding work only to `content.erasePostRevisions` would miss its private hosted outline. Published target old revisions cleared by account erasure become unavailable, never silently substituted with a head revision. |

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

Current NOT NULL/title checks and blanket immutable triggers provide no private-title redaction seam. A future
implementation must provide narrowly authorized payload redaction without changing IDs, addresses, target
bindings, prefix membership or published manifests. Do not claim payload completion from withholding alone.
Until that seam and the lifetime proof below exist, retain hosted rows and leave append exposure pending.

## Smallest existing-work continuation

Extend `erased-post-cleanup.ts`/`work.ts` after native purge eligibility, and the retained-published disposition
in `account-erasure-authored.ts` before its author-item deletion acknowledges completion. Reuse existing durable
steps/command receipts, partition deadlines and account late-item disposition; no watcher, scheduler or new engine.
Account work must persist the hosted obligation before dropping the locator, including late-item processing.
Keep revision and hosted page budgets separate: at most 100 hosted candidates per durable action, releasing the
connection between actions. Replay freezes the page and resulting frontier; exceptions leave completion pending.
Do not mark hosted completion via the existing Post-only `purge_completed` flag.

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

Keep existing assertions unchanged. Add the missing native cases to a future
`test/content/hosted-append-lifecycle.test.ts`, reusing `hostedChaptersFixture`, its `f.target(source)`,
`f.newOccurrenceId()`, `f.native.command`, native worker setup from `erased-post-cleanup-work.test.ts`, and
account-obligation setup from `account-erasure-authored.test.ts`. These are test specifications, not passing tests:

1. Reuse `hosted-append-read.test.ts`'s `base`, `first`, `pinned`, `release`, `appended[0]`/`concealed` operands.
   Erase the target between initial/final disclosure: raw slot/cursor survive, sensitive fields/document do not;
   repeat after physical target purge. Erase `f.catalogueId`: old draft/release reads and exact receipt replay
   cannot restore disclosure/mutation, while target identity and hosted identity rows remain.
2. Build B, append D1/D2, replace with C as in `hosted-root-append.test.ts`; run/replay lifecycle work. While
   native authority remains live, old D1/D2 resolve their original prefix and the old `release` stays byte-exact.
   An ineligible/young soft tombstone does no purge; eligible terminal work purges private titles only through
   the future authorized seam, preserves identities and leaves unrelated catalogues/targets unchanged.
3. Give the published `published.firstPost` account-erasure fixture a base, two appends and a frozen release.
   Erase its author: current Post body and permitted release labels remain; old Post bodies and private outline
   titles are physically cleared, commands/private reads fail, and released old target revisions become
   unavailable if independently purged. Include replay and a late authored-item disposition before acknowledgement.
4. With 101 prefix rows and multiple descriptors sharing B, crash after the first committed page, then resume
   and duplicate delivery. Assert every candidate is processed once logically, each action selects at most 100,
   offset 100 is reached, no descriptor-per-prefix rescan occurs, and completion follows final range exhaustion.
   Add unrelated catalogues/streams and retain the same indexed key bounds; actual query-plan/growth proof is
   deferred, not established by these fixtures.

No mounted API/browser verification is implied. Kernel native acceptance runs after implementation lands in the
dev verifier; this specification changes no workspace types or existing test behavior.
