# Canonical episode completion

Commerce owns personal completion facts. Semantic owns Episode Subjects, selected catalogue relationships,
released definitions, disclosure and source numbering. The native consumer adapter is
[`readEpisodeSource`](../services/kernel/src/library/episode-source.ts); a bounded Semantic producer interface
has been requested. It consumes the existing selected/disclosed `readSubject` authority, not an episode catalogue,
search result, caller assertion or new vocabulary release. No release is activated by this feature.

Decision: canonical episode completions are a separate per-session fact set, independent of scalar/manual
progress; exact canonical IDs and direct `schema:isPartOf` membership are required for additions, while
correction and clear survive catalogue removal.

## Start, record and inspect

Use the authenticated native `POST /v1/progressSessions` to create an independent session for the real parent
Subject, with its currently supported mode and `unit: "episode"` (the bundled series/season profile supports
`scalar_amount`). Its accepted profile pin, account, parent and existing session lifecycle remain authoritative.
The new fact set starts empty even on an old session. No prior scalar count, opaque completed-unit ID,
ordinal, source identifier or version Subject becomes a canonical Episode ID.

`POST /v1/progressSessions/{sessionId}:recordEpisodes`, action `progress_session:update`, takes exactly one of:

```json
{ "revision": 1, "add": ["canonical-episode-uuid"], "remove": ["another-canonical-episode-uuid"] }
```

```json
{ "revision": 2, "clear": true }
```

`add` and `remove` are optional individually; at least one ID is required. Together they admit at most 20 distinct
lowercase routed UUIDs, with no overlap or duplicate. Clear is exclusive. Each session retains at most 20,000
canonical completions. Additions require the exact current canonical `schema:Episode` Subject (or a released
subtype), a disclosed selected nondeprecated direct `schema:isPartOf` statement to the session's exact canonical
parent, and the original/current compatible profile mode/unit pair. There is no season-to-series transitive
inference. A session's optional version Subject does not replace this parent. Source ordinals never admit identity.

Every successful command advances the existing session revision once, including an already-present add or absent
remove. Its response is exactly `{"revision":3}`. It touches native Library activity, the subject head and existing
session-updated event. The scalar amount, cursor, manual unit set/count, session state and completion date stay
intact. Generic `:record`, its `clear`, `:complete` and `:abandon` keep their meanings and preserve canonical facts.
Canonical commands do not append IDs to the generic progress-change history or published log snapshots.

Native occurrence reopening preserves canonical facts. Retirement conceals both owner read modes and refuses
fresh canonical mutations, including clear; an admitted exact command receipt still replays its original revision.
Retired facts remain private audit data until terminal account erasure, following the existing session lifecycle.

`GET /v1/progressSessions/{sessionId}/episodes?ids={comma-separated-uuids}` inspects a current catalogue page of
at most 20 distinct IDs, in supplied order. Each result has exactly `episodeSubjectId`, `completed`, `membership`
and `ordinal`. Visible admitted Episodes return their exact UUID, a boolean completion, `member` or `detached`,
and the currently disclosed ordinal string or null. An unmarked episode returns false even between completed
neighbors. Specials with the same ordinal remain independent because their UUIDs differ. A concealed, missing,
redirected or no-longer-admitted Episode, or an unavailable parent, gives exactly
`{"episodeSubjectId":null,"completed":null,"membership":"unavailable","ordinal":null}`. Absence of numbering
is explicit null, never an invented contiguous number, episode kind or order.

Without `ids`, the same GET pages retained completion facts by canonical UUID, with `limit` from 1 to 20
(default 20), `cursor`, and `next`. It does not enumerate the catalogue. Concealed candidates consume a page slot
and appear only as the redacted row above. The encrypted cursor contains the private raw frontier and is bound to
account, session, partition epoch and session revision. Any intervening session mutation makes it stale. `ids` and
`cursor` cannot be combined. The complete response is `{"revision":3,"episodes":[...],"next":null}`. Inspect mode
always returns `next:null`. All owner reads use `Cache-Control: private, no-store`.

## Retry, errors and lifecycle

Both operations use generic sessions' authenticated self-owner admission: current scopes, an active unfenced
account and current authentication epoch. Subject authority independently requires native Access. No new account
ACL or grant is installed. Unknown and foreign sessions return 404, including accounts on the same route. Commands use the existing
reading-progress gate, command runner, terminal barrier, owner/subject/session lock order, exact revision CAS,
transactional receipt and session-token fence. Supply the standard `Idempotency-Key` header; retry the identical
command with the same key. Authorized exact receipts return the original revision even after the catalogue is
concealed or the profile changes. Changed input with the same key is 422 `idempotency_conflict`. A new intent needs
a new key and the latest revision. Deferred source preparation errors never invalidate exact receipts.

Malformed IDs, batches, mixed clear and invalid limits are 400 `invalid_request`; stale revisions are 409 `conflict`.
An invalid or foreign cursor is 400 `invalid_cursor`; changed epoch/revision is 409 `stale_cursor`. Ineligible,
concealed or wrong-parent additions are 404 `not_found`, without revealing which submitted ID failed. Unsupported
or incompatible current/original profile is 422 `unsupported_library_profile`. Missing active semantic authority,
changed source evidence or unavailable infrastructure returns 503 (`semantic_not_ready` or the existing native
dependency/deadline/partition errors); retry after rereading. Unauthenticated callers get 401; scope/command
permission denials use the existing 403/404 owner transport convention. Failed commands persist no partial set.

Catalogue insertion, withdrawal, renumbering, reordering, type changes, merges, visibility changes and definition
rollback never update historical personal rows. Newly admitted members start unmarked. Removed but visible
Episodes remain completed and `detached`. Concealed identities and ordinals are redacted on every read; raw IDs
never enter generic history, counts or public snapshots. No automatic merge transfers an old completion to a new
identity. Known exact historical IDs can be removed without current catalogue/profile support; clear removes the
entire canonical set under the same owner/revision fences. Account terminal erasure removes canonical rows in the
existing shared 100-child session page before deleting the session. No background synchronizer is installed.

Source/type/relationship evidence is observed in Semantic's own snapshots, released before owner checkout. Reads
reobserve disclosed evidence and the owner revision/epoch before returning. This follows the native Library
foreign-source observation boundary; it does not introduce a cross-partition transaction or retain catalogue
snapshots as personal authority.

## Web checklist integration and focused scenarios

The signed-in progress-session page mounts a private canonical checklist beside scalar measures and the diary, without
taking those owners. Viewer association uses the same `{viewer,requested,locale,page}` envelope as
`readCurrentViewerProgressIndex`; the session host supplies that viewer from the page read that prepared it. Account
replacement, sign-out, unknown viewer or failed association immediately retires rows, cursors, selections, review
authority and late callbacks. A matching viewer cannot authorize a stale subject, cursor, locale or session revision.

Decision: use the work-parts inverse `schema:isPartOf` stream when present, otherwise the default stream. If that page
does not admit canonical Episode Subjects, membership is unavailable rather than scanning other streams. Association
byte cap remains unavailable in [subject pages](subject-pages.md); membership is therefore bounded by the installed
20-row work-parts page (`MEMBERSHIP_PAGE_CAP`) and encoded current-page bytes, not an invented producer byte cap.

Obtain catalogue membership/order from that one Semantic page, pass at most 20 exact Episode IDs to
`progressSessions({sessionId}).episodes.get({query:{ids}})`, and record with
`.$recordEpisodes.post` using `Idempotency-Key: JSON.stringify(key)`. Preserve unmarked holes and separate special
IDs. Use current ordinal labels only; show missing authority explicitly. Completeness is shown only when the native
body defines it; omission is unavailable, never zero. Retained-fact paging (`limit`/`cursor`, no `ids`) provides
corrections for detached visible episodes. Clear is exclusive and remains useful without source identity. Reread after
a stale revision, retain the exact key/body for transport retries, and never infer a checked prefix from a scalar
value. Reopening keeps canonical facts; a retired occurrence conceals current rows and refuses fresh mutations,
including clear, while an authorized exact receipt may replay its original revision.

[`episode-progress.test.ts`](../services/kernel/test/library/episode-progress.test.ts) exercises mounted production
Access and persisted Subjects: episodes 1 and 3 with 2 unmarked, equal-numbered special, separate reread, scalar
independence, wrong parent/type, owner isolation, CAS, exact retry, clear, cursor invalidation, membership withdrawal,
concealment, correction after profile removal, reopening and retirement. Its intent checks reject old tokens and
ambiguous batches.
Controller-owned integration acceptance remains separate from these focused scenarios.

## Cost

- Operation: one private checklist visit (membership page + ≤20-ID inspect), explicit retained continuation, and one
  bounded add/remove or exclusive clear plus inspect readback.
- Touched neighbourhood: installed `episodes` GET and `$recordEpisodes` POST, the work-parts membership page, the
  mounted visit. No per-episode request loop, catalogue enumeration or whole-session cache of N ≤ 20,000.
- Formula: one visit is `1` membership page of cap `L=20` plus `1` inspect of `I≤20`. Continuation adds one retained
  page `R≤20`. A mutation is one command plus fixed revision/readback. Web work and retained bytes are
  `O(L + 20 + encoded current-page bytes)`, independent of retained completion count N.
- Installed caps: inspect ≤20 IDs, retained pages ≤20, combined add/remove ≤20 distinct IDs, session retained cap
  20,000 (`MAX_EPISODE_IDS` / producer session cap). Work-parts membership `limit: 20`. Association byte cap is
  unavailable; Web does not invent one.
- Test reference: `apps/web/tests/canonical-episode-checklist.test.tsx` growth cases at 20/200/2,000 retained
  completions with a fixed membership/inspection set.
