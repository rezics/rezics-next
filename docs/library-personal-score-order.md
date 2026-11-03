# Personal-score shelf ordering

Decision: use an atomic Library index of Content's native standard-question counted vote, with explicit bounded
installation and unavailable reads until Content supplies an owner-wide identity-currentness fence.

## Native interface and current availability

`GET /v1/libraryEntries?orderBy=personalScore&direction=asc|desc` retains the shelf's private owner, exact state/type
filters, BASIC/FULL behavior, default limit 20 and maximum 100. Existing lastActivity, finishedAt and createdAt modes
are unchanged. This order additionally needs the existing `rating:vote` scope used by Content's own-vote reader;
it grants no vote-writing operation. Entry-list and progress-list admission and current account/partition checks
still precede the RR read. Summary counts/facets retain their native counters; the order does not recalculate them.

A successful response adds `personalScore` (native integer units or null) to each entry and `scoreQuestion` to the
page: exact standard question ID, meaning, revision, grain, minimumUnits, maximumUnits, stepUnits and lifecycle
state/revision from `rating.question` and its lifecycle row. The question is selected by Content's
`STANDARD_QUESTION_ID`, never by label, arbitrary questions or imported summaries. Zero is rated. Display conversion
must use this descriptor; no hardcoded display scale is introduced. This shared question reader is exported from
`rating/personal-score.ts` for the independent viewer-facts consumer.

The default public personal-score read currently returns `503 dependency_unavailable`: Content's exact owner-wide
identity fence is not installed. No empty page, inferred currentness or viewer-facts response substitutes for it.
The internal native page/index producer is implemented; this does not claim a usable public score journey yet.
Web A05/A06 retain their existing interface owner and must show this unavailable state until native composition
binds `KernelDependencies.shelves.scoreCurrentness`. The existing kernel declaration producer now describes the new query literal, entry score, question descriptor and preparation route. Declaration/snapshot emission remains deferred because the unchanged base
`community/member-page-select.sql` fails the compiler with duplicate Reylo parameters.

## Stable keysets and currentness

The full stored Subject UUID is the tie key, ascending in both directions. Its route bytes are part of that exact
identity; no short ID, canonical relabeling, imported identity or resolved-title tie is used. The ascending tuple is
`(coalesce(units,4097), subject_id)`; descending uses `(coalesce(-units,1), subject_id)`. Native supported units are
0..4096. Both tuples are scanned ascending, placing every unrated entry after all rated entries in both directions.
Equal-score ties and unrated ties traverse by full UUID. A page selects at most limit+1 keys before joining Entries;
`next` exists only when the extra candidate exists. Active sessions enrich only the returned page.

The existing opaque expiring list codec binds owner, route, exact filters, direction, limit, shelf generation/epoch,
partition epoch, score-index generation/revision, exact question/meaning/revision/scale/lifecycle and Content's
currentness version. The seek contains exact native units (empty string for unrated) and full Subject UUID.
Malformed, expired, foreign or mismatched bindings are `invalid_cursor`; a changed partition epoch retains the
existing `stale_cursor` response. Refresh restarts the same query. No snapshot of historic score ordering is retained.

Every Entry write/removal/identity or lifecycle change and every native standard vote update, clear, deletion or
counted-target move changes the owner score revision in the same transaction as index maintenance. Question changes
are observed in the page's RR snapshot and change its binding. Content's `PersonalScoreCurrentness` port must return
`{status:'current',version}` only when the entire owner's Entry/vote identity effects are current in that same
snapshot, including entries outside this page. Its version must change before merge/lifecycle effects can stale
any ordering key. Pending/unavailable producer results are 503, never a successful page. A newly published semantic
redirect without Content's held reconciliation proof cannot be inferred current from `rating.vote` alone.

Content's installed counted-target contract gives a survivor's vote or clear precedence; otherwise Content chooses
the merged source by its own change-time/full-ID tie rules. Library observes only the resulting unique native
`(route,voter,question,counted_target)` row. It never selects a different merge winner or writes a vote. Stored Entry
identities remain intact: an original whose vote stops counting there becomes unrated; a matching surviving Entry
uses the vote that now counts there. The viewer-facts overlay is a sibling consumer, not this fence's producer.

## Installation and atomic maintenance

The migration creates an initially empty `library.shelf_score` and owner head, installs triggers on Entry and native
votes and creates eight expression indexes: each direction with no filter, state, type, or state+type. Installing
DDL does not scan/backfill personal shelves. An exact Entry foreign key cascades deletion and identity changes.

`POST /v1/libraryShelfScorePreparation` is an owner-authorized command under the existing personal Library admission,
write-rate payer and native command/receipt machinery. It takes the existing Idempotency-Key header. Each new key
advances one installation page, returning `{installation:'pending'|'installed',prepared:0..100}`. Replaying a key
replays that page's receipt; use a new key to advance. Installation status describes the access path only, not
Content currentness or public order availability. There is no successful empty-ready substitute for a nonempty shelf.

Under one owner-head lock the command reads at most 101 native Entry keys, copies at most 100 state/type placements
and exact counted-vote units, advances its full-UUID checkpoint and marks installed only after exhaustion. First and
continuation statements are separate indexed ranges. New/changed entries behind the checkpoint are maintained by
the triggers. Interrupted/rolled-back pages publish neither checkpoint nor partial readiness; receipt replay is
idempotent. The GET only probes the head and never prepares or backfills scores. Reinstallation is unnecessary for
ordinary writes. A missing head starts pending, including after erasure; a fresh generation prevents cursor ABA.

Entry and standard-vote BEFORE triggers acquire/update the same owner head, even when no Entry exists yet. AFTER
triggers read the native counted vote and upsert the private index. This closes the first-Entry/concurrent-vote race.
An Entry insert/update needs one exact vote lookup and one index-row upsert. A standard-vote insert/update/clear/delete
needs at most two exact Entry/vote probes and index upserts for old/new counted identities. Arbitrary-question votes
perform no score-head/index work. Native merge pages retain Content's 100-voter bound; each changed row incurs these
same constant-number probes. Changing source owner keys may acquire two owner locks; native deadlock/serialization
retries retain their existing finite command deadline/budget. No external callback, cross-partition fanout, extra
vote writer, reservation, repair worker or GET receipt is added.

Entry deletion cascades its index row atomically. Terminal Library fact purge therefore removes score placements;
the appended `shelf_score_head` owned-erasure phase removes the one owner installation/version row after private
facts. Vote deletion only touches an existing head; terminal vote cleanup cannot recreate a deleted head.
Numeric checkpoints of existing phases remain unchanged. Account fencing and question lifecycle facts are
checked by the existing readers and currentness producer; stored scores confer no account or Subject permission.

## Derived cost and remaining proof

Let K<=100, N be all Entries/index placements, V all native votes, S the owner's shelf and H all owner heads.
A fixed-filter page makes one B-tree descent and reads <=K+1 index candidates, then <=K+1 exact Entry lookups and
<=K active-session probes: logical work O(log N + K log N + K log sessions), with O(K) serialization for BASIC.
The RR owner/current-generation, question, head and Content-currentness checks are additional authority work; the
Content port's whole-caller bounds remain unavailable until its native producer lands. FULL additionally pays the
existing bounded summary/disclosure calls. No cost claim omits that producer or treats its callback as free.

Installation has ceil(S/100) nonempty pages plus at most one exhaustion page: each reads <=101 keys, performs <=100
vote lookups O(log V) and index upserts (one PK and eight ordering indexes), and writes one checkpoint/receipt.
An Entry or vote effect pays O(log H) head work (plus an exact account-state probe before creating a vote head), <=2 exact source probes and <=2 placement upserts with nine index
updates each; delete additionally pays the existing FK check/cascade. Merge cost is linear in actual changed native
vote rows, not all unrelated shelves. Hot owners serialize; waiting, native retries, command authorization/receipt,
existing shelf gate and outbox/cleanup costs are part of the existing caller budgets, not a blanket reservation.

Unrelated shelf/vote populations change B-tree height, not the number of visited logical candidates. Invalid/expired
cursors still pay admission, question/head/currentness and bounded token decoding but select no page; preparation
and merge never run in that path. Erasure removes a placement per actual deleted Entry and one final head row.
These are derived seek/write bounds, not native EXPLAIN, buffer, lock-wait or growth measurements. Fixed-K increasing
unrelated shelf/vote populations, all nested authority/cleanup/retry costs and actual Content merge execution remain
the controller's native gate. Focused tests do not establish those measurements.

Research inspected: `legacy-final:apps/web/features/library/state.ts`; pinned BookWyrm
`bookwyrm/views/shelf/shelf.py` (owner rating and server sorting); pinned Bangumi
`internal/collections/infra/mysql_repo.go` (owner-specific collection rating). Preserve server ordering and the
highest-score initial direction; do not import those architectures or their public/default privacy assumptions.
