# Native Library archive Collection recovery

This page owns recovery of one manually curated Collection from the completed V1/V2 native Library export. The
[export contract](library-export.md) remains the authority for producer fields and capture semantics. The consumer
uses `decodeLibraryArchive` from `services/kernel/src/library/library-archive.ts`; it does not install another
archive format, exporter, general importer or retained raw-file store.

Decision: Keep at most two uploads per owner for 24 hours, select one Collection and at most 1,000 occurrences per
review, admit at most 25 recovery steps per apply request, and restore a Collection pin only for the sole archived
pin when the current native pin revision can express it.

## Installed journey

The typed client exposes these owner-only methods under `libraryArchiveCollectionRecoveries`:

| Method                                           | Purpose                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `POST /v1/libraryArchiveCollectionRecoveries`    | Upload a completed archive as canonical base64 JSON. The request key replays the same upload.                  |
| `GET /:id`                                       | Read private status, manifest, coverage, lifetime and confirmation.                                            |
| `GET /:id/collections`                           | Page source Collections in source UUID order.                                                                  |
| `GET /:id/collections/:collectionId/occurrences` | Page member occurrences in their archived presentation order.                                                  |
| `POST /:id/review`                               | Select one curated Collection and its occurrence IDs, then submit explicit source-to-current-Subject mappings. |
| `POST /:id/apply`                                | Confirm the current review ID and digest; each call admits at most 25 native recovery steps.                   |
| `GET /:id/outcomes`                              | Page each selected occurrence's membership, note and ordering outcomes.                                        |
| `DELETE /:id`                                    | Stop new work and retain already accepted native mutations and their precise outcomes.                         |

Every response is `private, no-store`; cursors are sealed to the owner, upload, page size and review epoch. Admission
uses the current Collections gate and `collection:read`; review and apply also require the native create/update
scopes. Each target Subject is resolved through current `subject:read` exposure and must already be canonical.
Unavailable, retired, inaccessible or unmapped targets stay explicit unresolved items. Display titles never match
Subjects. Authorization and cancellation are checked again after source work and before final responses.

The upload's UUIDs, owner UUID, revisions, timestamps, visibility, grants, profile pins and vocabulary pins are
evidence only. Recovery creates a fresh private Collection and fresh native member IDs. Public and unlisted source
visibility is never adopted. No grants, mounts, saved-query rules, built-in Collections, dynamic output, publication
output or other accounts' facts are restored. Presentation defaults to mixed. An explicit current Type choice is reviewed independently of archived evidence. A sole archived Collection pin is attempted only when the
owner has current pin scopes and the pin command's current revision; otherwise the pin outcome states why it was
omitted.

Only one manually curated Collection is selectable. The Collection title must be 1–200 code points and at most
800 UTF-8 bytes; description must be at most 2,000 code points and 8,000 bytes. Occurrence notes must be well-formed
Unicode, contain no NUL, and be at most 1,000 code points and 4,000 bytes. Preview distinguishes a missing note,
invalid note, cleared `null`, empty string and ordinary text. A missing note can still admit the occurrence, but its
note outcome remains unsupported, so the recovery is partial. Invalid note or Collection metadata cannot be
reviewed. Duplicate Subject occurrences remain separate by source member UUID.

The export pages occurrences by member UUID, not by display order. Recovery validates each archived ordinal as a
native ordinal key, then orders occurrences by `(ordinal_key COLLATE "C", source member UUID)`. Missing or invalid
order keys remain unsupported. The review reports whether the selected members establish complete order and
membership; selecting a subset or recovering unsupported items can never finish as complete. Native
`addMember`, `updateMemberNote` and `moveMember` commands apply the reviewed order and notes. Any Collection pin
uses the existing native pin command.

## Bounds and work

The consumer shares the installed decoder vocabulary: versions 1 and 2 on this base, with their fourteen- and
seventeen-section orders respectively. V2 annotations, provenance and journals remain unsupported here. The
assessment adoption owns V3 decoding; this change neither installs V3 nor promises future versions. It reuses the
producer manifest and limits: upload bytes `U <= 34 MiB`, depth at most 32, `N <= 100,000` archive records, aggregate compact
record bytes at most 32 MiB and each record at most 65,536 bytes. The HTTP JSON body is bounded to the canonical
base64 encoding of 34 MiB plus envelope allowance (under 48 MiB). Parsing and projection are `O(U + N)`; raw bytes,
decoded text, parsed rows and one bounded JSON batch are each bounded by those same upload/record ceilings. The
service stores only projected Collection and occurrence evidence, never the original upload bytes or a file
locator.

An owner retains at most two upload roots for 24 hours. Each upload retains at most 100,000 projected rows. Preview
page size is `P <= 50` and uses `P+1` indexed rows: Collection pages seek `(route, account, upload, source UUID)`;
occurrence pages seek `(route, account, upload, Collection, ordinal COLLATE "C", source UUID)`. First, deep and final
pages use the same indexed seek and one lookahead row. Preview performs no broad Subject join. Review admits one
Collection (`K = 1`) and at most `R = 1,000` selected occurrences. It reads selected occurrences through the
primary-key/indexed UUID operand. Across review mapping, apply preflight and native member insertion, current Subject
resolution is bounded by at most `3R` addressed checks. The selected review snapshot and outcomes are also capped at
1,000 rows.

One apply call performs at most 25 recovery steps. Total selected work is independently bounded by `3R + 2` native
command attempts: one Collection create, one member insertion, one note command and one ordering command per
occurrence, plus at most one Collection pin. Replays use the original stable native operation keys and receipts and
do not add a second payer. The existing Collection command indexes bound each member insertion to the parent and
Subject authority plus the native order-neighbor lookup. A move uses the native ordinal and member indexes; if local
key space is exhausted, the command reads at most 64 neighbors on either side and may rewrite at most 126 resting
members before the move. No historical Collection scan or LIMIT-hidden total-membership pass is added by recovery.

An upload can retain at most 100,000 evidence rows; two roots bound an owner to 200,000 rows. Expiry and terminal
account erasure delete at most 100 evidence/root rows per cleanup pass. Accepted Collections are independent native
facts: expiring or erasing archive evidence does not undo them. Deleting a recovered Collection continues through
ordinary Collection retention and its existing public-output independence.

## Outcomes and lifecycle

Each occurrence reports separate add, note and order states and a stable reason. Item failures do not erase accepted
occurrences. Cancellation admits no new step after the current in-flight native command is checkpointed; the
resulting Collection ID and accepted member IDs remain visible through owner-only outcomes. Retries after a lost
acknowledgement replay the same create/member/note/order/pin receipt and IDs. A refreshed review increments the
review epoch and changes the confirmation digest; an older confirmation cannot authorize work.

Private evidence expires after 24 hours. Reads, preview, review, apply and cancellation are owner-only and recheck
current account standing. `collection_archive_recovery` joins the existing terminal owned-graph erasure phase with
bounded row deletion. No export-source invalidation hook is added for recovery evidence or mutations.

## Verification and Web handoff

The focused native HTTP journey starts from an assembled actual owner export, then traverses upload, Collection
and occurrence preview, explicit mapping review, apply, outcomes and reopened native Collection/member reads through
the installed typed client. It uses two duplicate occurrences with different notes and an ordinal order deliberately
opposite to source UUID traversal. Focused replay coverage uses the existing native create/member/note/order/pin
commands. Broader native64/512/4096 growth acceptance and shared browser/remote checks remain deferred to integration.

Web remains the only export interface owner. Its adjacent recovery visit is delivered at
`/library/recover-collections` and consumes the methods above, version coverage `1 | 2`, per-item add/note/order outcomes,
and the explicit ordinal limitations. Web exposes only a new private destination because the installed native journey
does not admit merge or reuse. See the [Web consumer guide](../apps/web/src/library/archive-collection-recovery.md)
for mounted behavior and browser bounds. This document does not define a competing export page or promise support for
dynamic or public output.

## Explicit receiving presentation

Decision: Review accepts optional `presentationKind`; omission or null keeps mixed, while a Type identifier selects
that current Type and binds the entire current release digest. A changed release requires review again before a
new create, even when it still contains the Type. An exact accepted create receipt remains replayable.

Occurrence preview retains the raw archived `presentationKind` and returns `presentationAdmissible`,
`presentationReleaseDigest` and `presentationDisposition` (`none`, `available_explicit_choice` or
`unsupported_current_meaning`). This is evidence and current availability, never automatic adoption. Review rejects
an unknown or retired selected Type using the same current release vocabulary as the native editor. No private Type
lookup, member sweep, label matching, dominant-member inference or rewritten archived pin is introduced.

The immutable review snapshot/digest includes the mixed/archived/alternative choice, release digest, canonical
private create operands and original native key. The review response exposes `review.presentation` with `kind`,
`source` and `releaseDigest`. An alternative is a new receiving choice. The confirmation still contains the review
ID and digest; replacing review or mixing confirmations cannot change a pending create. Historical snapshots without
these additions retain their mixed operands and original stable keys.

The native Collection create command performs current authority and Type admission, including the reviewed release
check in its preparation. Business admission failures are deferred past exact receipt replay. Recovery performs no
replacement apply-time Type pre-read. A new unsupported/stale create has no accepted Collection and can be reviewed
again; lost acknowledgement invokes the persisted original command, preserving its receipt and identity even after
a release change. Once accepted, a later missing Type follows the existing stored owner-choice fallback without
editing the Collection. Status, review, confirmation-bearing responses and results expose separate `presentation`
states `mixed`, `adopted`, `unsupported_or_stale` or `unattempted`, plus kind, source, reviewed digest and reason.
Every response explicitly retains `fullRestoration:false`; membership completeness is a separate state.

### Added work and verification boundary

Preview adds at most one addressed active-release lookup for the selected Collection, independent of P+1 occurrence
rows. Review adds at most one lookup for an explicit Type, one direct Type key admission, and constant-size choice,
release, canonical input and key serialization in the existing root snapshot write. Mixed performs no Type lookup.
Native create preparation performs one release lookup and addressed Type admission per attempt, including retries;
its current account/epoch/authority, receipt, History, grants and event work remains charged to the existing native
command. Exact replay repeats native authority/preparation/receipt probes without another create, History, grant or
event effect. Recovery retains its admission before/final response and after each accepted effect, root/lease reads,
begin/checkpoint writes and at most 25 steps; a stale refusal adds one checkpoint and lease release. No R-sized
presentation buffer, observation or history discovery is added. Root cleanup clears the failure and snapshot in the
existing absolute-expiry pass, with child-first cleanup100 and two roots/24 hours unchanged. Upload buffers remain
bounded by U/N; preview51, selected R1000, native move respace and pin work keep their independent bounds. Personal
merge P100 and export producer16/120000 bytes are separate interfaces and budgets.

The focused test file is `services/kernel/test/library/library-archive-collection-recovery.test.ts`. Source derivation
establishes no executed pass: independent all-pool native64/512/4096 upload, first/deep/final/empty preview, review,
create, refusal/stale, original replay, cancellation/expiry and physical-erasure acceptance stays with the controller,
holding selected work fixed as unrelated history grows. Existing decoder refusal/version suites remain independent.
Comparison sources were the existing native Collection editor and recovery, `legacy-final`'s recorded anime Collection
page (reference only), and the BookWyrm shelf view and Ryot Collection filter form named by the shelf research. The
retained behaviors are explicit owner controls, private visibility, order and unknown evidence without inferred kinds.
Web's existing `/library/recover-collections` owner receives the actual route schema/generated client additions;
its page implementation and broader browser acceptance remain independent. No new page or local importer is added.
