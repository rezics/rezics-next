# Native edition metadata disclosure growth

Binding source: `d50464392475ae4a76362a7ed0bb1e9646126501` (clean retained base).
The earlier inspection source was `e21850110a75d916451a03711b9035610db998bf`.
On the binding base the Content Cost row **Edition metadata** still declares no growth run;
`test/content/edition.test.ts` supplies focused outcomes without a growth series.
This document describes executable acceptance, not measurements or Goal completion.

Owner: [Content Cost](../../services/kernel/src/content/README.md#fixed-authored-paid-editions),
[Content Done-when 1/5 and Acceptance](../goals/content.md).

Decision: grow subject, Realm and grant histories in separate sweeps so none can conceal another axis.

## Native operation and selected state

`test/content/growth-edition-metadata.test.ts` calls the actual mounted
`GET /v1/contentEditions/{id}`, with and without `Rezics-Edition-Identity: true`.
Its private fixture composes the supported native Content system, real Auth registration,
consent, issued bearer credentials, registered Auth/account runtime and production Access;
the observed Kernel uses `openGrowthDatabase` on that same isolated application database.
Access is neither replaced nor precomputed. A second Kernel on the original pool supplies
native mutation commands. Both use the production write limiter, configured with enough
ordinary setup capacity for the unobserved history producers; growth budgets are unchanged.

Subjects/scheme, Space, public Realm, board-scheme binding, published board, protected thread,
post and immutable revision are created through HTTP. Three editions of the same source are
created through the native command, with native owner roles: one draft, one published, one
published then terminally withdrawn. Native governance grants give a reader thread access
and the published edition's `edition:read`, never source `post:read`. A non-member without
that edition grant supplies the denial control. No purchase or new audience is introduced.
One selected subject, one post, one thread, one board/Realm/Space and fixed source bytes,
licence, association, credentials and scopes remain pinned. The scheme is setup vocabulary.

## Independent axes and capture

Each sweep starts with a fresh native fixture and grows only its axis to 256, 1024 and 4096:

| Axis                  | Producer outside observation                                                                                                                   | Cardinality assertion                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Unrelated editions    | Shared admitted `seed` copies an existing draft row with fresh same-route edition IDs; no publication, selected binding or grant is fabricated | Exact route edition count                |
| Selected post history | Native `POST /v1/posts/{id}/revisions`, carrying each returned head precondition                                                               | Exact post revision count                |
| Subject history       | Native terms PATCH with successive version preconditions and fixed-length labels                                                               | Exact subject revision count             |
| Realm history         | Native Realm PATCH with its currently returned head precondition                                                                               | Exact Realm revision count               |
| Grant history         | Native grant creates for the selected published edition, reader and action, in disjoint expired ranges                                         | Exact resource/reader/action grant count |

The selected reader's live grant starts in 2026 and has no upper endpoint; expired ranges
start in 2000 and never overlap it. Every grow asserts the other four cardinalities remain
at their initial value. No planner configuration or selected-state SQL writes are used.
Read-only SQL obtains the native source date, draft pressure template and cardinalities.

`checkGrowth` captures the entire HTTP read batch, including authentication, production
Access, source/subject before-and-final checks and current board/Realm/Space guards. Its
normal warm-up, repetitions, settling, classifier and thresholds apply. Bounds are constant
rows, statements and SQL request/response bytes, logarithmic shared blocks. The tests also
require native relation costs and use `assertGrowthAccessPaths` for actual indexed work;
returned DTO rows are not substituted for executed work. Transaction/catalog counts remain
visible. Fixed body/envelope sizes and the owning maximum of 33 ancestor posts are structural
caps; this fixture fixes one post and makes no ancestry-growth claim.

## Assertions and execution limits

Every scale checks exact closed draft/withdrawn creator metadata, authorized published
metadata with and without identity, protected non-member denial and allowed controls.
The pinned revision and digest survive a changed current head. Draft/withdrawn identity
uses the exact immutable source date; published identity has no ordinary-source date.
The DTO contains no body, source post/thread ID or URL. Metadata authority still yields
404 on ordinary source post GET, including after successful metadata reads. Conditional
headers cannot turn unchecked disclosure into a 304.

The SQL observer verifies repeated exact edition/source keys, released subject existence
checks, two label passes, final parent guards, real grant queries and metadata-only revision
projections. It uses the existing SQL hold/fault seam without substituting Access.
After each sweep reaches 4096, semantic race assertions hold the first label observation
while native commands revoke the edition grant, revise the Realm, hide the subject or erase
the source. Reads refuse at final disclosure; reversible changes have successful controls.
Post erasure also refuses published and withdrawn metadata. These race commands use the
separate original-pool native command envelope, outside the steady reader's cost capture;
no command/worker growth claim follows from them. PostgreSQL division-by-zero and typed
native source unavailability injected at the real source query must remain HTTP 500
`internal_error` and 503 `overloaded`, respectively, followed by a successful read.

Races/errors have semantic coverage at the final population, not their own three-scale
cost series. Inventory looping, revision byte delivery, publication restoration and worker
envelopes remain separate slices. This acceptance does not register a proof, change the
owning Cost row or authorize a launch. Authored assertions and source inspection are not
executed evidence; controller admission and integration verification remain required.

Sources inspected: the linked owner sections; focused native edition tests; native Content
system and Auth/website composition; shared SQL observer, growth capture/classifier, seeding
and access-path assertions; native edition reads/store/commands/subject guards; source-chain
and metadata-only revision SQL; native grant routes/commands and temporal SQL; subject terms
and moderation HTTP; Realm creation/revisions and current parent guards. No external reference
source is named by this contract.
