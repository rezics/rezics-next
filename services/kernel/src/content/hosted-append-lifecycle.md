# Hosted append lifecycle

Decision: retain exact hosted identities and shared bases; extend existing native erasure work with bounded,
replayable payload disposition before append exposure. A changed head, withdrawal or account tombstone alone
does not authorize deleting a stream. The bounded persistence/page seam is implemented; native workflow invocation and append exposure remain separate.
Release selection and exposure remain owned by
[hosted-chapters.md](hosted-chapters.md#receiving-exposure-and-verification).

Decision: private titles use explicit `(title = NULL, title_redacted = true)` tombstones, authorized only by the
native irreversible `purge_started_at` fence or retained-published `author_erased` authority; exact 100-row
revision, placement and self-base stream pages use catalogue-home command receipts for replay.

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
Neither native workflow invokes hosted disposition yet. `guard_hosted_snapshot` still rejects every UPDATE/DELETE
on occurrences, revisions and descriptors. The two payload tables now use the narrow guard below; indexes and
foreign keys alone remain retention affordances. Existing selected read/authority and Post cleanup tests keep
their assertions; the added lifecycle fixture covers this internal seam.

## Three native traces

| Operand                                        | Immediate authority and disclosure                                                                                                                                                                                                                                                                                                                                                                            | Deferred physical disposition                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Erased catalogue anchor `f.catalogueId`        | `hosted-chapters-reads.ts` requires available native anchor metadata before placements and closes that retained observation before response. `hostedPostAuthorization` checks original authorship, container admission and `post:revise`, then rejects erased chains in authorize/finalize. Neither an old link nor an append receipt restores authority.                                                     | `work.ts` consumes `content.post.erased.v1` into `content.erasePostRevisions`; `start-post-purge.sql` requires the committed erased Post and permanent erasure or expired 30-day soft tombstone (account erasure bypasses the delay). `null-erased-revisions.sql` clears at most 100 revisions per action; `page-erasure-media.sql` selects only actually claimed media for object purge. Hosted rows remain until the native workflow receives the hosted page seam below. |
| Erased chapter target `concealed.firstPost.id` | `prepareHostedTargetMetadata` requires the exact thread/Post/revision/digest and retained author/licence observation. Native erased metadata returns null. Pages retain only occurrence/parent/position/kind, advance the raw cursor, and withhold title, target, digest and attribution; exact opening supplies no document. Initial or final loss has the same result.                                      | Target Post revision bodies/digests/search text and owned media follow their own erasure job. No reverse scan of every hosted catalogue is needed for disclosure. Target erasure alone grants no authority to delete another author's occurrence, label or immutable manifest.                                                                                                                                                                                              |
| Account erasure of published, available anchor | `account-erasure-authored.ts` proves the account-home obligation, then `account-erasure-authored-mark.sql` records `author_erased`. `account-erasure-authored-item.sql` keeps the Post and its current body revision, clearing only non-head revisions. Current account admission revokes the author's commands/private structures; public releases still require current anchor and exact target disclosure. | The account participant pages at most 50 author-item keys and 100 older revisions per step, with receipts across homes. A retained published Post emits mechanical moderation cleanup, not a Post-erased event. Thus adding work only to `content.erasePostRevisions` would miss its private hosted outline. Published target old revisions cleared by account erasure become unavailable, never silently substituted with a head revision.                                 |

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
one descending primary-key seek. Only those entries start stream work. The receiver persists the returned
revision page, its next frontier and the active per-revision/stream cursor. It processes private placements with
an occurrence-ID keyset and each self-base stream once with an offset keyset bounded by that captured high water.
All offsets/counts cross JSON and PostgreSQL as decimal text. Publications select no private payload candidates.
Already redacted candidates still advance the same frontier under a new receipt key; the original key replays
the original result, including changed flags. A full 100-row page returns its last raw key as continuation and
requires a later range to prove exhaustion. No sentinel, OFFSET, count, dependent-prefix rescan or author census
is needed. These are internal typed operands; native receivers persist and reuse the captured bound.

The seam does not claim workflow completion: native Post-only `purge_completed` remains independent, and the
account participant must persist hosted progress before dropping an authored locator or acknowledging a late item.
Until those receivers and the lifetime/growth proof below land, append exposure stays pending.

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

Keep existing assertions unchanged. The remaining composed native acceptance extends
`test/content/hosted-append-lifecycle.test.ts`, reusing `hostedChaptersFixture`, its `f.target(source)`,
`f.newOccurrenceId()`, `f.native.command`, native worker setup from `erased-post-cleanup-work.test.ts`, and
account-obligation setup from `account-erasure-authored.test.ts`. The added source fixture pins live/replaced shared-base refusal, young soft-tombstone refusal, matured native
eligibility, exact-author refusal, terminal-only private redaction, immutable identities/bindings/descriptors,
preserved historical release rows, tombstone read rejection and erased-anchor read/receipt refusal. It also
pins retained-published account authority, current/old body disposition, 101 prefix candidates, 100-row revision
inventory, receipt and duplicate-range replay, bound rebinding refusal, offset 100, exhaustion and an independent
late item's disposition between saved stream pages. It installs account-local authority with the existing native
participant SQL after Auth deletion, without invoking a new workflow or acknowledging hosted completion.

Contract-named sources read before implementation: this note; hosted representation/exposure and Content README
profile/account-erasure inventory; both hosted migrations; native purge and account-authored implementation/SQL;
work.ts erasure registration; hostedPostAuthorization; retained Post/hosted disclosure readers; append/read,
account-authored and erased-post-work fixtures and hosted fixture support; the read-only main `.reference/INDEX.md`.
No external implementation was used.

Changed-file formatting and one affected Kernel typecheck are the source checks. The new fixture and ordinary
native acceptance run after landing in the dev verifier; native workflow integration, growth/query plans,
mounted HTTP and browser verification are deferred and unverified. The following composed cases still belong
to the native receiving owner, rather than claiming this seam installs its workflows:

1. Reuse `hosted-append-read.test.ts`'s `base`, `first`, `pinned`, `release`, `appended[0]`/`concealed` operands.
   Erase the target between initial/final disclosure: raw slot/cursor survive, sensitive fields/document do not;
   repeat after physical target purge. Erase `f.catalogueId`: old draft/release reads and exact receipt replay
   cannot restore disclosure/mutation, while target identity and hosted identity rows remain.
2. Build B, append D1/D2, replace with C as in `hosted-root-append.test.ts`; run/replay lifecycle work. While
   native authority remains live, old D1/D2 resolve their original prefix and the old `release` stays byte-exact.
   An ineligible/young soft tombstone does no purge; eligible terminal work purges private titles only through
   the authorized seam, preserves identities and leaves unrelated catalogues/targets unchanged.
3. Give the published `published.firstPost` account-erasure fixture a base, two appends and a frozen release.
   Erase its author: current Post body and permitted release labels remain; old Post bodies and private outline
   titles are physically cleared, commands/private reads fail, and released old target revisions become
   unavailable if independently purged. Include replay and a late authored-item disposition before acknowledgement.
4. With 101 prefix rows and multiple descriptors sharing B, crash after the first committed page, then resume
   and duplicate delivery. Assert every candidate is processed once logically, each action selects at most 100,
   offset 100 is reached, no descriptor-per-prefix rescan occurs, and completion follows final range exhaustion.
   Add unrelated catalogues/streams and retain the same indexed key bounds; actual query-plan/growth proof is
   deferred, not established by these fixtures.

No mounted API/browser verification is implied. Kernel native acceptance runs after source lands in the
dev verifier; existing test assertions are unchanged.
