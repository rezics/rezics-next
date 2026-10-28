# Simplifying private follower counts

Research date: 2026-10-28. This report is evidence for adoption, not a replacement authority for
[private-follow-counts.md](../private-follow-counts.md). No runtime, frozen specification or test binding is changed.

## Recommendation

Use a small Library projection: a current contribution per follower/original-target pair, an ordinary PostgreSQL
counter beside the target, and existing transactional outbox/DBOS delivery. Use a per-pair bigint revision for
idempotent replacement, bounded account-state fan-out, and the Library terminal-erasure participant for withdrawals.
Check authorization on every HTTP request. Treat freshness as an operational queue-age bound, not proof that every
source account is simultaneously current. Remove the prerequisite for a universal observation/coverage protocol.

Some bookkeeping remains necessary: outbox enqueue is not effect completion, duplicate delivery is not exactly-once
application, and an empty counter row is not evidence of a completed initial build. These require local SQL
transactions and durable work records; they do not require shared coverage generations or partition-position ordering.
The simplest design still needs an ordering scalar **per edge**, not an account generation or a distributed epoch.

## Survey: twenty products

The table distinguishes documented behavior from inference. **Unpublished** means the cited primary sources do not
establish a guarantee; it does not mean exclusion never happens. An analytics reporting interval is not a guaranteed
deadline for removing an individual deleted account. A live UI is not evidence of a particular storage algorithm.
Sources are official help/API documentation, operator-owned product pages, and the pinned source listed below.

| Product             | Who sees the count                                                                                                                                                                              | Published freshness                                                                                                                                                                                       | Suspended/deleted followers and exclusion delay                                                                                                                                                                                       | Published maintenance evidence                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X                   | Owner and profile viewers see follower totals.                                                                                                                                                  | No bounded update SLA in [following help](https://help.x.com/en/using-x/common-following-issues).                                                                                                         | [Locked accounts were removed from counts](https://blog.x.com/official/en_us/topics/company/2018/Confidence-in-Follower-Counts.html); help mentions spam/deactivation discrepancies. No general suspension/deletion removal deadline. | Operator describes legitimacy filtering and a historical rollout, not its counter implementation.                                                                                                                                                                                                                                     |
| Instagram           | Owner can obtain `followers_count`; profile totals are also a public product surface.                                                                                                           | No verified numeric SLA in inspected primary material.                                                                                                                                                    | Meta describes [removing inauthentic activity](https://about.fb.com/news/2019/04/preventing-inauthentic-behavior-on-instagram/amp/). Universal suspended/deleted-account exclusion and delay are unpublished.                         | Official SDK exposes the scalar in `src/objects/ig-user.js` ([pinned source][meta-ig]); no counter algorithm. Help Center returned 429; no secondary site's claimed daily cadence is adopted.                                                                                                                                         |
| YouTube             | Owner sees exact Studio live count; public totals are shortened, e.g. 1,234 becomes 1.23K.                                                                                                      | Owner [Realtime / See Live Count](https://support.google.com/youtube/answer/6051134?co=GENIE.Platform%3DDesktop&gad=1); no seconds SLA.                                                                   | Closed accounts, including policy terminations/suspensions, and identified spam do not count. Verification is regular; no removal deadline.                                                                                           | [Subscriber help](https://support.google.com/youtube/answer/7280745) distinguishes the subscription edge from count eligibility: spam may remain subscribed without counting.                                                                                                                                                         |
| Twitch              | Broadcaster/moderator can see follower identities with scope; other authorized API clients can obtain total alone.                                                                              | [API total](https://dev.twitch.tv/docs/api/reference/#get-channel-followers) may change during pagination; no SLA.                                                                                        | [Botting policy](https://help.twitch.tv/s/article/how-to-handle-view-follow-bots?language=en_US) describes investigation; exclusion semantics/timing for all suspended/deleted users are unpublished.                                 | Separate `total` from identity-bearing `data`; backend maintenance unpublished.                                                                                                                                                                                                                                                       |
| Substack            | Publication administrators see subscribers; [creator stats](https://support.substack.com/hc/en-us/articles/19291693034004-Getting-started-on-the-Substack-app) are visible only to the creator. | Dashboard cadence unpublished.                                                                                                                                                                            | General suspension/deletion exclusion and delay unpublished. Subscriber removal is available.                                                                                                                                         | [Dashboard definitions](https://support.substack.com/hc/en-us/articles/360058529871-How-do-I-use-the-subscriber-dashboard-on-Substack): subscribers include free/paid; publication followers combine unique admin followers and subscribers. Population definition matters.                                                           |
| Patreon             | Creator's membership dashboard; optional public membership visibility.                                                                                                                          | [Membership Insights](https://support.patreon.com/hc/en-us/articles/33687045078797-Membership-Insights) updates every four hours.                                                                         | Free cancellation is immediate; paid cancellation is recorded at access expiry. General suspension/deletion timing unpublished.                                                                                                       | [Paid-count definition](https://support.patreon.com/hc/en-us/articles/360024354572-How-do-I-find-my-paid-member-count) includes retrying payments, trials, gifts and canceled members with remaining access. Not simply payment success.                                                                                              |
| Medium              | Author's Audience stats and profile-facing follower total.                                                                                                                                      | [Audience stats](https://help.medium.com/hc/en-us/articles/4405449973015-Audience-stats) daily; profile is described as more current, without SLA.                                                        | Audience excludes deactivated/deleted/suspended users; daily reporting does not promise an individual removal deadline.                                                                                                               | Different surfaces have different refresh schedules; underlying storage unpublished.                                                                                                                                                                                                                                                  |
| LinkedIn Pages      | Page admins see follower analytics; public Page total is another surface.                                                                                                                       | [Follower highlights](https://www.linkedin.com/help/linkedin/answer/a566452) total updated daily. Some breakdowns are approximately rounded.                                                              | Restricted/hibernated accounts excluded; [regular filtering](https://www.linkedin.com/help/linkedin/answer/a1421099) has no individual deadline. Deleted-account timing not separately specified.                                     | Explicit eligibility filtering, no backend counter algorithm.                                                                                                                                                                                                                                                                         |
| Facebook Pages      | Page owners see Insights; profile/Page viewers can also see public totals.                                                                                                                      | No follower-total SLA established by inspected material.                                                                                                                                                  | General suspended/deleted follower exclusion/timing unpublished in these sources; do not substitute Page-like removal policy.                                                                                                         | Meta's [Page Insights announcement](https://about.fb.com/news/2017/06/better-understand-interactions/amp/) distinguishes total follows, gains/losses, demographics and acquisition source; SDK exposes `page.followers_count` ([source][meta-page]).                                                                                  |
| GitHub              | Owner and public profile viewers, subject to private-profile visibility.                                                                                                                        | No SLA in [following help](https://docs.github.com/en/get-started/exploring-projects-on-github/following-people).                                                                                         | General exclusion policy and removal deadline unpublished in inspected docs.                                                                                                                                                          | [Authenticated user API](https://docs.github.com/en/rest/users/users) exposes `followers`; private-profile counts may differ from anonymous responses. Storage unpublished.                                                                                                                                                           |
| Mastodon            | Account entity exposes reported totals, including to owner; hiding collections is separate.                                                                                                     | No federation-wide SLA. Local follow callbacks update counters synchronously in inspected source.                                                                                                         | Remote-account suspension can destroy outgoing follows in batches. The inspected suspension path does not establish universal exclusion of local suspended followers. Deletion cleanup exists; no time SLA.                           | [Account API](https://docs.joinmastodon.org/entities/Account/), `Follow` create/destroy callbacks and SQL upsert arithmetic in `Account::Counters` ([source inventory below][mast-follow]).                                                                                                                                           |
| Bluesky             | Owner and public AppView profile readers.                                                                                                                                                       | AppView indexing plus background aggregate work; no published seconds SLA.                                                                                                                                | Inspected follow aggregate counts indexed follow rows without an eligibility predicate. Account-state processing is separate; universal suspended/deleted exclusion and deadline are not established here.                            | `profileViewDetailed.followersCount`, `follow.ts` recomputation and `processor.ts` on-commit background scheduling ([source][bsky-follow]). Do not infer production guarantees from the reference implementation.                                                                                                                     |
| Spotify for Artists | Artist/team sees total; [individual follower names are unavailable](https://support.spotify.com/us/artists/article/understanding-your-listener-and-follower-stats/).                            | [Stats update daily](https://support.spotify.com/us/artists/article/when-stats-update/), approximately 5 PM ET / 9 PM UTC as documented. Two-second new-release **stream** counts are a different metric. | General suspended/deleted follower exclusion and delay unpublished.                                                                                                                                                                   | Aggregate audience reporting; maintenance algorithm unpublished. Particularly close disclosure precedent for REZICS.                                                                                                                                                                                                                  |
| Reddit              | Moderators currently see member count in Mod Insights; public surfaces have moved toward activity metrics.                                                                                      | [Mod Insights](https://support.reddithelp.com/hc/en-us/articles/15484468824980-Mod-Insights) provides time-window membership growth, without a count SLA.                                                 | Current docs do not establish deletion/suspension subtraction or timing.                                                                                                                                                              | [2026 explanation](https://support.reddithelp.com/hc/en-us/articles/41043361207316-Understanding-weekly-visitors-and-contributions-on-Reddit) says old member count included users who joined but no longer visited; member count remains in Mod Insights for now and is planned for removal. Do not equate inactivity with deletion. |
| Discord             | Owner and holders of View Server Insights see analytics; guild/member surfaces have other access rules.                                                                                         | [Server Insights](https://support.discord.com/hc/en-us/articles/360032807371-Server-Insights-FAQ) is one day behind; only completed reporting intervals.                                                  | General disabled/deleted-member subtraction and deadline unpublished there.                                                                                                                                                           | Aggregated/anonymized insights, opt-out, small-bucket suppression. [Guild API](https://docs.discord.com/developers/resources/guild) separately labels approximate member counts; no backend algorithm.                                                                                                                                |
| Goodreads           | Author and readers can see author follower totals.                                                                                                                                              | Unpublished.                                                                                                                                                                                              | Suspension/deletion exclusion and delay unpublished.                                                                                                                                                                                  | Official [author listing](https://www.goodreads.com/author/on_goodreads) renders follower counts; [author resources](https://www.goodreads.com/author/how_to) describe owner dashboard stats, without explaining counter maintenance.                                                                                                 |
| Letterboxd          | Owner and visitors see profile follower total.                                                                                                                                                  | Unpublished.                                                                                                                                                                                              | [Blocking](https://letterboxd.com/faq/) terminates follows in both directions. General suspension/deletion count timing unpublished.                                                                                                  | Operator's [own profile](https://letterboxd.com/crew/) renders the scalar. Backend unpublished; do not infer its database from the UI.                                                                                                                                                                                                |
| Pinterest           | Owner sees followers under profile; audience visibility follows profile privacy.                                                                                                                | Unpublished.                                                                                                                                                                                              | General suspended/deleted-user subtraction and timing unpublished.                                                                                                                                                                    | [Definition](https://help.pinterest.com/en/article/following-and-followers) counts a person once even when following multiple boards. Owner can remove followers; no published backend algorithm.                                                                                                                                     |
| Steam               | Developer account sees game followers as hidden game-group members on Manage Members.                                                                                                           | Unpublished.                                                                                                                                                                                              | General suspended/deleted follower exclusion and timing unpublished.                                                                                                                                                                  | [Steamworks](https://partner.steamgames.com/doc/marketing/followers?l=english&language=english) explicitly maps Follow to group membership; it does not specify storage or a public counter SLA.                                                                                                                                      |
| Ko-fi               | Owner and profile visitors can see follower total, abbreviated at large sizes.                                                                                                                  | Unpublished.                                                                                                                                                                                              | [Blocking/removal](https://help.ko-fi.com/hc/en-us/articles/360003617677-Blocking-and-limiting-users-on-Ko-fi) removes a follower; general suspension/deletion deadline unpublished.                                                  | Operator's [own page](https://ko-fi.com/supportkofi?action=posts) renders a total. No backend algorithm published.                                                                                                                                                                                                                    |

Shared patterns: define the population separately from its display; separate totals from identities and management;
allow analytics lag; remove ineligible populations through maintenance; deduplicate people rather than counting every
relationship occurrence. Only two surveyed open implementations expose concrete counter code here. Neither establishes
a need for REZICS's proposed generic coverage-certificate protocol. This is an inference from the inspected evidence,
not proof about twenty proprietary backends. The brief's 60-second/5-minute rules are REZICS decisions, not borrowed SLAs.

## Source evidence, custody and licences

Reference paths below are under `/home/edge/projects/rezics/rezics-next/.reference/`. Existing clones were reused;
new clones are shallow. Nothing from them was installed, built or executed. Their lines are recorded in `INDEX.md`.
Web documentation is cited for facts, not offered as implementation code. No code or long passage is proposed for copying.

| Project, pinned commit                                       | Local files read and corresponding upstream evidence                                                                                                                                                                                                                                                      | Licence                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Mastodon `f943e0583be804bb062e5c9a4f8e65e2a05e5346`          | `follow-counts/mastodon/app/models/follow.rb`, `app/models/concerns/account/counters.rb`, `app/models/account_stat.rb`, `app/services/suspend_account_service.rb`, `app/services/delete_account_service.rb`; [follow callbacks][mast-follow], [SQL arithmetic][mast-counters], [suspension][mast-suspend] | AGPL-3.0, `LICENSE`; preserve upstream obligations if ever copying.                                                         |
| atproto `6ed6fe39dded20f1e8995042135fba83b31d7b26`           | `viewer-actions/atproto/packages/bsky/src/data-plane/server/indexing/plugins/follow.ts`, sibling `indexing/processor.ts`, `db/tables/profile-agg.ts`, `packages/api/lexicons/app/bsky/actor/defs.json`; [recount][bsky-follow], [background scheduling][bsky-processor]                                   | MIT OR Apache-2.0, `LICENSE.txt`, `LICENSE-MIT.txt`, `LICENSE-APACHE.txt`.                                                  |
| Meta Business SDK `0d245ec888c1af38d68994fd7f2e24cd38abc82f` | `follow-counts/meta-business-sdk/src/objects/ig-user.js`, `src/objects/page.js`, `LICENSE`; [Instagram field][meta-ig], [Page field][meta-page]                                                                                                                                                           | Custom Meta licence limited to Facebook web services/APIs; read for interface evidence, not a REZICS implementation source. |
| DBOS TypeScript `980dc55095f445b189aecb59e7f3334345179f65`   | `search-worker-outcome-harness/dbos-transact-ts/src/wfqueue.ts`, `LICENSE`; [queue implementation][dbos-source], [official queue documentation](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)                                                                                                | MIT. Queue partition concurrency is a scheduling facility, not a source-state ordering certificate.                         |
| PostgreSQL `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`        | Reused `library-shelf-maintenance/postgres/COPYRIGHT`; mechanism evidence is official [row locks](https://www.postgresql.org/docs/current/explicit-locking.html) and [ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html) documentation.                                                | PostgreSQL License.                                                                                                         |

Repository evidence: `services/kernel/src/library/follows.ts` routes explicit, membership and entry-implied writes
through `follow-store.ts` / `follow-store-apply.sql`. The migration
`services/kernel/db/library/migrations/20261025164145_library_follows.sql` keys rows by follower route/account/target,
keeps explicit-unfollow tombstones and has an account-leading page index. It has no incoming index or comparable edge
revision. The private follow event contains only `targetId`; it cannot safely mean `+1`.

`services/kernel/src/command/command.ts` commits domain changes with receipts/outbox and partition advancement.
`services/kernel/src/events/effects.ts` supplies deterministic workflow IDs, release-before-delivery and retried effect
steps; `work/queues.ts` sets effects partition concurrency to one. Neither proves that effects have finished, and
sorting enqueue does not protect arbitrary delayed application. Keep those engines; add Library SQL, not another engine.

## Concrete proposed design

### Storage and ordinary writes

1. Keep `library.follow` and its intent precedence unchanged. Add a source-side current delivery row keyed exactly
   like the follow: original target type/id, bigint `revision`, desired eligibility, and oldest uncompleted change time.
   Every changed follow path updates it **in the source command transaction** and emits the existing private invalidation.
   An explicit unfollow remains a negative even after implied follow. No-op/replayed commands do not advance counters.
2. Eligibility means `following AND account.active AND NOT account.fenced`. A source reconciliation command reads
   account and follow under the existing account writer barrier. If desired eligibility changed, increment that pair's
   revision and leave pending work. Revisions survive partition moves as row data; source timestamps and transaction
   UUIDs are never compared for ordering. The revision is not an account generation, authentication epoch or permission.
3. In the original target's partition store `follow_contribution(targetType, originalTargetId, followerAccountId,
   revision, eligible)` with a unique pair key and a target-leading positive-page index. Also keep a bigint total per
   original target. The native target command locks/creates the pair, accepts only a higher revision and changes the
   total by `newEligible-oldEligible` in the same transaction. Equal identical is no-op; equal conflicting is an error;
   older is no-op. Negative rows order delayed positives, including a negative first application. Do not retain history.
   Index count-owned payloads/work by follower account for bounded erasure; source maintenance can seek the existing
   `(route, account_id, target_id)` primary key without using the outgoing page's mutable timestamp order.
4. DBOS effects are wake-ups. Each attempt obtains **current** source desired state before sending a replacement;
   it never replays a stored `+1`. Recheck eligibility even for a positive first application. Release the source client
   before the target command. An acknowledged revision clears pending state only if it is still the source row's
   current revision; otherwise newer work remains pending. A crash after target commit simply retries the same revision.
   Store acknowledgements/current work in SQL, not solely in a completed DBOS step's saved result.
5. Keep contribution rows for ordinary subjects too, as a private derived index: a subject may later become an account
   agent through verification. This deliberately replaces the old restriction against an unowned-subject inverse.
   It grants nobody a count or identity list. Collection/Space counters live with their original target, not their
   current manager; transferring management changes authorization, not the counter's custody.

No cross-partition transaction is needed. A source change after reconciliation can temporarily leave an old eligible
contribution, within the agreed maintenance budget. This is exactly the stronger instantaneous coverage guarantee being
removed. Monotonic SQL replacement is retained locally; generic released-source validation and epoch/position adapters
are not prerequisites. Native routing still rejects moved/fenced partitions; bigint revision overflow fails readiness.

### Account state, erasure and replay

Every active/suspended/fenced/terminal account transition must record an account maintenance item in the **same native
transaction** as its state/outbox change. This is a required producer hook, not an ability already provided by an
asynchronous effect. Its first-change timestamp must survive retries and repeated invalidations. Suspension/reactivation
pages that account's own follows in stable target-id order, at most 100 rows per page, reconciling each current pair.
Each page reconciles its source pairs and advances the cursor in **one source transaction under that barrier**;
target delivery happens afterward. Carry the account item's oldest change time into pending pair work, rather than
starting its age when the page happens to run. Account-page completion does not acknowledge target delivery.
Changing state resets the cursor under the same barrier; there is no later asynchronous page acknowledgement that
can overwrite that reset, including active/suspended/active transitions. Follow writes behind an advanced cursor have
their own pending pair work. Do not use the outgoing page's mutable `updatedAt` ordering for a maintenance sweep.
No account-generation counter is needed.

Deletion uses the existing terminal erasure workflow's **Library participant**, not a second independent purge workflow.
On each Library page, first arrange target withdrawal, then remove that page's follow/delivery records, including
unfollow tombstones. The source page remains durable until target acknowledgement; do not advance its cursor earlier.
There is no extra recount of the account's entire Library and no scan of all accounts or partitions. Work grows only
with its own rows. Redelivery resumes indexed pages immediately, without delaying the deletion response for exhaustion.

Before removing a deleted follower's pair evidence in a target partition, the target transaction installs a minimal
`terminal_follower(accountId)` fence and withdraws/deletes its contributions. Every ordinary apply, including a negative,
checks this fence in that transaction and drops fenced work without creating private evidence. The Library purge
command can still remove that account's existing pairs and adjust totals. Serialize fence installation and applies
with a target-local account lock, so even a first apply
cannot pass an absent-fence check concurrently with purge. The fence contains no target id, count, cursor or follow
history and may cover multiple targets in that partition. Its source is terminal Access evidence; it is not a generation.
This extra payload-free tombstone is necessary: source rereading alone cannot stop a packet already in transit from
arriving after source evidence is erased. Never delete the fence merely because workflow history has expired.

Erase count-owned staging, receipts, checkpoints and DBOS argument/result payloads through account-leading locators,
including terminal errors and parked work, before acknowledging Library completion. Old test captures are handles to
revoked work, never a bypass around production admission. Shared outbox/receipt/DBOS owners must provide deletion or
payload-minimization custody; the current age-based workflow GC is insufficient. Completion must name any outstanding
shared custody instead of claiming physical erasure. This is concrete participant integration work, not an assumed
already-working shared erasure API. No positive contribution can be recreated after the target terminal fence commits.

### Readiness without coverage certificates

Use a conservative **service-wide count-maintenance health gate**. Fine-grained readiness per target would require
discovering as-yet-undelivered followers and adds machinery that the brief does not need. An unrelated broken count
job may therefore cause a 503 for an otherwise current target; the cost is availability, not disclosure or wrong totals.

The durable source work table is the truth for unfinished work, including work not yet relayed, running DBOS jobs,
failed/exhausted retries and unfinished state/erasure pages. Coalescing preserves the oldest uncompleted timestamp;
a worker lease, retry or fresh heartbeat never resets it. Target acknowledgement is required for completion. Index
pending work by oldest change time. Sample the oldest item and sampling time per installed source partition, including
idle partitions. Treat missing/unreachable samples as unready. A relay's enqueue checkpoint alone is insufficient.

For sample time `s` and oldest pending change `o`, a conservative lag upper bound at request time `t` is
`max(t-s, t-o)`; absent pending work contributes only `t-s`. Add bounded clock skew and the maximum 5-second source
transaction duration, so an uncommitted writer cannot disappear across a sampling snapshot. Use authoritative database
time, reject an unbounded/unknown skew, and expire samples. Reduce the per-partition bounds using a fixed topology
health tree (minimum sampling time / oldest pending time), updated in bounded parent steps, never a scan during a count
read. A parent must expire with its oldest child; it cannot issue a newer timestamp on an old child's behalf.
This is ordinary queue-age monitoring; it permits lag and proves no instantaneous population or permission fact.

Run dispatch/health sampling at most every 10 seconds and provision/measure end-to-end completion within 60 seconds
under healthy supported load, including account fan-out. Alert on 60-second violations; do not redefine healthy by
recent worker activity. The 60-second SLO needs capacity testing against large accounts, not merely a timer interval.
Return retryable `503 dependency_unavailable` when the conservative bound exceeds 300 seconds, health is unknown,
Access is unavailable, bootstrap is incomplete, routing fails, or the counter overflows the safe integer DTO. Supply
`Retry-After`; no count field. A completed, initialized zero is zero; a missing row is not automatically zero.

This needs a small operational health reducer and SQL work indexes, explicitly not yet built. It does not need
per-target coverage certificates, publication generations, immediate cross-partition invalidation or a shared compiler.
It must include all installed source partitions, even those with no previously observed followers of a target;
otherwise an unseen new follow could stay missing forever while a target falsely reported readiness.

### Identity and reads

Stored subject references stay unchanged. Resolve a requested subject in one step to the active terminal and verify
the current reciprocal account-agent binding with `readPublicAccountByAgent`. Obtain its bounded identity group,
at most 4,096 originals. Count **distinct follower accounts having any eligible original edge in that group**;
following two merged originals contributes one. An explicit unfollow of one original does not remove a separate
following edge to another original. Authorize against the terminal's actual account; retain the requested original
`targetId` in the DTO. Other subjects still conceal counts, regardless of their authors/editors.

This case **can arise** for counted subjects. `services/kernel/src/semantic/merges.ts` rejects ordinary account-agent
merges, but `semantic/account-agents.ts:verifyAccountAgent` explicitly merges the derived agent into a catalogue
survivor using `allowAccountAgent: true`. Old follows may name that derived original, while later follows name the
catalogue terminal. Verification reversal also exists; read the current group/binding rather than permanently assigning
follows to an account. The ordinary-merge prohibition does not justify assuming the group always has one member.

For a Collection, Space or singleton subject group, read the maintained original total in the owner's partition.
For a multi-original subject group, merge target-leading eligible follower pages in follower-id order, deduplicating
internally; each original stays in its own native target partition. Use at most 100 rows per fetch and bounded parallelism,
not one connection per original. Buffer at most one page per original, with a heap of current follower ids.
This avoids relocating references or a second canonical-group projection. No follower
identity leaves the kernel. Verify unchanged group/binding at completion and the health gate at start/end; an unstable
identity or incomplete/deadline-limited union returns 503, never a partial total. A read uses the normal 5-second bound.
Large groups may need a later measured optimization; do not quietly sum original totals, which double-counts people.

Keep the existing route/closed DTO, authentication, `follow:list`, exposure gate, one ordinary target management check,
concealed 404s and `private, no-store`. Resolve account-agent self against the actual account id, never the subject id.
The permission formula remains actor grant AND consented scope AND delegated principal grant, with current evidence
and denials. Group/index/revision/health metadata supply no grant. A revoked manager loses access on the next request
even if the count projection has not changed. Native target visibility is checked before returning any number.

### Cost bounds and operational limits

Let `A` be that follower's own stored follow rows; `K <= 4096` the requested target's originals; `E` the eligible
follower/original pairs belonging to those originals; `D <= 4096` installed physical partitions; `B` B-tree probe depth.
Let `H` be that account's own retained private work/receipt payload rows requiring erasure.
Index depth may rise logarithmically with table size; no operation enumerates unrelated rows. These are work bounds,
not promises of constant elapsed time under contention. The health tree has bounded fan-out/depth and fixed topology.

| Operation                  | Bound and locality                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Follow                     | O(B) source pair/work updates plus O(B) target pair/counter replacement; constant rows and messages, including implied paths. Retry is the same bounded replacement.                                               |
| Unfollow                   | Same O(B); preserve current source negative and target ordering row, decrement at most once. No follower or target-wide recount.                                                                                   |
| Account suspend/reactivate | O(B) admission/work item; O(A B) eventual reconciliation, pages <=100, segments <=100 pages. Reset/retry may repeat own work, never unrelated accounts.                                                            |
| Account deletion           | O((A+H) B) total Library participant withdrawals/evidence erasure; no extra account-wide count pass. Target fences are O(min(A,D)) payload-free account rows, not an account generation.                           |
| Count read, K=1            | O(B), constant count rows, one management evaluation (zero for resolved account self), two constant-size health reads; independent of followers/history.                                                           |
| Count read, K>1            | O((K+ceil(E/100)) B + E log K) work, including keyset page probes; O(100 K) buffered identities and bounded connections. Only that target's group/population grows the work. Five-second expiry returns readiness. |
| Health sample/update       | Indexed oldest pending probe O(B) in one source partition, O(log D) bounded parent updates; request reads root metadata only. No per-count all-partition polling or account scan.                                  |

Storage is O(current source and target pairs), with no transition history; terminal evidence is payload-free.
Keep native bigints in storage, decimal strings in durable JSON, safe integers in responses; pages <=100, segments
<=100 pages, commands <=5000 ms, continuations <=8 scalars/2048 JSON bytes, workflow arguments/results <=4096 bytes.
Bootstrap is a one-time bounded installation/backfill with count readiness closed; enable all source writers before
backfilling, compare per-pair revisions on application, and open only after backfill and its pending work drain.
Never promise a numeric zero for a preexisting target before that point. Newly created targets initialize totals in
their native transaction. A new partition enters the health topology unready before accepting count-affecting writes.

## Per-persona acceptance outcomes

| Persona / transition                        | Required result                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Collection curator                          | 200, target scalar only, after native visibility and `collection:update`; no identities.                                                                                                                                                                                 |
| Delegated manager / Space management role   | 200 only if ordinary Access including consent and principal grant permits `collection:update`, `space:manage`, or resolved `account:manage`.                                                                                                                             |
| Revoked manager, same bearer                | Next request 404, irrespective of count readiness/revision; never a cached allow.                                                                                                                                                                                        |
| Account agent's own account                 | 200 after successful current agent resolution and ordinary admission; actual account equality bypasses management evaluation, not authentication/scopes.                                                                                                                 |
| Another account or staff without management | Concealed 404; owning an outgoing edge gives no incoming authority.                                                                                                                                                                                                      |
| Anonymous                                   | 401 `authentication_required`, no count; suspended requester gets 401 `invalid_credentials`.                                                                                                                                                                             |
| Active follower then suspended              | Edge remains stored; its contribution becomes zero within 60 seconds healthy, restoring on reactivation only if still following. Beyond five-minute maintenance lag, owner gets 503.                                                                                     |
| Follower then deleted                       | Authentication/private Library admission fails immediately; Library participant starts erasure immediately, withdraws contribution in bounded pages, fences replay and erases its payload. Aggregate subtraction follows the same 60-second SLO/5-minute readiness rule. |
| Ordinary unowned subject                    | Nobody gets target count; own outgoing page remains available. A private derived contribution is never management authority.                                                                                                                                             |

Interpretation recorded: immediate privacy reduction governs **disclosure authority**, including target/account visibility.
It does not require instantaneous scalar subtraction of every suspended/deleted follower across partitions. Such a
requirement would restore the stronger coverage protocol the brief asks to reconsider. Maintenance progress is never
a permission cache. Terminal erasure starts immediately but does not mean all physical pages finish in the deletion HTTP request.

## Exact adoption edits and frozen-suite implications

Do not edit frozen files in this research change. After adoption, the owning manager should authorize these edits:

| Section of `docs/private-follow-counts.md`   | Keep / replace / remove                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current truth / inspected boundaries         | Keep existing behavior; replace the missing comparable-position prerequisite with the new per-edge revision/work rows, explicitly marking them proposed until implemented.                                                                                                                                                                                                                                                                                          |
| Disclosure authority                         | Keep in full, including actual account resolution, management grants on private Collections, live Access and no staff shortcut. Add merged-group distinct-account semantics and verification/reversal case above.                                                                                                                                                                                                                                                   |
| Bounded HTTP contract                        | Keep route, DTOs, scopes/gate/authentication, concealment, no-store, safe integers and public exclusion. Replace exact coverage wording with healthy <=60 seconds, conservative >300-second/unknown-lag 503 plus Retry-After.                                                                                                                                                                                                                                       |
| Own outgoing count                           | Keep the frozen route and same-transaction own live counter to preserve the existing binding; it does not wait for incoming delivery. Existing outgoing page remains unchanged. No new account selector.                                                                                                                                                                                                                                                            |
| Shared protocol inventory / adapter boundary | Remove it as a shared-kernel prerequisite and remove RR observation certificates, epoch/position payload comparison, complete coverage generations and immediate source-state invalidation. Replace with the local schema/apply/queue-age algorithm above. Keep atomic pair/total writes, replay safety, release-before-target and bounded pages. Replace the prohibition on ordinary-subject private inverse rows and constant-work merged-group reads explicitly. |
| Terminal deletion / minimization             | Keep terminal event, immediate admission hiding, immediate bounded work, no restoration/generation, private erasure and evidence custody. Replace independent count purge ownership with Library participant integration; specify target-local payload-free terminal fences and page ack before source deletion.                                                                                                                                                    |
| Runtime slices / verification                | Replace universal-protocol-first dependency with source SQL/writer hooks, target SQL/effects, health/Library erasure integration, HTTP and native evidence slices. Keep real Auth/Access, native fixtures and honest SQL tracing. Scope constant target-read growth to singleton identities; add the explicit K/E merged-read bound.                                                                                                                                |

The frozen `specs/follow-counts-outcomes.test.ts` contains **17** scenarios. The design preserves the assertions in
all 17 for their current singleton fixtures, but not all current driver staging requirements. This is a proposed
compatibility assessment, not a claim to have run a native driver or made the red suite green:

| Frozen test start line / identifying title              | Outcome and precise implication                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 71 follower counts visible only through management      | Keep as written, including outgoing route/isolation/query rejection; implement own live counter in source transaction.                                                |
| 93 Space installed role                                 | Keep as written.                                                                                                                                                      |
| 104 person/automated/organization actual account        | Keep as written.                                                                                                                                                      |
| 123 revoked management / unowned subject                | Keep as written; private index rows do not change concealed responses.                                                                                                |
| 135 anonymous/suspended/no-scope/gate                   | Keep as written.                                                                                                                                                      |
| 149 signed outgoing cursor                              | Keep as written; maintenance uses a different stable seek.                                                                                                            |
| 169 hidden agent resolution                             | Keep as written; target-account visibility is live even while follower maintenance lags.                                                                              |
| 179 one management authorization                        | Keep as written; do not evaluate per follower.                                                                                                                        |
| 190 follow/unfollow/replay/duplicate effects            | Keep assertions; duplicate target replacement changes no rows/effects.                                                                                                |
| 211 explicit unfollow versus implied follow             | Keep as written.                                                                                                                                                      |
| 225 delayed positive versus newer negative, first apply | Keep assertions using per-edge revision; remove the implication that the order must be partition epoch/position.                                                      |
| 237 suspension/reactivation                             | Keep as written: it explicitly reconciles before asserting each changed count.                                                                                        |
| 254 first positive rechecks account                     | Keep as written: delivery invokes native current-source reconciliation, which can replace saved positive intent with a higher-revision negative.                      |
| 263 terminal event/purge/old work                       | Keep bounded pages, zero payload, terminal fence and late-work assertions; bind `accountSignal`/`purge` to the Library participant, not a new count erasure workflow. |
| 282 unready projection / unavailable Access             | Keep as written; fault real queue-age/bootstrap readiness, not a fabricated missing coverage certificate.                                                             |
| 293 private data absent publicly                        | Keep as written for every named artifact.                                                                                                                             |
| 321 geometric growth                                    | Keep as written for its Collection target and outgoing counter. It does not test merged-subject fan-in; do not claim it proves the K>1 bound.                         |

The protocol-specific requirement is chiefly in `specs/follow-counts-driver.ts`'s header: capture parks a real source
observation **after releasing** the source client and deliver invokes a target command. Preserve that staging, but
replace the observation interpretation with a real pending per-edge replacement plus native current-source
reconciliation on delivery. No driver may manufacture counts, compare revisions itself or fake permissions. Rename
coverage-readiness comments/fault description to maintenance readiness; keep the missing-driver guard and all 17 tests.
No outcome asserts instantaneous suspension subtraction before reconciliation, publishes a coverage certificate or
requires a counter generation. Those are document/binding assumptions to remove, not tests that must be weakened.

Add native acceptance cases for healthy visibility by 60 seconds; 300-second boundary and retry headers; a missing
source-health sample/unrelayed dirty row/exhausted DBOS retry; fresh heartbeat with an old unfinished account page;
crash after target commit before source ack; coalescing preserving oldest age; terminal fence versus concurrent first
apply; Library erasure of never-positive/tombstone rows and shared payload custody; source partition move with pair
revision preservation; verification and reversal with follows on both originals counted once; a 4,096-original group,
cross-partition identity change during read, and honest K/E growth/deadline behavior. Keep every existing frozen
assertion; these tests fill gaps in the accepted SLO and identity decisions, not substitute for current outcomes.

[mast-follow]: https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/models/follow.rb
[mast-counters]: https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/models/concerns/account/counters.rb
[mast-suspend]: https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/services/suspend_account_service.rb
[bsky-follow]: https://github.com/bluesky-social/atproto/blob/6ed6fe39dded20f1e8995042135fba83b31d7b26/packages/bsky/src/data-plane/server/indexing/plugins/follow.ts
[bsky-processor]: https://github.com/bluesky-social/atproto/blob/6ed6fe39dded20f1e8995042135fba83b31d7b26/packages/bsky/src/data-plane/server/indexing/processor.ts
[meta-ig]: https://github.com/facebook/facebook-nodejs-business-sdk/blob/0d245ec888c1af38d68994fd7f2e24cd38abc82f/src/objects/ig-user.js
[meta-page]: https://github.com/facebook/facebook-nodejs-business-sdk/blob/0d245ec888c1af38d68994fd7f2e24cd38abc82f/src/objects/page.js
[dbos-source]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/wfqueue.ts
