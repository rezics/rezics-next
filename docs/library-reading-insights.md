# Private reading insights

This owner document covers the retained-profile distribution projection. The complete private insights journey
also needs current unit quantities, assessment coverage, composed viewer/actions and the reachable Web page;
those outcomes are not installed by this increment. Existing all-time/year counts, month navigation, journals,
assessment writers and diary allocation remain authoritative and unchanged.

Decision: Group historical completions by the entire immutable accepting profile pin, including release and accepting
Type; show profile identity with historical labels unavailable until accepted descriptors are retained, never infer books
or episodes from a current Type or a profile ID. Pins exceeding 1,024 encoded bytes join historical-unavailable coverage.

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

## Coverage, installation and cleanup

The migration installs synchronous native source receiving and empty derived tables with a fast constant-default
`reading_insights_initialized=false` column; it performs no history scan. New sessions receive immediately.
An old session receives only through an addressed mutation or the installed shelf maintenance backfill's existing
100-row sessions phase. Receiving uses the existing native changed row operands, without a generic event dependency.

Availability requires the versioned installation marker, installed all-time source counter, ready/open initialized
shelf maintenance and equality of initialized and retained session counters. An owner with no retained sessions is
zero only with these installation premises. Otherwise the response contains no distribution values:

| State/reason | Meaning |
| --- | --- |
| `unavailable/not_installed` | Missing schema, marker or installed source counter; coverage is unknown/null |
| `unavailable/initializing` | Initialized and retained counters differ; their exact quantities are disclosed |
| `unavailable/maintenance_unavailable` | Maintenance or source installation is not ready/open |

An explicit finite funded retained-owner installation schedule has not yet been delivered. Operators may use the
existing authorized `requestRebuild(...kind:'backfill'...)` port; a GET never schedules it or claims that it ran.
The continuation must supply the finite schedule and native work-cost evidence before claiming complete deployment.

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

Validation commands and actual outcomes will be recorded below after the required focused run. Full/frozen
acceptance, broad native growth, root checks and browser review remain with integration.
