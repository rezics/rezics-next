# Private reading insights

This owner document covers the retained-profile distribution, private assessment coverage and current-progress
projections. New native sessions capture accepting unit meaning and assessment presence, while old rows without
captured unit meaning remain unavailable for dimensional interpretation. The complete private insights journey still
needs its reachable Web page and matching generated client. Existing all-time/year counts, month navigation, journal
reads and commands, and diary allocation remain authoritative and unchanged.

Decision: Group historical completions by the entire immutable accepting profile pin, including release and accepting
Type; show profile identity with historical labels unavailable until accepted descriptors are retained, never infer books
or episodes from a current Type or a profile ID. Pins exceeding 1,024 encoded bytes join historical-unavailable coverage.
Decision: Capture current-progress meaning only from the accepting pinned descriptor at native session creation; older
rows without a captured descriptor remain unavailable, and labels or current profiles never supply historical meaning.
Decision: Assessment coverage includes retained non-retired sessions, including active sessions; retirement removes a session from the panel and restoration receives it again. Keep exact values and half-point frequencies within each meaning revision, report historical null presence as unknown, and never average incompatible revisions.
Decision: Insights returns diary navigation as the existing `library_diary.list` operation and its query values; Diary retains ownership of the destination and allocation.
Decision: Current progress groups retained `active` sessions as active and retained `abandoned` sessions as backlog; completed and retired sessions are excluded.

## Mounted panel contract

`GET /v1/libraryReadingInsightsProfiles?year=2020`, operation `library_reading_insights.profiles`, is an independent
owner-only panel seam. It requires the current authenticated own account, `progress_session:list`, the existing
`reading_progress` exposure, partition admission and request deadline. There is no owner selector. It returns private,
no-store JSON. Anonymous/invalid credentials remain 401; absent scope, retired/fenced owner and other authority
failures remain the existing 403 problem contract. Invalid/missing/duplicate year or additional query fields are 400.
Delivery failures and changed source/current authority are never converted to empty results.

The selected year is an explicit Gregorian reported finish year in 1..9999. Only retained native sessions whose
actual state is completed and whose explicit journal finish is valid contribute. A missing or unsupported finish is
unallocated, not assigned using the audit clock. The independently mounted reported-year summary owns those
unallocated coverage counts, twelve months, month precision and global distinct/repeat counters. This panel does not
replace them or assert a common snapshot with a separately accepted summary generation.

An available result has `scope:selected_reported_year`, `dateSource:explicitly_reported_journal_finish`,
`grouping:exact_retained_profile_pin`, `historicalLabels:unavailable` and exact decimal-string counts:

- `profiles`: at most eight retained pins, ordered by numeric completion count descending and canonical pin bytes.
- `unknown`: the missing/over-budget retained-pin group, independently counted and never included among known pins.
- `remainder`: exact undisplayed completion and repeat quantities plus the exact number of undisplayed profile groups.
- `totals`: all included known and unknown groups. It is never the truncated top set alone.

Each count set has `completedOccurrences` and `repeatOccurrencesWithinProfile`. The latter is occurrences minus
distinct stored Subject identities **within that exact retained pin group and selected year**. Totals and remainder
sum these group-local repeats; they are not global year repeats. One Subject with different accepted pins can have no
repeat in either group while the existing year summary correctly records a global repeat. No unit or assessment
amount, average, classification, language or public vote is implied by these completion counts.

`currentness` identifies `source:reading_insights_v1`, its opaque `revision`, and the separately identified
`retainedSourceRevision` from the installed all-time counter. Every source mutation invalidates both generations,
including changes that leave distribution membership unchanged. Original command replay without a source mutation
changes neither. Cache consumers must bind values to exact origin/owner/locale/year/request generation, discard stale
responses and clear old values on authority change or unavailable coverage. This panel is a pure GET with no command
identity, diary slot, renewal, export or repair side effect.

## Mounted assessment panel contract

`GET /v1/libraryReadingInsightsAssessments`, operation `library_reading_insights.assessments`, is an independent
owner-only panel. It requires the current authenticated own account, `progress_session:list`, the existing
`reading_progress` exposure, partition admission and request deadline. It accepts no query fields and returns private,
no-store JSON. It does not change the journal read or command response.

The panel covers retained non-retired progress sessions, including active sessions. Each meaning revision remains a
separate group with exact `absent`, `explicitNull`, `value` and `historicalUnknown` counts. New sessions begin absent;
an explicit null patch is distinct from an omitted patch; a value of zero is retained in the value histogram. A null
presence on an older row remains historical unknown, while an older non-null value remains a value. Histograms list
native half-point units and exact occurrence counts without averaging or combining revisions. Retiring a session
removes its contribution; restoration adds it once; receipt replay does not receive a second contribution.

The installed marker is version 1. Receiving is synchronous for new sessions and addressed mutations. Older retained
rows initialize through the existing bounded shelf-maintenance sessions phase. Availability requires the installed
all-time source and ready/open shelf maintenance, plus equality between this receiver's initialized-session count and
the retained-session counter. The reader addresses at most sixteen revision rows and twenty-one exact value buckets
per revision, rechecks authority and generation, and caps JSON at 16,384 UTF-8 bytes. GET remains pure.

The mounted route and schema are exported by `reading-insights-routes.ts`. Content owns publication of the matching
official `@rezics/client` declarations, callable client and root exports for `readingInsightsOverviewSchema`, including
`readingInsightsCurrentProgressSchema`, and `library_reading_insights.overview` at `GET /v1/libraryReadingInsights`.
That installed publication is a prerequisite for the Web page and overflow destination; transport remains unavailable
until it exists. A local response type, declaration patch or substitute request cannot satisfy this boundary. The panel
is composed with the all-time/year summary, retained-profile distribution, current-progress and assessment panels by
that overview operation. The native receiver is delivered independently of the Web continuation.

## Coverage, installation and cleanup

The profile-distribution migration installs synchronous native source receiving and empty derived tables with a fast constant-default
`reading_insights_initialized=false` column; it performs no history scan. New sessions receive immediately.
An old session receives only through an addressed mutation or the installed shelf maintenance backfill's existing
100-row sessions phase. Receiving uses the existing native changed row operands, without a generic event dependency.
New native sessions also retain a private descriptor snapshot for each supported primary or additional unit. The
snapshot includes the full accepting profile pin, dimension, precision, bounds, total policy, mode, identity and
structure, but no labels. Existing sessions have no such snapshot and remain unavailable for dimensional aggregation.

Availability requires the versioned installation marker, installed all-time source counter, ready/open initialized
shelf maintenance and equality of initialized and retained session counters. An owner with no retained sessions is
zero only with these installation premises. Otherwise the response contains no distribution values:

| State/reason                          | Meaning                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `unavailable/not_installed`           | Missing schema, marker or installed source counter; coverage is unknown/null   |
| `unavailable/initializing`            | Initialized and retained counters differ; their exact quantities are disclosed |
| `unavailable/maintenance_unavailable` | Maintenance or source installation is not ready/open                           |

Operators use the existing authorized `requestRebuild(...kind:'backfill'...)` port for finite installation and repair;
its existing run, epoch, sequence and cursor remain the only admission. The 100-row sessions phase addresses retained
native rows and invokes current-progress receiving in their existing transaction. A GET never schedules repair or
claims that it ran.

Receiving serializes each owner head and removes the old initialized contribution before adding the new one, in the
same source transaction. Correction across years, completion, retirement, restoration and deletion maintain exact
first/last Subject membership, group totals and top ordering. An unchanged membership only rotates generation.
Zero-count Subject/group/year rows disappear. Source removal of the last initialized session removes the owner
head. Existing bounded session erasure therefore pays cleanup without a new erasure phase or residual owner key.
The installation marker is global, contains no owner information and survives source truncation.

## Bounds and delivery evidence

The reader does not access session history or hydrate details. One statement snapshot addresses the installation,
all-time installation, owner, all-time owner and shelf-maintenance keys (at most five header rows), selected-year key,
eight ordered profile entries and one unknown key. The presentation set is at most ten counter rows. A final header
probe rechecks installation, coverage and both generations. Both current-account probes and the account share lock
are exact-key operations. A missing optional schema is isolated by a savepoint, and final authority is still checked.
Normal reads execute eight statements: BEGIN, account lock, account read, SAVEPOINT, snapshot, account read, header
recheck, COMMIT, with the savepoint rollback replacing the header check on absent schema (also eight).
No release/Semantic pool, own-vote table, row hydration or receipt is read by this panel. The result is capped at
16,384 UTF-8 bytes. Index seek blocks still grow logarithmically; a row cap alone is not a full physical-cost proof.

A changed source row performs at most two contribution transitions. Each transition has one owner upsert/update and
at most nine exact-key Subject/profile/year statements (three probes and at most six changes); old/new owners are
locked in stable order. Source deletion adds one empty-owner cleanup probe/delete. At most two support keys, two
profile keys and two year keys change. An unchanged membership performs one owner revision update. These are
additional costs inside the existing writer transaction, not a new receipt/dispatch authority. Lost-acknowledgement
reconciliation retains all original command identity, operands, deadlines and receipt costs; replay adds no receiving.
Existing all-time/year/shelf receivers, native account authorization, partition executor, locks, command receipts,
maintenance dispatch and all lifecycle child pages remain payable. Complete participating-pool/SQL-block/retention
cost evidence is deferred to the continuation and controller; it is not claimed by the local row bound.

The added native cases traverse real mounted writers and real source triggers for two accepting profiles, historical
unknowns, repeated completion, cross-year correction, original receipt replay, changed current release, retirement,
restoration, last-source cleanup, ranked remainder, partial initialization, bounded backfill and independent
64/512/4096 retained-source populations. No existing test or frozen acceptance is edited. The typed mounted producer
is in `reading-insights-routes.ts`; Content owns generated client/declaration/root-export publication. No generator,
raw-fetch Web adapter or handwritten client delivery is added. Installed client and rendered evidence remain pending.

Current progress is maintained per retained owner from each session's captured accepting descriptors and native
operands. Active sessions and abandoned backlog sessions are separate; completed and retired sessions are excluded.
Groups include the full accepted pin, meaning revision, mode, unit, dimension, precision, bounds, total policy,
identity, structure and cursor locator. Only equal meanings are summed, using PostgreSQL exact numeric arithmetic.
The response returns at most eight groups per scope and exact remainder coverage counts, without merging values from
different meanings or hydrating sessions. Older rows without accepted descriptors remain unsupported.

Retained rows enter the receiver only through native row changes or the existing addressed sessions phase. Each
replacement removes the previous contribution and adds the current one in the same transaction; receipt replay is
idempotent, source deletion removes the final owner projection, and owner generations invalidate stale reads. Native
and physical cost measurements remain controller-owned; the added statements and row work remain within the original
writer or admitted maintenance transaction and do not introduce a new scheduler, receipt or funding protocol.

`bun run --cwd services/kernel derived schema` succeeded and regenerated only the Library canonical schema.
`bun run --cwd services/kernel typecheck` failed with 301 diagnostics, identical to a clean clone of the bound
base after normalizing shifted line numbers; this increment adds zero diagnostics. Its first error is
`../../packages/client/src/index.ts(268,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.`
The base comparison used `bun run --cwd .temp/reading-insights-base/services/kernel typecheck` with the existing
approved check-host configuration; no compiler inputs or checks were suppressed.

`bun run --cwd services/kernel check test/library/reading-insights-profiles.test.ts` reached the test runner after
formatting was corrected, then failed during the unchanged Kernel/Search module import, before any fixture or test
case executed: `TypeError: undefined is not an object (evaluating 'viewerFactsResponseSchema.properties.rows')`,
at `src/search/discovery-http.ts:200:40`. Result: 0 pass, 1 fail, 1 import error. The new native assertions therefore
remain unexecuted; this is not a passing native check. Search source is identical to the bound base and the base
compiler diagnostics also include its schema-property failures. No unrelated Search file was changed.

References reviewed: `legacy-final:apps/web/features/library/reading-stats.tsx`,
`/home/edge/projects/rezics/rezics/apps/web/features/progress/components/unit-progress-statistics.tsx`, the named
reference INDEX, and current consumption-statistics/reported-year/progress-measure owner documents and producers.
This is new projection code, not a legacy source port. There are no product files outside the declared paths.
Remaining journey and validation are in `.temp/continuation/reading-insights.md`. Full/frozen acceptance, broad native
growth, root checks, installed client publication and browser/rendered review were not run and remain deferred.
