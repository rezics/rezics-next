# Owner-wide progress discovery

This document owns the private owner-wide index of native Library progress sessions. The existing subject-scoped
`GET /v1/progressSessions?subjectId=...` contract and the native session editor remain in place.

Decision: Owner-wide progress discovery follows `(started_at DESC, session_id ASC)` and excludes retired sessions; it allows one typed state, profile, or mode filter at a time, optionally combined with an exact subject, so each bounded page has a native seek index.

## Native read

`GET /v1/progressSessionDiscovery` accepts optional `subjectId`, `state`, `mode`, `profileId`, `limit`, and `cursor`
query fields. `subjectId` is an exact native identity selected by the bounded, disclosed Subject picker. The route does
not turn free text into a private Subject scan. The only progress filters are native session state (`active`,
`completed`, `abandoned`), native mode (`scalar_amount`, `cursor_position`, `completed_units`), and the exact retained
profile ID. At most one of state, mode, or profile may be supplied; any may be combined with `subjectId`.

The default limit is 20 and the maximum is 50. The seek query fetches at most one lookahead row, returns at most 50
sessions, and keeps repeats as separate session IDs. Its order is stable across pages. A readable retired session is
omitted, matching the existing ordinary session reader; no retired count is inferred or disclosed. Empty owner results
and empty filtered results are separate Web states.

The sealed cursor binds the account, authentication epoch, request origin, locale header, complete filter predicate,
order, partition epoch, owner discovery generation, and exact `(started_at, session_id)` seek tuple. It expires after
15 minutes. Predicate mismatch and foreign cursors are invalid; expiry, partition change, or an owner-generation change
is stale. A continuation never drops its predicate. The generation check makes inserts, deletes, ownership or subject
moves, state/mode/profile changes, and order corrections invalidate the old cursor before a deleted anchor can skip a
row.

The migration installs statement-level generation triggers on the native session table. They advance once per touched
owner per statement for create/delete and for updates that change owner, subject, state, mode, start time, or retained
profile. Existing rows begin at generation zero without a history scan; the migration and trigger installation are
the completeness boundary for subsequent changes. Account erasure deletes the generation row in its own bounded
owned-graph phase. No events or background repair are treated as the source of currentness.

The list read uses the authenticated current account snapshot and native `progress_session:list` admission. After
hydration, the route rechecks Subject disclosure and the owner/partition generation before returning the response.
Changes during hydration fail as dependency unavailable or stale; they do not produce a mixed page.

## Response and disclosure

The response includes `viewerState: "signed_in"`, up to 50 exact native session occurrences, and an opaque `next`
cursor or `null`. Each occurrence carries its existing mode, retained values and measures, lifecycle state, revision,
timestamps, safe disclosed Subject/version summary when available, retained-profile presentation, and `allowedActions`
for open, edit, complete, and abandon. Action reasons distinguish a non-active session from missing authority. A
readable private session remains visible with unavailable work context when its Subject is concealed or unavailable;
concealed Subjects have no title, cover, badge, or destination link.

Presentation uses one bounded batch of current Subject summaries and one batch for the distinct retained release
digests in the page. Historical meaning comes from the session's exact accepted profile pin. Current recording
admission is reported as unavailable in this discovery response; the index does not substitute the current Entry or
rewrite old meaning. Missing or invalid retained releases are unavailable, unpinned legacy sessions remain unknown,
and neither condition hides native quantities. A failed list dependency is not reported as an empty list.

`allowedActions` is display guidance. Row navigation uses the exact session ID and the existing native editor. Complete
and abandon continue through the existing command receipt and revision checks, which re-evaluate current authority and
the exact occurrence. Uncertain acknowledgements retain the original command key and operands; discovery never starts
a replacement session or command to resolve uncertainty.

## Bounded work model

For a page size `S` (`1 <= S <= 50`), native discovery returns at most `S + 1 <= 51` session rows. The index uses one
generation read and one indexed keyset query in the listing snapshot; final currentness uses one generation read in a
second authenticated snapshot. The selected SQL branch is one of eight fixed owner/subject/state/mode/profile
predicates. There is no owner-history reread and no per-row session detail request. Session measures are already on the
native session row and are capped at eight per session.

Hydration receives no more than 50 facts. At most 100 distinct original Subject IDs are derived (two per session).
Current Subject disclosure follows the existing bounded batch helper: it reads original and first redirect identities,
then verifies the same bounded identity set, never more than 200 IDs total. Access evidence is prepared and checked for
at most those 200 IDs per pass. Subject/edition summaries, media references, and source fences use their existing
partition-grouped bounded readers; disclosure and image checks remain required. Retained presentation loads at most
50 distinct release digests in one lookup. All batches are capped before serialization; no request performs detail
polling per session.

The inclusive 64/512/4096 growth counters, exact all-pool statement/block pricing, and corresponding native/browser
acceptance are controller-owned and deferred to integration. This source-level model states the per-request caps; it is
not a measured growth result.

## Page

`/library/progress` is designed to open with the signed-in owner's full readable session list. It provides exact Subject
search, one typed filter, filter removal, an explicit reset to owner-wide discovery, bounded continuation, separate
empty states, retry, stale-continuation recovery, and signed-out/account-retired/dependency-unavailable states. Address
and query identity include the full predicate, cursor, viewer, locale, and origin generation. Late responses cannot seed
a new predicate. Controls are labeled, wrap long names, announce loading, preserve keyboard focus, and retain the
existing minimum phone target size in all locales.

The Kernel route is mounted, but the installed `@rezics/client` does not yet expose its generated
`progressSessionDiscovery` method. Content owns that publication. Until it lands, Web keeps the established
subject-only reader and returns an explicit unavailable state for owner-wide or typed-filter reads; it does not make a
raw HTTP request or invent a client declaration. The continuation brief tracks that integration.

The page renders the API's retained session meaning, quantities, state, and action availability. It links each row to
its exact native editor route and uses existing creation admission for new sessions. It does not group repeats, fetch
details in a per-row loop, or duplicate editor and recovery logic.

## Focused verification

Focused native HTTP coverage is in `services/kernel/test/library/progress-http.test.ts`; focused address and stale
response coverage is in `apps/web/tests/progress-address.test.tsx` and
`apps/web/tests/progress-index-current-origin.test.tsx`. Rendered page states are in
`apps/web/src/stories/library-progress-discovery.stories.tsx`.

`bun run --cwd services/kernel derived schema` passed and derived the installed schema from the migration. The Kernel
typecheck command, `bun run --cwd services/kernel typecheck`, completed with repository errors outside the discovery
sources; the first is the missing Content-owned client publication at
`../../packages/client/src/index.ts(268,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.` The final typecheck reported no diagnostics in the discovery route, store, SQL, presentation, or erasure changes.

`bun run --cwd apps/web typecheck` failed while loading Kernel source without its SQL content mapper. Its discovery-specific
error is `../../services/kernel/src/library/progress-discovery-presentation.ts(10,26): error TS2307: Cannot find module './progress-discovery-releases.sql' or its corresponding type declarations.` This does not validate generated client consumption; that publication remains with Content.

The focused Kernel command `bun run --cwd services/kernel check test/library/progress-http.test.ts` was attempted three
times. Each attempt stopped during shared remote preparation before the test process started: the first reported
`stalledPhase: "native-cache-lock"`, the first retry reported `stalledPhase: "source-artifact-publication"`, and the
second retry reported `phase: "run-lifetime"` after a 50.045-second timeout. The Web command
`bun apps/web/scripts/focused.ts --private-network -- bun test tests/progress-address.test.tsx tests/progress-index-current-origin.test.tsx`
was attempted three times and exited before spawning tests with `Web check custody: private descriptor must be outside candidate source` each time. These focused results are unavailable, not passes.

Frozen broader acceptance, independent 64/512/4096 growth, full Kernel checks, and browser review remain
controller-owned.
