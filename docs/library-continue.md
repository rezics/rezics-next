# Continue

This is the owner contract for the private Library Continue row. It adopts the bounded native read required by
[Library and Collections](library-and-collections.md#destinations-and-actions) and the
[Library module](../services/kernel/src/library/README.md#required-built-ins-and-personal-space).
[Profile consumers](library-profile-consumers.md) own accepted meaning and independent facts;
[filtered lists](filtered-lists.md) own canonical identity, disclosure, admission, readiness and useful pages.
This specification and its native red cases precede runtime implementation. They do not establish a working route,
complete Library, measured cost, a new Collection kind or a new owner-query leaf.

## Membership and independence

Continue is the canonical unique union of the viewer's own subjects supported by either:

1. A live explicit state whose **stored accepted profile** declares that exact state ID with `role: active`.
2. A retained active progress session accepted by that session's actual stored profile and exact mode/unit pair.

One support suffices. An accepted active state without a session qualifies. A session without any entry qualifies
and returns `state: null`. A non-active state does not veto an independently active session. Never test the literal
state string `in_progress`, look up an old fact in today's release, infer historic meaning from current subject type,
or require entry membership before discovering sessions. Missing accepted meaning or incomplete writer/migration
coverage requires readiness, not guessed membership or an empty result.

State, sessions/history, labels, holdings, follows, payments and entitlements remain independent. Starting or
recording progress does not set state. Completing a session does not complete the entry; clearing state does not
complete, abandon or delete sessions or history. Completed-only history supports Everything but contributes no
active Continue support by itself. Label-only, holding-only, follow-only and payment-only subjects do not qualify.
Neither payment nor a holding proves an entitlement. GET performs no inference, entry/session/copy creation,
entitlement grant, receipt, source-index repair, header/grant materialization or work enqueue.

## Canonical meaning, activity and sessions

Preserve every original subject reference, fact ID and accepted pin. New writes target the current terminal;
canonical browsing emits one subject. Use the shared maintained canonical-ID indexes and published identity epoch.
While identity maintenance is pending, return readiness. A published epoch change invalidates the continuation and
requires restart. Never rewrite originals or canonicalize a stored-ID page after paging.

For `state`, use the current canonical own effective explicit state selected by the shared native
`owner_write_seq` rule, or null when absent. Evaluate that chosen state's active role using its accepted pin;
an older conflicting active state cannot override the chosen non-active state. Canonical session support unions
the retained eligible sessions across disclosed originals, keeping their native IDs and subject references.
Current authorization must cover each contributing original, its native source and the terminal. A readable
terminal cannot launder a withheld original or its private activity. Incomplete original/source disclosure coverage
cannot become a negative membership decision. Continue adds no conflict or private-pin fields to its closed DTO.

Several active sessions are legal. Choose the displayed BASIC session using the existing native rule:
`last_changed_at DESC, session_id ASC`, over the eligible own active sessions for that canonical subject. This is
separate from subject ordering and session start date. Recording an older session can make it the displayed one;
completing that session reveals the next active session. No terminal session is embedded as active.

`lastActivityAt` is the native maintained maximum of accepted state changes and retained subject progress activity,
including accepted session start, record, complete and abandon. A terminal change can rank a subject that retains
another active support. State clear preserves retained progress activity; state-only eligibility uses its native
entry activity. Receipt replay, rejection and rollback do not advance activity. Reuse actual maintained activity
source keys, including the retained progress head after entry removal; never use migration time, release activation,
user-supplied start/completion dates or a browser sort over the whole owner. Historic missing activity remains
unknown and requires explicit migration/readiness, never a fabricated timestamp.

## HTTP contract

`GET /v1/libraryContinue?limit&cursor` has a closed query. Only `limit` and `cursor` are accepted. The shared paging
default is 20 and maximum 100, with integer minimum 1. Unknown `accountId`, state/status/type selectors, `filter`,
`orderBy`, direction, search, view and every other parameter return `400 invalid_request`. Continue does not reuse
the fixed status-tab shelf query or require status tabs as product navigation.

Success is closed `200` JSON:

```ts
{
  subjects: {
    subjectId: string;
    state: string | null;
    lastActivityAt: string;
    activeProgressSession: BASIC_SESSION | null;
  }
  [];
  next: string | null;
}
```

`state` is an exact data ID, not a kernel enum. `subjectId` is canonical. BASIC_SESSION reuses the existing HTTP
field set in [progress-routes.ts](../services/kernel/src/library/progress-routes.ts): `id`, `subjectId`,
`versionSubjectId`, `mode`, `unit`, `total`, `amount`, `locator`, `position`, `completedUnitCount`, `state`,
`revision`, `startedAt`, `completedAt`. Preserve decimal strings and nulls. Its stored subject reference remains
native even when the outer subject is canonical. Do not add account/route/transaction IDs, pins, release/profile
metadata, sparse-unit sets, progress changes or private history. Use private, no-store caching.

Order is fixed: activity descending, canonical subject ID ascending. The server keeps the exact SQL timestamp text
in the opaque keyset position, preserving submillisecond distinctions; JavaScript `Date` is not a seek-key codec.
Use the existing shared authenticated opaque list cursor and key ring, not Library-local signing or encryption.
Bind method/path, viewer, effective limit, source/query identity, partition epoch and published canonical identity
epoch. A cursor grants nothing: authenticate and authorize every continuation and recheck current native sources
and subject disclosure. Malformed, tampered, foreign-viewer, foreign-query and changed-limit cursors return
`400 invalid_cursor`; changed published epochs return `409 stale_cursor`, requiring a fresh first page. Shared
cursor expiration/key retirement retain their native invalid/stale outcomes. Pagination is live across requests;
moving activity can require refresh, and no historical account snapshot is promised.

An empty success means genuinely exhausted eligible input. A successful nonfinal page is filled. Pending canonical
epoch, missing meaning, unready candidates or incomplete disclosure return explicit shared preparing/readiness,
never a chain of short or empty successes. Use the owning shared preparation transport; this document invents no
new progress token/status protocol. Retain settled progress and finish on fixed finite input under fair durable
work and eventually successful I/O. GET never starts that work. Unavailable dependencies retain their real errors.

## Native authorization boundary

Require bearer authentication, `library_entry:list`, `progress_session:list`, and the existing `personal_library`
and `reading_progress` gates, matching native shelf activity/BASIC-session disclosure admission. The actual
progress point/history operations used by acceptance additionally require `progress_session:read`; that existing
point scope is not an invented list scope. No new `library_continue` scope or fabricated readonly persona is introduced.
Require current list capabilities before private candidate or cursor reads. An active Bob/outsider can list only
their own Continue subjects; neither can select Alice through a query or reuse her cursor. Anonymous never gets
own rows. An empty-scope bearer receives `403` with `insufficient_scope` bearer challenge.

The shared fixture's `suspended` persona has a **pre-suspension revoked bearer**. Its native outcome is HTTP `401`,
JSON `invalid_credentials`, and `WWW-Authenticate: Bearer error="invalid_token"`. Do not mint a purported valid
suspended bearer to obtain 403. Password sign-in's `403 ACCOUNT_SUSPENDED` belongs to Auth and is not a Continue
response. Older Library prose about valid suspended tokens does not change this native credential outcome.

## Frozen native scenarios and delivered gaps

[continue-user-cases.test.ts](../services/kernel/test/library/continue-user-cases.test.ts) uses exactly one
`createReleasedDiscoveryFixture({version: 1})` world per test, production HTTP, real registered personas and returned
subject/profile choices. The
[released fixture ABI](../packages/definitions/src/released-discovery-fixtures.md) owns setup and cleanup.
Its `personal`, `profiles` and `privacy` prerequisite descriptors are not callable producers. At adoption there is
no integrated released Library population family export; the independent setup uses actual `createSubject` and
`request`, without duplicating a producer, custom Definitions release, SQL fact/permission writes or test handler.
Missing bundled choices, gates and routes remain meaningful native reds, not skips, missing-driver passes or
permanent throw placeholders. Existing profile and outcome suites are frozen and unchanged.

The executable cases require:

- Released Book active-role state whose ID differs from `in_progress`, without a session; session-only Book and
  Recipe with null state; exact union excluding completed-only, label-only, holding-only, follow-only and Bob-only.
- Native start/record/complete/state-clear transitions preserving independent state, sessions and history;
  a non-active explicit state plus an active session still qualifies.
- Two active sessions, recording the older one to choose it, and completing the displayed one to reveal the next.
- Raw first and final signed/opaque pages, fixed activity order, unique subjects, limit and viewer binding,
  tampering rejection, closed selectors, empty exhaustion and native revoked/unscoped/anonymous outcomes.
- Replayed GETs preserving exposed native entries, sessions, history, copies, follows, labels and Collections.
  This observable read-only case is not SQL cost or complete hidden-storage mutation instrumentation.

Two immutable historical bundled-release variants remain a **delivered fixture gap**. The producer must supply real
published release bytes and ordinary activation/rollback that (a) rename/change an active state ID/role and (b)
remove a formerly accepted state or progress choice. Runtime acceptance must preserve old facts' exact pins,
membership, session admission and activity from their accepting release while rejecting unsupported fresh writes;
it must cover old active meaning versus new non-active meaning and the reverse. Do not fabricate v2 bytes, mutate
the single world's release or claim these history cases passed. Current bundled absence is an asserted failure,
not a reason to weaken these requirements.

Runtime also requires native canonical merge/unmerge, withheld-original/readable-terminal, current source
revocation on continuation, pending/published epoch restart, missing-pin readiness, exact SQL submillisecond/tie
keys and finite preparation/crash/replay cases through the shared owners' real producers. This two-file adoption
does not fabricate their missing fixture controls or claim their execution. A separate approved shared owner leaf
owns not-cooked queries; no new not-cooked endpoint or predicate is specified here.

The older [shelf contract](../services/kernel/src/library/shelf-contract.md) Continue=`in_progress` query is
superseded **for Continue** by this document. Its fixed status vocabulary and mandatory tab navigation do not apply.
Followup reconciliation must link this owner contract from the shared Library/shelf writer's files and remove
their obsolete Continue guidance at that writer's cutover; those files are intentionally unchanged in this adoption.

## Cost

- Touches: owner-local indexed active-role/session candidates, accepted meaning/current disclosure, canonical
  epoch and bounded BASIC session projection. Indexes remain derived discovery, never personal truth or permission.
- Bound: [filtered-list](filtered-lists.md#cost) direct/ready/preparation and useful-page budgets, including actual
  candidates/rejects/lookahead, original/source/terminal Access, rows, buffers, statements, connections and bytes.
  No growing owner/session-history sort/count, per-page original-home sweep or private public mirror. Use indexed
  top-active probes for emitted subjects, not sparse-unit/history enumeration.
- Growth check: runtime requires native 64/512/4096 owner population, session/history and alias axes, first/deep/empty
  pages, actual counted units, readiness, retained preparation and useful-page completion. This specification reports
  no measured progress/cost or whole Library completion.
