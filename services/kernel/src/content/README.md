# Content

Content owns boards, threads, posts, immutable documents, media state and publication, and content governance operations.

## Native post history selection

`listPostRevisions(dependencies, threadId, postId, context, cursor?, limit?)` retains the existing
`entries`, `nextCursor` and `anchor` interface and adds internal `posts` and `anchors`. The mounted
`GET /v1/posts/{id}/revisions` consumes those exact disclosed posts directly. Its public response
remains `{ revisions, next }`, default 20, with limits 1–100. The separate exact revision route and
its `editionIdentity=true` option are unchanged.

Decision: history advances one admitted raw page without refill; changed source observations withhold the page and retry uses the same cursor.

The existing signed cursor still binds the post, thread, viewer, epoch and ascending
`(recorded_at, revision_id)` frontier. `history-page.ts` orchestrates one selection through
`pageRevisionCandidates`; it is not a store or a second disclosure authority. Selection examines
at most `limit + 1` native revision keys. Each key uses the original native post, ancestry, board,
Realm and Access disclosure, and retains that disclosure's original observations and prepared
checks for final revalidation. A later head or container must not become a new baseline. Each
revalidation clears cached Realm evidence. Initial, selected and final partition epochs must agree.
Exact keys must belong to the selected post and thread. Bodies are never obtained from a head in
place of a selected revision. A current erased post returns empty history under its native authority.
Empty and sparse selections still revalidate the source; denied or changed sources withhold all
rows and session headers. Every successful native anchor contributes to the existing session header.

This is the native selection and revalidation primitive for the history page. The page-level
conversation/viewer presentation, batched current identity/mentions/Subject/media enrichment,
historical vote context and generated enriched response remain to be composed before Web can
replace its current joins. Web retains its historical reader and selection lifetime.

### Cost: native history selection and retained disclosure

- Touches: one existing route/post locator and one raw `(route, post_id, recorded_at, revision_id)`
  keyset query; one root disclosure and at most `p` exact disclosures, then their retained final
  checks. Each full successful observation uses seven native snapshots (five initial and two
  retained), each with BEGIN, partition observation and COMMIT. For an ancestry of `d<=33` posts,
  the native content statements excluding Access/Realm/question internals are `3d+33` per
  observation: three chains of `d+2` points, four board points, two body points and 21 snapshot
  controls. The raw selection adds four statements including controls. Native checks execute
  `2d+5` prepared Access evaluations per successful observation and at most two nonstandard
  question-disclosure reads, with their own pools, snapshots and account/Realm/Space anchors.
  Locator catalogue freshness, Access preparation and those nested owner terms are additional;
  these local counts are not a composed all-pool ceiling. No foreign dependency is prepared while
  a native checkout is retained. Reads write no receipts, reactions, revisions or retry state.
- Bound: `p<=100`, with one extra raw lookahead key, no refill and at most 32 reply ancestors per
  exact disclosure. The source and selected keys are retained until final checks, including an
  empty result. At most `2(p+1)` body loads and JSON parses occur for successful full observations;
  each canonical document is at most 2 MiB of UTF-8, with at most 128 Subject and 32 media keys
  per revision. Entry/post projections share document objects. Serialization emits at most `p`
  bodies, plus bounded native metadata; licence strings allow 128 characters, not 128 bytes
  (up to 512 UTF-8 bytes). No identity, media or author-vote batch runs in this slice. Denied and
  changed branches stop early, withholding their accumulated bodies. There is no internal retry;
  same-cursor retry repeats current observations and the same raw frontier. Native snapshots
  release normally or roll back and evict on failed rollback, including cold and withheld paths.
- Growth check: `test/content/history-page.test.ts` covers mounted native 20/21 continuation,
  limits, viewer binding, exact readback, actual head changes and takedown, empty final
  revalidation and same-cursor retry. Existing `test/content/revision-pages.test.ts` owns selector
  prefix/growth checks. Independent native256/1024/4096 selected-history and nested-authority
  growth, strict residual-join plans and composed all-pool/runner ceilings remain required for
  the complete enriched page; no new performance proof is claimed by this primitive.

## Own reporter history

`createReporterHistory(ReportDependencies).read({ actor, deadline }, { cursor?, reportId? })` supplies
`GET /v1/reports/me`. It exports `ReporterHistoryPage`, `ReporterHistoryEntry`, `ReporterHistoryQuery`,
`ReporterHistoryAction` and `ReporterTargetSummary`. The route is authenticated, private/no-store, and has
no account selector. `reportId` is one optional exact own selection; a concealed, missing or other reporter's
selection adds nothing. The response has the reporter's submitted target/revision, reason/evidence, native
outcome and resolution time, current target summary and GET actions. It has no moderator evidence, decider,
other reporter identity, transaction metadata or moderation action. Open and follow both use the existing
exact case GET; follow is advice to revisit its current outcome, never a subscription.

Decision: My reports uses a fixed raw page of 20 and one optional exact own selection alongside it; selection never moves the raw frontier. Installation certifies a sealed migration cut; later creations use the registered native locator effect.

The existing reporter-home inventory retains its primary key for account erasure. Its received-time index
adds chronological traversal with report ID as the raw tie-breaker; report IDs themselves are derived and
do not encode submission time. A page examines at most 21 locator keys, hydrates the first 20 and at most
one extra exact selection, and never refills suppressed cases. Selection is deduplicated in the response.
The cursor binds account, client, delegated principal, authentication epoch, exact scopes, selection, fixed
page size and reporter-home epoch. An outcome change during fill fails the whole page; a retry uses its
original cursor. Operational failures return no advanced frontier. `retry.cursor` also preserves that input
on a successful preparing response. Native account admission precedes retained-case fills and repeats after
hydration. Target disclosure repeats after the final source fill; hidden or removed targets return only
`{ "state": "unavailable" }` and no target action. Original submitted target identity remains retained under
the existing reporter policy, independently of present target readership.

`report-locator-installation.ts` supplies `installReportLocatorPage(pool, partition)` and
`createReportLocatorInstallationEffect(pool)`. A migration locks native command positions before report
insertion, seals per-source epoch/position/count cuts and a finite identity-only journal, and seeds the
corresponding zero-source certificates from those counted cuts. The worker delivers at most 100 current
sources before acknowledging deletions and their applied count atomically in the source partition.
No reporter identity is copied into the journal. Crash replay repeats idempotent delivery; live creation
after the cut uses its committed original event. Concurrent resolution changes no submitted identity or
time. Erasure is rechecked at the source and through the existing recipient-home fence/late-item protocol.
Only an applied count equal to the sealed expected count can certify a cut, never an empty runtime page.
The receiving effect verifies that committed cut, releases its source checkout and acknowledges it once in
control partition zero. A single keyed control record supplies request readiness. The default Content
supervisor registers and starts the durable finite installation workflow; history reads do no installation
work and do not scan old reports. `preparing` describes incomplete baseline coverage, while ordinary live
locator delivery remains asynchronous.

These are wire examples for the Web owner; each successful response has `Cache-Control: private, no-store`.
For a populated page (`GET /v1/reports/me`, 200):

```json
{
  "state": "ready",
  "entries": [
    {
      "id": "11111111-1111-8111-8111-123411111111",
      "target": { "kind": "thread", "id": "22222222-2222-7222-8222-234522222222" },
      "revisionId": null,
      "reason": "spam",
      "evidence": "My submission",
      "createdAt": "2026-11-03T10:00:00.000000Z",
      "outcome": "dismissed",
      "resolvedAt": "2026-11-03T11:00:00.000000Z",
      "targetSummary": {
        "state": "available",
        "label": "Discussion title",
        "href": "/v1/threads/22222222-2222-7222-8222-234522222222"
      },
      "viewer": { "ownsReport": true },
      "actions": {
        "open": { "method": "GET", "href": "/v1/reports/11111111-1111-8111-8111-123411111111" },
        "follow": { "method": "GET", "href": "/v1/reports/11111111-1111-8111-8111-123411111111" },
        "target": { "method": "GET", "href": "/v1/threads/22222222-2222-7222-8222-234522222222" }
      }
    }
  ],
  "selectedReportId": null,
  "nextCursor": null,
  "retry": { "cursor": null },
  "viewer": { "kind": "reporter" }
}
```

An empty page (200) is exactly:

```json
{
  "state": "ready",
  "entries": [],
  "selectedReportId": null,
  "nextCursor": null,
  "retry": { "cursor": null },
  "viewer": { "kind": "reporter" }
}
```

For a withheld target, the same retained entry replaces `targetSummary` with exactly
`{"state":"unavailable"}` and `actions.target` with `null`; it carries no stale label, snippet or link.
A signed-out request returns 401 with the existing problem `code: "authentication_required"`.
A changed-outcome page returns 503 with existing problem `code: "dependency_unavailable"` and
`Retry-After: 1`; the client repeats the same request, preserving its cursor and selection.
An incomplete cut returns the same page envelope with `state: "preparing"`, no raw entries or advanced
cursor, and an optional permitted exact selection. It must not be presented as a complete empty inventory.

No current Web consumer/head is integrated with this route. The existing Web report owner retains the
interface. Phone/desktop inspection, a real follow/open action and failed-page recovery remain consumer
acceptance after integration. Current exact post disclosure uses the native per-post ancestry driver;
batching that producer and connected installation/race/three-scale evidence remain continuation work.

### Cost: own reporter page

- Touches: initial/final native account authority; one control-home coverage point; one reporter-home
  received-time/ID seek; two owning-case batch fills; two current native target rounds. Each source-home fill
  admits through native account policy before accessing source bytes. Every checkout is released before
  another home's command or authorization preparation. No totals or outcome-history enumeration.
- Bound: raw L=20 plus one optional exact selection; at most L+1 locator rows and P<=21 distinct cases in
  H<=P source homes. Source SQL has H statements and P exact route/ID probes per fill, including ownership
  predicates. Locator work is O(log N+L), case work O(P log R), plus the independently derived account,
  target and control terms below. Evidence is capped by the existing 4096-character report admission;
  all nested native payload reads count even though this DTO returns only labels and submitted fields.
- Growth check: focused native HTTP outcomes in `test/content/reporter-history-http.test.ts`; independent
  256/1024/4096 source, reporter, outcome and backlog growth with strict physical-prefix/byte capture remains
  pending, with Performance review requested. No measured ceiling or completed growth acceptance is claimed.

### Cost: retained reporter case batch

- Touches: native current account admission per source home; one independently anchored source snapshot per represented
  home; one lateral native report primary-key probe per supplied exact ID. Both submitted data and current
  outcomes come from `content.report`, never a second case index or a public case GET mapper.
- Bound: P<=21 unique keys, H<=P homes, P source rows per fill plus native account and snapshot work. No
  foreign SQL join, full case payload or moderator-only evidence is selected. Unrelated outcome history,
  other reporters and locator backlog add only indexed-tree depth, not candidate enumeration.
- Growth check: the focused HTTP suite pins source ownership, replay, selected-case deduplication and
  current native dismissed outcomes; nested physical-plan and three-scale measurements remain pending.

### Cost: current reporter target summaries

- Touches: native `readBoards`, `discloseThreads`, `readCurrentSubjectSummaries` with final verification,
  and exact `readPost` for reported replies. Post locations use represented-home route/ID batches. Shared
  native producers retain Realm/Space, board, subject, account, grant, ban and ancestry decisions.
- Bound: T<=21 distinct targets per round; at most T boards, T threads, T posts and T subjects, with
  redirect witnesses bounded by the native subject producer. Each post has the existing maximum 33-node
  ancestor chain. Native first-post/post document bytes and community/subject display dependencies count
  in full; small output labels do not reduce those reads. Two complete rounds add these native bounds.
- Growth check: the focused suite covers a current link and withheld title/link after target retirement;
  native post batching and independent three-scale nested authority/payload evidence remain pending.

### Cost: locator installation source page

- Touches: one exact cut/source-head read, at most 100 source-journal entries, current native source
  ownership for each, recipient-home locator/erasure commands, and one source acknowledgement command.
  Each source-to-recipient handoff releases its checkout; late erasure uses the existing native protocol.
- Bound: J<=100 journal entries; O(J) exact source and recipient operations plus their native command,
  fence and erasure bounds. The source acknowledgement deletes at most J exact journal keys and advances
  its counter by actual deletions only. A crash before acknowledgement replays at most the same J entries.
- Growth check: installation crash/resume, counted-cut races, erasure and three-scale worker accounting
  remain pending; empty-runtime-page success is explicitly refused when the sealed count is incomplete.

### Cost: locator installation certificate delivery

- Touches: one committed source cut/head read, then one control-partition command with an exact source
  certificate insert and at most one keyed coverage-counter increment. Duplicate delivery changes nothing.
- Bound: constant statements/rows plus the native command envelope; at most 4096 source certificates,
  with logarithmic indexed blocks. Requests read only the single keyed coverage record.
- Growth check: replay/certificate mismatch and all-pool three-scale measurements remain pending; the
  certificate requires matching original epoch/position/count and source acknowledgement, not a marker.

## Realm Subject exact-candidate disclosure

`realm-subject-disclosure.ts` exports `prepareRealmSubjectDisclosure(dependencies, input, context)`.
The sole `realm-subject-source.ts` census/factory owner supplies original keys; this evaluator creates no
population, candidate storage, bootstrap, event consumer or registration. Until that composition lands,
Realm population enumeration remains unavailable. `listSubjectThreads` is not a census.

Exported types are `RealmSubjectCandidate = Readonly<{ threadId: string; openingPostId: string;
subjectId: string }>`, `RealmSubjectDisclosureInput = Readonly<{ realmId: string;
candidates: readonly RealmSubjectCandidate[] }>`, `RealmSubjectDisclosureDependencies = Readonly<{
pool: Pool; access: Access }>`, and `RealmSubjectDisclosureContext = Readonly<{ actor: Actor;
deadline: number; work: AccessWorkAccounting }>`. `RealmSubjectDisclosure` has only
`finish(): Promise<readonly RealmSubjectEvidence[]>`. Evidence is aligned with input, without echoed keys:
`{ state: 'positive'; freshness: RealmSubjectFreshness }` or `{ state: 'absent' | 'withheld' | 'unknown' }`.
`RealmSubjectFreshness = Readonly<{ before: string; final: string; expiresAt: number; anchors: readonly AnchoredPosition[] }>`
is internal native freshness, never permission or a reusable bearer proof. Signatures hash actual native
source and parent observations. No concealed identifiers, counts, denial details or public DTOs are returned.
The internal `reads.ts` export `prepareRealmSubjectThreadDisclosure` returns `state`, nullable `signature`,
`anchors` and `final(): Promise<{ signature: string; anchors: readonly AnchoredPosition[] } | null>`;
its state is `positive | absent | withheld`. It reuses native source, ancestry and board disclosure without bytes.

Decision: exact evidence pins the original Subject and requires its native reference to remain terminal;
a redirect never substitutes a different Subject. Missing native capabilities and dependency failures produce
unknown, never complete empty membership. Absent means only this exact readable opening lacks the requested
link, kind or Realm placement. Only the census owner can establish coverage across all candidates.

A batch contains 1–8 candidates, copied at entry, under one actual actor, fixed deadline and additive caller
work root. Preparation observes current authority; one `finish` repeats it against the same signatures and
rechecks the exact source. Calling finish again within its deadline returns the same promise; an expired or mutated-principal handle returns unknown without another round. Every home is
released before another is checked out. There are two disclosure rounds (three thread snapshots and four board snapshots), at most 33 native post ancestors per
source round, one current revision, one board, one Realm/Space binding, and one original terminal Subject.
Only metadata is read: no bodies, history ranges, Realm board enumeration, refill, global generation or table
scan. Native statements, transaction/partition work and existing Access producers debit the supplied root;
a missing producer refuses the attempt. The deadline is capped at the caller root's existing deadline.
`expiresAt` caps evidence at 1,000 ms from preparation and the fixed deadline; consumers must not reuse it afterward. Public Realm
bans include the actual actor and authenticated delegating principal. Protected grants, account fences,
source/parent revisions, takedown and restoration retain native read authority at both rounds.

## Mixed Home summaries

[The feed contract](../../../../docs/feeds.md) owns selection, source limits and sparse cursors.
`feed-discovery.ts` maps Search's delivered Subject/Account and public Collection/review/Space summaries with
exhaustive dispatch and exact route, kind and primary identity checks. It translates only the public
`library/collection` and `community/space` keys to Content's `commerce/collection` and `content/space` feed
identities; Review keeps `content/review`. Unsupported or inconsistent variants fail the discovery lane without
advancing its retry position. The mapper performs no owner reads or refill. Search's current Collection summary
supplies only title and description, and its Review summary supplies no rating; the feed leaves curator, cover and
rating absent instead of filling those facts locally.
Thread and post summaries add optional `author` (Accounts display name, handle and avatar) and `excerpt`.
Projection consumes only the opening/post revision that passed native disclosure; one deduplicated page-level
Accounts summary batch supplies at most 20 current identities with its own final checks. A missing summary
omits `author`; withheld or empty text omits `excerpt`. No author IDs, ratings or per-row enrichment are added.
Excerpts collapse native document whitespace and count at most 160 Unicode code points, stopping before a
whole grapheme would exceed the cap. Home uses these fields without a second content or identity request.
The [feed contract](../../../../docs/feeds.md#content-reaction-summaries) defines native reaction targets, viewer slots,
source freshness and the bounded cost for disclosed thread/post cards.
The producer constants derive at most 91 mixed candidates plus 21 author keys (seven identities, each with
at most one avatar and one verified-agent Subject), 123 anonymous candidates, or 20 Following candidates plus
60 author keys; the composed maxima 112, 123 and 80 remain below the 160 ceiling.

Decision: Keep Search's bounded public owner summaries authoritative; translate only validated owner keys and leave Collection curator/cover and Review rating absent until their current public summaries supply those fields.

The Review census still cannot certify ready eligibility coverage, and Community has not yet supplied the complete
current Space/Realm tuple capability. These feed projections do not promote installation, an empty page, or
preparing coverage into native readiness; those source authorities remain in the continuation.

#### Cost: native mixed Discovery feed projection

- Touches: One already bounded Search page, its supplied summaries, and the feed's projected item array; no owner SQL, pool checkout, or extra disclosure call.
- Bound: O(B) key/route validation and projection with B at most the existing 160 raw-candidate ceiling; no refill, and each output remains inside the closed Feed schema.
- Growth check: `test/content/feed-discovery.test.ts` pins every current owner variant and mismatched identities at fixed size; independent native 1x/4x/16x pool measurements remain deferred to the continuation.

## Worker authorization composition

Default `registerContent` consumes `WorkContext.getAuthorization()` from the shared worker registry. That port
memoizes the actual fully mounted kernel Access and canonical Auth current-consent reader for the context.
The same Access object goes to `createContentWork` and `contentNoticeEffects`; the same consent function goes to
author-erasure restoration and is mounted in Content's pool registry by the kernel. Mounted action metadata,
resource roles, grant constructors and current authorization facts remain owned by that kernel.
Missing or invalid configuration and unavailable current consent retain the shared port's typed failures.

Author erasure keeps its native full-domain checks before and at the final step, current source, ancestry,
roles and consent, evidence no older than 1,000 ms, and known-nonce/current-operation proof. Explicit
`createContentWork({ access, readConsent, ... })` callers retain their injected ports; exported
`createContentWorkAccess(clock, pool?)` remains available for standalone fixtures and callers.
Image processing, URL imports, collection and purge retain their committed source, state, ownership and hold
checks and existing queues, retention and page bounds. These mechanical jobs do not restore a person initiator.

Cost per operation: authorization composition adds one memoized context-port lookup and passes existing object
references. It adds no source SQL, pool checkout, permission allowance or per-step work; the existing Access,
consent and native operation bounds continue to apply. `test/content/worker-authorization.test.ts` covers this
composition and its dependency failures.

A `BoardView` includes `realmId`, which is the containing Realm id or `null` for a board without a Realm. The field is
output-only and comes from the board row used for disclosure.

## Viewer actions

`content.board`, `content.thread`, `content.post` and `content.edition` use their native read actions in
`POST /v1/viewerActions`. Full-key source batches retain the ordinary live head, reply-ancestry, board,
Realm and Space lifecycle/read operands. Edition sources additionally retain the pinned revision, original
subject without redirect, creator standing and erasure fence. Every formula runs on the request's client and T;
no author, moderator or role name supplies permission. A Realm ban conceals its Content references.
Draft edition metadata remains visible only to its creator under ordinary source authority, allowing the
existing publish operation to be offered; draft posts and threads remain concealed. Published editions have
no anonymous floor. Operation declarations retain their own authority anchors, scopes and platform gates.

## Global boards

`GET /v1/boards` is the public Global board directory. Its closed query accepts optional
`purpose: discussion | reviews`, `cursor` and integer `limit` (1–100, default 20); its closed response is
`{ boards: BoardView[], next: string | null }`. It returns actual current BoardViews, including native
`realmId: null`, route, title, purpose, visibility, security revision, availability and creation time.
It lists empty boards too and neither probes threads nor adds counts or ranking scores.

One native partial-index range selects at most `4 × limit` currently published Global candidates in
`(route, board_id)` order. The purpose filter has an exact purpose-leading index. Boards have no independent
availability column: current availability comes from ordinary board disclosure. Index membership grants nothing;
each selected board passes the current anonymous `board:read`, source visibility and native placement checks,
then repeats source and Access disclosure at FINAL. A changed security revision is omitted without refill.
Staff and private grants cannot widen this directory; bearer authentication and suspension middleware still run.
The sealed list cursor binds the endpoint, normalized purpose and limit, definition epoch and last examined
source key. A sparse or empty page can have `next`, including a conservative continuation after a full candidate
range; consumers continue until null. Costs are O(limit × log R), with one range and bounded point disclosures,
no partition, Concept, grant, history or thread enumeration. Native infrastructure and deadline failures propagate.
Realm discovery remains `GET /v1/realms/{realmId}/boards`; a caller cannot supply a Realm to this collection.

`POST /v1/boards` creates a board in Global Context. It requires `Idempotency-Key` and the strict body
`{ conceptId, title, purpose, visibility }`, with purpose `discussion | reviews` and visibility
`published | protected`. It returns 201 `{ board }` using the Realm board DTO, with `realmId: null`, and the
same problem codes as Realm board creation. The actor needs `board:create` on Global Context and `subject:read`
on the Concept; no Realm role reaches this authority and Global Context has no board scheme. Governance holds
the creation permission through grants. Creation checks the Concept's type and read authority directly, without
waiting for subject-link projections. A board is placed at `newId(routeOf(conceptId))` and initialized with the
same resource grants as a Realm board. Protected Global boards require explicit read and write grants.
There is no uniqueness by concept or purpose; each new key creates a separate board and a replay returns its board.
`POST /v1/realms/{realmId}/boards` retains its Realm scheme and uniqueness rules. Its preparation uses Semantic's
`readConceptSchemeReference` with the original command T and fixed native permission deadline. It checks Realm
participation, read and board creation authority separately. The released Realm head and exact `board_scheme_id`
are rechecked in native parent validation before checkout of the new-board transaction. No subject page or link
projection readiness is required. Every replay repeats authorization before looking up its receipt.

An item read discloses only if its board passes before the thread chain is prepared and again after the chain's
final check: the board's first signature, availability and prepared Access check must still pass in its own
partition. A revocation committed before the board recheck is observed; bytes, digests and keys leave only after
both board checks and the thread check pass. For a non-public Realm board, each board check also reads the
account's current Realm ban key at authorization time (and the delegating principal's key for a delegated actor);
an open ban overrides every independent grant, while public boards and Global boards read no ban key.

### Board pins

`POST /v1/boards/{id}/threads/{threadId}/pin` accepts `{ pinned: boolean }` with an `Idempotency-Key` and returns
`{ boardId, threadId, pinned, pinPosition }`. It is a desired-state native command: repeating the same request is
safe, and requesting the current state does not change ordering. At most five same-board threads are pinned.
New pins lead the section; existing pins keep their position; unpinning compacts the remaining positions.
`409 conflict` means the five slots are full. The board row lock serializes competing commands.
Same-board membership comes from the current thread row and board projection; a thread and its opening may have a different native home from the board.

Only an initial board page includes current `pinnedThreads` (at most five), newest pin first. Continuations return
`pinnedThreads: []`. All four sorts exclude the same cohort observed with the initial ordinary candidate range.
The page query applies to both sections. Sparse progress records every scanned candidate, including pinned and
undisclosed candidates, and can continue past the fixed 200-candidate window without unbounded refill.

Decision: effective pin/unpin operations increment a board-home `pin_revision` atomically with the slots;
no-ops, receipt replays, slow mode and feed/rank updates leave it unchanged. The versioned `pinned-cohort-v2`
cursor authenticates that revision together with board, normalized query, sort, viewer, home epoch and exact ordinary
keyset. Its scanned key is encrypted, since even a hidden pin may be the last scanned row. No cohort identities or
client-selected cohort flags appear in its readable payload. Old representations or any changed revision return
`400 invalid_cursor`: discard the cursor and restart from an initial request. Pin/unpin ABA also requires restart.

Pins are projection hints, never visibility authority: current board, Realm, thread, opening-post and Access checks
disclose each result. Concealed pins are withheld from both sections and never supply author/body fields. All native
snapshots release before the final board/Realm read and pin-revision comparison; a changed cohort or home epoch
fails closed with `invalid_cursor`, even on an initial request. That request can be retried without a cursor.

The command checks current `moderation:takedown` authority on the Realm for a Realm board or the board for a Global
board. Before receipt lookup, it also rechecks current board, Realm (when present), thread and opening-post reads;
protected Realm board checks retain current ban and account-standing behavior. A replay repeats these checks. Web
owns pin controls and restart UI; its existing deduplicating pin-author hydration consumes only disclosed threads.

Actual shared callsites: `boards.ts` alone reads the pin projection and uses the created/rank cursor encoders and
decoders; `board-cursor.test.ts` exercises their format. The mounted `routes.ts` board page and pin command retain
the existing native bindings. `schemas.ts` bounds both pin responses, and `board-events.ts` registers pin positions
through five. These schemas change together with the projection; command authority and receipt protocol do not.

Focused outcomes in `test/content/board-pin-http.test.ts` cover capacity races, newest-first ordering, unpin/re-pin,
initial-only sections, all four ordinary sorts, stale cohorts, sparse continuation and current concealment.
Decision: the protected-board journey supplies native board ownership and an explicit Realm member role for read access; Realm curation authority remains independently required for pin changes.

The `readResource` public-eligibility callbacks declare native work through
`ResourceEligibilityOptions.work.prepare/verify`. Preparation returns the already captured evidence and performs
no IO. Verification rereads the actual board, thread or post point (including its current head and exact moderation
decision), compares the full existing disclosure signature and applies current admissibility. Protected Realm board
checks retain the actual actor and delegating principal ban probes at the evaluator's T. Each dispatched plan keeps
its full row charge, including misses; successful byte receipts cover the actual parameters and closed projection.
The adjacent derivation in `read-eligibility-access-work.ts` uses the native keys, unique constraints and title bounds.
It reads no body or digest and does not charge previously captured evidence or surrounding reader IO.

These declarations participate only in trusted `AccessContext.work`, using the caller's existing Source ledger.
They supply no permission, cached result or allowance. Every check, including a second check in the same read window,
executes current native verification; independent board/Realm checks and final snapshots remain required. The separate
revision projection (digest, bounded arrays/citation and optional body) has no declaration in this callback and refuses
before dispatch as `Content read eligibility revision projection native work producer`. Ordinary unmetered reads
retain their existing behavior. Focused callback and receipt cases are in `test/content/eligibility-access-work.test.ts`.

Decision: native thread and post creation accepts `protected` visibility, while revisions cannot enter or leave that
state; only the exact selected edition source receives the protected-source read exemption.

Native thread creation sets `published`, `draft` or `protected` on both the thread and opening post. Native reply
creation accepts optional `visibility: published | draft | protected`, defaulting to `published`. Revision input
accepts only optional `published | draft`; omission preserves visibility. Explicit draft edits remain drafts. Only
the first `draft` to `published` revision changes visibility; published-to-draft and protected-state changes are
refused. Publication chooses the new revision, advances the post security revision and, for an opening, publishes
its draft thread with a security revision increase in the same transaction. Existing Access and current ancestry checks apply.
Immediate published creation and draft publication emit the closed publication event with `threadId`, `itemId`,
`revisionId`, `actorId`, `placeId`, `kind`, `subjectIds` and `activityAt`. Drafts, subsequent edits, rollback and receipt
replay emit no publication event. Reply index fields retain the existing opening-post subject inheritance.

## Notifications

Content owns minimal in-app notices for `reply`, `mention`, `thread_watch`, `board_activity` and `moderation_decision`, using the names
in Accounts' notification catalogue (`src/access/notification-kinds.ts`). Accounts owns the preferences and
`notificationAllowed`. There is no email delivery in this scope.

An authenticated reader uses `GET` and `PUT /v1/threads/{threadId}/watch` to read their own state and watch a thread;
`DELETE` clears only their own watch and remains available after thread access is lost. Watching requires current
thread read access. Watch state never grants access and no endpoint exposes watcher identities or counts. Only later
published replies notify watchers; the opening post and other participants do not create subscriptions. Watch replies
use their own optional, default-on `thread_watch` preference, separate from reply and mention settings.

Decision: `thread_watch` has its own default-on preference, and a reader can clear their own watch after access to the thread is lost.

A published post with a parent notifies that parent's author with `reply`. A published post without a parent
notifies the thread's opening-post author. Creating the opening post never notifies its own author. A `mention`
inline node with `attrs.accountId` in a post's first published revision notifies each distinct named account, in
document order, up to the first ten. Duplicate nodes do not consume additional slots. A draft sends nothing;
its first publication uses that published revision's mentions. Later revisions send no mentions. Web adds the
mention node to `packages/document`. The explicit `com.rezics.content.post.published.v1` event is the
first-publication authority for openings and replies, pinning the exact published revision. Creation and revision
events retain their existing consumers but are not notice authority. Draft creation is not a publication transition.
Publication uses the existing revision API; notice delivery never changes authoring visibility.

For these post notices a recipient gets at most one notice per post, with `reply` winning over `mention`.
The actor never receives their own notice. A nested reply does not independently notify the opening-post author;
that author can still receive a mention. Moderation outcomes are separate sources: a takedown notifies the target's
author with its decision, a report resolution notifies the reporter with `actioned` or `dismissed`, and an appeal
resolution notifies the appellant.

Content effects on committed events write notices on the recipient's route. Each notice is unique on
`(recipient, kind, source)`; replay adds nothing. A post notice uses the post as its source. A takedown, report
outcome and appeal outcome each use their own source identity, so an appeal resolution can notify the author
after the original decision did. Each notice stores only its identity, kind, time, actor id (`null` for moderation)
and target ids: thread and post, or decision and report as applicable. It stores no text. The inbox links to the
author-readable decision or reporter-readable report for statements, deadlines and outcomes.

Subject reports use the same `POST /v1/reports` receipt, evidence, rate family, idempotency,
reporter locator, reporter status and erasure minimization as other report targets. Admission uses the
native `readSubjectReference` boundary and current `subject:read`; missing, hidden, taken-down,
redirected and denied identities return the same 404. A Subject has no reported post revision.
Global `report:create` standing uses a separate setup principal so existing reaction-install receipts remain valid.

`GET /v1/subjects/{id}/reports` (`subject_report.list`) and `GET /v1/catalogue/reports`
(`catalogue_report.list`) require current `moderation:read_reports` on the seeded Global Context.
Both expose private moderator pages with the existing selection and sealed credential-bound cursor;
limit is 1–50, default 20. The catalogue contains only Subject reports. Its Global-partition candidate
projection stores report and Subject references and time, never evidence or reporter identity.
Each page seeks `(route, created_at, report_id)` through at most 51 candidates, hydrates at most 50,
and checks current Global authority and native Subject existence independently at disclosure.
Hidden Subjects remain inspectable. Existing report dismissal uses Global `moderation:takedown`
for a Subject. Reporting or owning a report grants no inspection permission.

Decision: redirected Subjects are unavailable report targets; visibility reductions retain a text-free
Content action reference and resolve Subject reports without inventing a Content moderation decision.
The existing Subject visibility event resolves open reports created at or before its native source time,
using existing outcome pages, notices and checkpoints. Restoration does not reopen reports. The latest
reduction reference repairs late report projections even after restoration; a report submitted after
that reduction stays pending until a later reduction or dismissal. Replays preserve the first outcome.

Bounds: native Subject reference admission examines at most three relation rows and two data statements,
plus its existing bounded Access evidence. A catalogue page admits 51 candidate references and at most
50 report fills. Each candidate has four inspections, each comprising one Global snapshot and one exact
Subject snapshot, plus one report fill: `3 + 50 * (2 * 4 + 1) = 453` adapter snapshots. The constants
`CATALOGUE_REPORT_PAGE_LIMIT`, `SUBJECT_REPORT_INSPECTIONS_PER_CANDIDATE` and
`CATALOGUE_REPORT_SNAPSHOT_CEILING` record this composition; each Access invocation retains its
producer's existing finite evidence bounds. Subject outcome pages reuse `REPORT_OUTCOME_PAGE_SIZE = 100`,
at most 100 report-home commands and 100 reporter notice finalizations per page. Native source recovery
examines one existing outbox envelope (at most 1000 events), then one full-key source-time probe.
All owner checkouts release before the next home; no Subject, report-history or grant scan discovers work.

Board report queues include reports on the board and its descendant threads and posts. The registered
`content_report_target` effect consumes `report.created` references, releases the report source snapshot,
reads native post → thread → board keys, releases that snapshot, and writes the board's partition.
`content.board_report_candidate` stores only report and target references and creation time. Exact thread/post
lists continue to use `content.report_target`; the candidate projection is never report or disclosure authority.
No descendant, report-history, grant or account scan discovers a page. No report body copy is retained.

A board page admits at most `limit + 1` candidates from its board-leading keyset index. It hydrates at most `limit`,
checking each candidate's current target `moderation:read_reports` and exact native board placement independently,
including when the viewer is also the reporter. Report references must match the candidate. Denied or stale rows
contribute no identifiers, evidence, text or count to the response. The sealed cursor advances over the examined
candidates even when none can be returned. The board's current inspection check fences the whole response.
Each page costs O(limit) bounded current-authority and native ancestry checks, each O(log R); the fixed existing
post ancestry bound remains 33. Replays repair an interrupted board projection without duplicating candidates.

The board, thread and post report list routes accept singular optional `status=all|pending|resolved`,
`targetKind=all|board|thread|post` and `order=newest|oldest`. Defaults are all/all/newest, including omitted
selectors. These selectors belong only to Reports, never Appeals. Every selector intersects the exact route scope:
a thread or post scope cannot produce board reports. Target kind is the native report target discriminant.
Pending means the currently inspected report has a null outcome; resolved means actioned or dismissed.
The candidate index has no outcome authority. Filters can leave a sparse or empty page with continuation;
continue with the same selection instead of interpreting that page as an empty queue.

Newest traverses `(created_at, report_id)` descending; oldest traverses the same index in reverse, ascending.
Each SQL branch uses a matching keyset inequality and its own bounded limit; only the chosen branch executes.
The outer order sorts at most that bounded candidate page to guarantee response order across the disjoint branches.
The v2 sealed cursor binds normalized selectors, order, limit, target, partition epoch and the current account,
client, scopes, requested-by identity and authentication epoch. Legacy report cursors lack these bindings and
are refused by the ordinary invalid-cursor rules; restart explicitly with the current selection. There is no
legacy fallback that could widen a population. The Web page forwards the selected values on next/retry/refresh,
retires older selection results, clears the cursor on selection changes, and keeps private responses viewer-bound.
Switching to Appeals drops the Reports selection, while retaining thread/post scope as before.

The moderator interface labels submitted evidence, the reported revision and the readable current target separately.
It reads a reported revision only through the ordinary exact revision GET with an actually known post identity;
thread-only revision references and refused reads remain neutrally unavailable. Exact revision reads deduplicate
post/revision pairs within the bounded page. The decision form submits one reason of at most 1,024 characters,
with one command key for an unchanged action intent across retries. Editing the reason starts a new intent.

An authenticated report's exact reporter can read that report and its outcome through native `account:read` on
their own account. The closed reporter response contains `id`, the submitted `target` and `revisionId`,
`reason`, `evidence`, their own `reporterId`, `createdAt`, `resolvedAt`, native `outcome` and output-only
`targetAvailability: 'available' | 'unavailable'`. A null outcome is presented as pending; actioned remains the
report disposition even after an appeal. The original submission survives removal or loss of target access.
Availability uses the existing exact native target, container and Realm disclosure with the request deadline;
removed targets are unavailable. Infrastructure failures propagate rather than becoming unavailable. Reads release
each home before touching another, perform bounded point/ancestry checks and never enumerate descendants.
This owner read does not disclose target document bytes, titles, snippets, links, moderator notes or other reports.
Availability grants no subsequent target read. Report ownership is never moderation inspection authority; lists
retain their independently authorized moderator DTO with required partition and transaction metadata. Moderators retain the existing
`moderation:read_reports` path and target checks; anonymous reports have no owner reader, and unrelated or
otherwise private report reads return 404. The report GET advertises `account:read` and describes the moderator
alternative.

When the effect runs, reply precedence excludes the reply recipient before preferences. Each optional candidate
passes the current Access post read, including the thread, ancestors, independently anchored board and Realm.
Every source and Access checkout is released before recipient finalization. Mention source selection reads the
thread and event revision on the thread route, then reads the board on its own route.

Optional-send finalization is the recipient transaction's actual COMMIT. The transaction takes the existing
shared `core.partition` writer fence and then reads `notificationAllowed` under READ COMMITTED. Native account
and preference commands must update that same partition row to commit; a change committed before the fence is
acquired is visible, and a concurrent writer cannot commit between the authority read and notice commit. No
lock spans partitions and no resource Access check runs while the recipient lock is held. Unavailable or moved
partitions fail retryably instead of recording a successful denial.

The recipient/source/kind delivery decision in `notice_finalization` commits with either the notice insert or
suppression. It is derived delivery state, never preference or resource authority. Unique-key claims also settle
concurrent redrives; a crash before the effect records completion cannot reopen a committed refusal. Accounts'
existing account point-read port fences terminal erasure before storing any recipient decision. Missing or deleted
accounts receive no new delivery records. Pending recipients may record a refusal, so later activation cannot
resurrect that send. The current inbox disclosure checks still apply after delivery.

Required moderation, report and appeal outcomes continue to use the mandatory catalogue check, independently of
optional toggles and without requiring access to the taken-down target. Optional finalization does not wrap them.
Delivery decisions share the existing 180-day retention and recipient-erasure page budget with notices (at most
1000 total records per page). Events older than that horizon cannot reopen an expired decision. Notice cleanup
remains separate from account lifecycle authority; a late redrive cannot recreate erased recipient state.

`GET /v1/accounts/{accountId}/notifications?limit=&cursor=` lists the authenticated account's inbox;
`GET /v1/accounts/{accountId}/notifications/count` returns its bounded current-visible unread summary,
`POST /v1/accounts/{accountId}/notifications:markSeen` advances its seen marker with `{ through: <notice id> }` and an
`Idempotency-Key`. `POST /v1/accounts/{accountId}/notifications/{noticeId}:markSeen` acknowledges exactly one
owned item; it never advances the bulk marker. The inbox is private to its account. Naming another account returns 404
for list, count and either seen action. The GET list returns newest first, using an immutable notice ordering to break
time ties. `limit` is 1–50, default 20. Its opaque shared list cursor (`src/tokens/list-cursor.ts`) binds the account,
limit, current client and authentication epoch. It contains the last raw candidate examined, so retrying an unavailable
source repeats the same page. An account replacement cannot reuse its old cursor.

Each item contains its installed kind, a current actor projection, current board/thread labels where disclosed, an
exact target action, a one-item seen action and `unread`. Current actor names and avatars come from Accounts on this
request; deleted or unavailable actors have the explicit `Former or unavailable account` form. Moderation notices use
the `Moderation team` actor. Reply, mention, thread-watch and board-watch candidates prove the exact source id, target,
full bounded post ancestry, thread, board and Realm using header/reference reads without reading post bodies. The final
target and Access witnesses are checked again before an item is returned. Moderation-decision notices require current
author ownership; moderator inspection does not grant an Inbox notice. Report outcomes require the recipient's current
reporter-owned record and never include its reason or evidence. A reporter's retained record can remain visible while
its target context is withheld. Unreadable ordinary targets are omitted without exposing their notice or target ids.

The page examines at most four times its limit (maximum 200) raw notice candidates. Sparse pages advance across the
last candidate examined. A dependency failure returns an error without a cursor, so retry does not skip candidates.
`GET .../count` applies the same current per-kind disclosure to unread candidates, examining at most 200 plus one row
to detect truncation. It returns `{ count, capped, basis, witness }`; `count` is at most 100, `basis` is
`current-visible-unread` when the candidate range was complete and `current-visible-lower-bound` when more raw
candidates may remain. `capped` means the returned value is a lower bound because the candidate range or 100-visible
cap was exceeded. The current-disclosure witness records the summary time. A failed source read is unavailable, never
an invented zero.

Decision: scan at most 200 unread candidates through current disclosure and return at most 100 visible; the summary is exact only for a complete range with up to 100 visible, otherwise `capped` marks a lower bound.

Bulk mark seen takes an owned notice id and advances the marker only forward in the same immutable inbox order.
Items at or before the marker are read; marking an older item cannot make newer seen items unread again.
The frontier stores the owned notice's immutable `(created_at, notice_id)` tuple in `notice_seen`, independently
of that notice's lifetime. PostgreSQL compares and copies the full timestamp precision; UUID breaks exact time
ties. List cursor keys also retain database timestamp precision. Delivery time and UUID time never substitute for
creation time: a delayed notice at or before the frontier is read even if its UUID is newer.
Concurrent marks atomically keep the greater tuple; replaying an equal or older mark leaves `seen_at` unchanged.
One-item acknowledgement stores the exact owned `notice_id` separately in `notice_ack`; concurrent replay is
idempotent and does not change another item or the bulk frontier. Both seen states are removed with their notice.
Unknown or foreign notice points remain concealed, including a formerly owned point removed by retention.

Storage transition: the migration copies timestamps only from still-present, recipient-owned notice points and
removes legacy markers whose points are already absent (or not owned), restarting those accounts as all unread.
Unavailable history is not recovered, inferred from UUIDs or reconstructed by scanning an inbox. This one-time
migration changes existing rows; requests never backfill, scan history or rewrite a recipient range.
Notices and completed thread-watch progress older than 180 days are deleted in bounded batches. Account deletion
erases the account's watches, notices and seen state through Content's existing bounded recipient-erasure pages.

Notification costs are bounded independently of inbox or thread size:

- Reply delivery considers at most two candidates and writes at most two notices per post (the single-parent
  rule above currently selects at most one). Mention delivery considers and writes at most ten. Each candidate
  has bounded current Access checks followed by one `notificationAllowed` check at finalization; recipient overlap is deduplicated.
- Thread-watch delivery seeks at most 100 watchers by `(created_at, route, watch_id)`, releases that page before current
  post disclosure and recipient writes, and persists its cursor after each completed page. Replay resumes the page;
  each recipient's finalization preserves a sent or refused outcome. Account erasure removes watch edges in bounded
  pages, and inbox reads recheck current post disclosure.
- Report outcomes write at most one notice per report, amortized against that report's creation. A takedown
  resolves open reports in bounded batches rather than requiring an unbounded synchronous fan-out.
- List and current-visible summary use native partition-batched target disclosure, current Accounts identities and
  separate one-item and bulk seen state; operation-specific bounds follow below. These bounds hold after retention;
  no Inbox scan is needed.
- Retention deletes bounded batches on recipient routes. The Content erasure participant removes notices, watch
  edges and the one seen marker in bounded batches; neither cleanup requires one transaction over an inbox or thread.

## Native community reports

`ReportTarget` and the existing `createReport`, `readReport`, `listTargetReports`,
`listSelectedTargetReports` and `listCatalogueReports` also accept `space` and `realm`.
`POST /v1/reports` retains its existing reason/evidence, proof, rate, receipt and error contracts.
`GET /v1/spaces/{spaceId}/reports` and `GET /v1/realms/{realmId}/reports` use the current
workbench report page DTO and selection/cursor contract. Catalogue selection accepts both kinds,
with a kind-leading index so filtering never walks other resource families. All three catalogue
kinds share the existing Global queue, projection effect and fixed 50-candidate budget.

Decision: a community queue candidate requires both exact current `moderation:read_reports`
authority and ordinary native target readership; Global queue authority never supplies either.
Realm disclosure uses the current Realm/Space binding, head, lifecycle and protected-reader ban
checks. A standalone Space uses its native current head and lifecycle eligibility. Preparation and
final disclosure use released snapshots, including a second native read after command authority
preparation, before receipt lookup. Missing and concealed targets produce the same 404.

A submitted report stores its exact native head/lifecycle witness with the original target and
submitted evidence. This witness is immutable and internal: it never becomes target readership.
A reporter can retain their submitted record and dismissed outcome after loss of target access;
only current `targetAvailability` changes. Reporter-link minimization continues through the
registered reporter locator and existing account-erasure participant. Projection replay is safe
between the independently committed target and catalogue homes. No new relay or cleanup job is
introduced; both existing registered effects accept the new event union.

`dismissReport` uses current exact `moderation:takedown` authority and native readership before
every receipt lookup. Disposition records review without removing a Space/Realm or granting a
ban. Resource removal remains the existing Community lifecycle command with its separate role,
head and lifecycle-version contract. Media reporting, native action orchestration, retained case
decision history and current target labels/viewer actions remain continuation work. Web owns the
existing workbench/form and reader; Content must still review that consumer on phone/desktop and
exercise recovery with Web after the complete journey lands. HTTP delivery alone does not close
that experience gap.

### Cost: community target witness

- Touches: `communityReportTargetFacts` uses one current-head statement: Space identity and its
  exact revision (two unique keys), or Realm identity, exact revision, active host and host revision
  (four unique keys). No metadata body, revisions range, descendant or membership enumeration.
- Bound: one statement, at most two/four physical table tuples plus the fixed materialized identity
  and projection nodes; each witness is below 1 KiB (UUIDs, enums and 19-digit lifecycle versions).
  Missing heads still pay every attempted point seek; a denial never refunds examined work.
- Growth check: the focused native outcome suite exercises empty, denied and replay branches;
  independent 256/1024/4096 physical-prefix measurements remain in the continuation and are deferred.

### Cost: community report creation

- Touches: existing command admission, receipt, insert and event work, plus an initial witness
  snapshot; native read eligibility before and after report authority preparation; target witness
  validation in the existing authority callback and anonymous proof callback when invoked.
- Bound: let F be the witness bound above and A(action) the installed Access preparation/formula
  work for that exact action/actor. Each native read uses A(kind:read), one snapshot (BEGIN,
  partition point, COMMIT), and F. Its Space eligibility adds one two-key preparation statement
  and one two-key verification statement (seven finite plan rows each). Realm eligibility adds a
  two-key binding preparation (seven plan rows), three-key Realm/head/host verification (nine),
  two-key binding verification (seven) and at most two current-ban keys (six plan rows). These
  terms come from `community/eligibility-access-work.ts`; they are added to, never substituted for,
  Access actor/grant work. Creation has at most three native reads (including anonymous initial
  disclosure), one initial witness snapshot per disclosure and two authority witness probes.
  Submitted evidence stays at 4096 characters; the stored witness has a 16 KiB schema ceiling.
- Growth check: native outcome coverage is `test/content/report-community-http.test.ts`; full
  actor/grant, authority callback and participating-pool growth ceilings require Performance review
  and the continuation's independently seeded scales before any cost acceptance claim.

### Cost: community report inspection and retained outcome

- Touches: exact report reference/private-record reads and the existing self-account checks, or
  current per-target report authority with native read eligibility. Target and catalogue pages
  select L+1 references, hydrate at most L, recheck each candidate and recheck page authority.
- Bound: point reads add the native read terms above without target history. Pages keep L<=100
  per target and L<=50 for catalogue, with no refill. Native target inspection occurs at most four
  times per selected candidate and twice for page scope; source reads and eligibility never scan
  unrelated reports. A kind-selected catalogue page uses `(route,target_kind,created_at,report_id)`;
  all-kind pages keep the existing time-leading index. Retained reporter output contains only the
  submitted record, outcome and availability, with the existing 4096-character evidence bound.
  Board history retains its existing 12+12H statement and 5+B+9H row derivation, B<=101; this slice
  does not reuse those ceilings for new target history or claim new history support.
- Growth check: native receipts, dismissal/replay, private outcome retention and protected Realm
  concealment are covered by `test/content/report-community-http.test.ts`; independent candidate,
  report and retained-outcome growth and strict physical plans remain deferred.

### Cost: community report dismissal

- Touches: one source reference; native read preparation; existing exact target authority and
  current witness validation; existing report-home receipt/resolution/event and recipient notice.
- Bound: one native eligibility preparation/verification and F in addition to existing
  `dismissReport` Access, report and notice terms. The command never writes a container or another
  partition. A same-key replay repeats current authority and eligibility before returning its
  retained receipt. A distinct dismissal on a resolved report keeps the existing conflict.
- Growth check: focused native dismissal/revoked-replay coverage is in
  `test/content/report-community-http.test.ts`; cross-home notice and history-scale budgets await
  the continuation's Performance-reviewed three-scale suite.

## Board moderation decision history

`GET /v1/boards/{id}/moderation-history` returns `{ entries, nextCursor }`, newest first, with `limit` 1–100
(default 20) and optional `targetKind=all|board|thread|post`. Each entry is the existing exact decision response, so Web
opens it with `GET /v1/moderation-decisions/{decisionId}`. The signed cursor binds the board, target-kind selection,
limit, current account/client authority and board partition epoch.

Decision: board decisions are inspectable only with current explicit moderation authority; boards have no
specified affected-party author. Their exact response has `targetKind: "board"`, `appealDeadline: null` and
`appeal: null`. No board notice, appeal, ownership or enforcement permission is inferred from a role label.
The existing board `:takeDown` command records its reason in the same transaction as its action and native receipt;
replay authorizes before reading that receipt. No board lift command currently exists; the trusted `liftTakedown`
port remains limited to thread/post appeal reversal. Older actions without a retained decision remain unavailable.
New decisions record the original command transaction id and board scope; existing rows keep nullable provenance,
without reconstructed reasons or an action-history backfill.

The `content.moderation_decision` effect projects `content.moderation_decision_board` from committed takedown events.
The board index stores only decision and target references plus decision time; it contains no statement, report
evidence, reporter identity or decider identity. Projection upserts converge on replay. A page admits at most
`limit + 1` board-index candidates through separate all-kind and exact-kind B-tree seeks and hydrates at most `limit`; it rechecks board `moderation:takedown`, target
`moderation:takedown`, current target ancestry and the existing exact decision disclosure for every returned entry.
Denied, erased, stale or out-of-board targets are omitted while the cursor advances past examined candidates.
Exact reads preserve the existing affected-author branch independently of target erasure; moderators require
a current available target, and history always checks current target/parent availability.
No descendant, partition, report, grant or account scan discovers a page.

At a fixed page limit L, a page uses at most `3 + 3L` anchored snapshots: board authority before and after, one
board-index seek, and up to three bounded target/source/authority snapshots per selected candidate. The index seek
reads at most L + 1 rows; each target check and exact decision read is a point access with existing finite Access
evidence. A duplicate event keeps one candidate. Erased decider identity is never indexed or returned; existing
account-erasure processing retains the statement under its 183-day rule and blanks it at the existing expiry.
The exact reader also withholds an erased decider's expired statement even if the purge worker is delayed; the
decision metadata remains readable with an empty statement. This guard does not expire other retained reasons.
Responses are private/no-store and the history is not a public feed or search source.

### Cost: board action and command replay

- Touches: `moderationRoutes` → `takedown` → `mutateContentPoint` → `prepareAuthorizedPoint` /
  `mutateAuthorizedPoint`; shared `accessCommandAuthorization` executes before the native receipt lookup.
  `prepareDiscoveryMutation`, `discoveryMutationAuthorization`, `lockDiscoveryMutation` and
  `applyDiscoveryMutation` remain the actual Realm discovery fence callsites. No interface or new collaborator
  is introduced. `registerContent` registers `contentEffects`, including `createModerationDecisionEffect`;
  the shared effects relay owns durable enqueue/checkpoint/retry, not the HTTP caller.
- Bound: the authorized source body adds one point `read-erasure-scope`, one board UPDATE, one decision INSERT
  and one registered takedown event. The inserted decision stores the live `currentCommand(tx).transactionId`;
  native command completion, receipt and outbox share its transaction. Replay has the same current authorization
  and scope probe, one exact receipt lookup and no second action/decision/event. Realm discovery adds its existing
  finite preparation/fence/source commands; it does not synchronously enumerate affected threads. Their command
  controls, source-fence witnesses and original-history writes belong to the existing command/discovery bound,
  not a constant inferred from observed test totals. No board lift or downstream Search completion is claimed.
- Growth check: `test/content/moderation-board-decision.test.ts` executes action and replay in the same native
  three-scale journey as projection and inspection. Runtime success requires this test on the integrated source.

### Cost: history projection

- Touches: the registered effect validates the takedown schema and original partition/epoch/position, reads the
  source decision by its unique `(route,target_kind,target_id,security_revision)`, resolves its recorded board
  scope, releases the source snapshot and upserts one board-local reference. A board has no author recipient.
- Bound: board projection uses exactly two transactions, each BEGIN + partition PK + body SQL + COMMIT:
  eight statements, four transaction controls, two partition rows, at most three source relation rows
  (decision/post/thread; board and thread branches use fewer), and one inserted or conflicting index row.
  The source SQL's scalar input and equality-join intermediates are each bounded by one; no history range is read.
  Thread/post decisions additionally use the existing single-recipient preference/notice path after releasing both
  source and board checkouts. Duplicate delivery repeats the same finite upsert; there is one candidate per decision.
- Growth check: the native journey completes the registered durable command effect, re-enqueues the same envelope,
  and directly repeats that registered projector. Its three-scale operation repeats the real point/write path.

### Cost: exact decision read

- Touches: `readModerationDecision` reads one decision/optional appeal and one current target placement, then prepares
  current target Access for a moderator and checks it in a fresh anchored snapshot. The author shortcut remains
  thread/post-only. Statement expiry is one scalar condition inside the exact decision SQL.
- Bound: at most two snapshots, each BEGIN + partition PK + COMMIT; two additional source statements read at most
  two decision/appeal rows and two target/parent rows. Thus eight Content statements, four controls and six physical
  relation rows, plus one Access preparation and final formula. SQL equality-join/UNION intermediates remain singleton;
  no decider account lookup, old decision search or expiry range is added. Source absence needs only the first snapshot.
- Growth check: the journey reads the original exact board decision as other decision history grows. Focused outcomes
  separately cover author/stranger disclosure, removed authority, erased decider and reason expiry.

### Cost: scoped history page

- Touches: `listModerationHistory` prepares board Access once, checks it before/after, reads one board-bound index
  range, and hydrates each admitted raw key through current target Access, `moderation-history-target.sql` and the exact reader.
- Bound: let L be the requested limit (1–100), B=L+1 (at most 101 raw keys), and H≤L the selected raw candidates.
  There are at most `3+3H` anchored snapshots, `12+12H` Content statements including `6+6H` controls, and
  `5+B+9H` physical relation rows: partition rows `3+3H`, B index rows, at most `2H` current placement rows,
  and at most `4H` decision/appeal/target/parent rows. Board existence adds two PK statements/rows across initial/final checks;
  each selected target uses one placement statement with at most two PK relation rows for posts. Plan intermediates add only bounded scalar inputs and singleton equality joins;
  physical plan/tuple evidence, including withholding, is retained by the native growth harness.
  Access adds `1+2H` preparations and `2+2H` final formulas. Preparation calls the actual `permission.ts` callees:
  one permission-time scalar, at most one assignment/account join, at most two membership-inverse ranges (each
  capped by `MEMBERSHIP_LIMIT=1000` plus one coverage row), at most two selected-target/Global candidate formulas,
  and at most D=2000 matched organization/Realm role readers. Each final formula is one SQL statement. For I≤2
  identities, R≤2I×1000 role records and K configured grant roles for the action, the owner declaration in
  `access/work.ts:accessNativeDeclaration` expands candidate/formula native probes as
  `P=T×(R+2I)×J`, `N=P×(K+4)`, and rows as
  `N+assignment+1+T+(R+2I)+J+P+T×J+6T`, with T≤2 and J=1 here. Organization role dependencies are one
  statement/five native rows each; Realm dependencies use the registered owner's finite current-role producer.
  Missing owner producers are unavailable seams, not zero-cost successful callbacks. These are actual callee terms,
  not measured caps: `Q_fixed + B×(Q_decision+Q_current_authority+Q_retention) + D_total×Q_dependency`, with
  `D_total≤(1+2H)×2000`. HTTP authentication, session recording, admission and native command controls are shared
  caller work, additional to these engine terms. Memory is O(B+D_total), with at most four concurrent role reads.
  Both all-kind and exact-kind seeks include their complete board/selection/order prefix; no filter can scan
  unrelated kinds, no request refills a sparse page, and cursor progress follows raw keys rather than returned rows.
- Growth check: dataset construction renews credentials through native Auth between batches, outside measurement;
  the same native journey records and projects 256/1024/4096 thread decisions through native commands
  and original events, growing receipts and discovery ledgers with retained history rather than isolating synthetic
  decision rows. Under fixed L=1 it measures
  action/replay/projection/exact/all-kind/exact-kind/sparse continuation together, and retains strict indexed physical
  access-path assertions. It checks that changing selection refuses a signed cursor and denied candidates do not refill.
  This source declaration is distinct from successful native execution and main promotion.

## Appeals

Each thread or post takedown stores a decision with its target, action, moderator's statement (the takedown
`reason`), internal decider identity and time. The takedown response exposes only `securityRevision`; the author's
inbox supplies the decision link. Its author can read the decision even though the target is taken down, including
the statement and appeal deadline, but not the decider identity. An unrelated account receives 404. A takedown
marks the target's open reports `actioned`; a moderator can instead mark an open report `dismissed`. A report
receives at most one outcome and one outcome notice. A later takedown does not replace an already dismissed outcome.

Only the target's author may appeal, once per decision, with a statement of at most 2,000 characters. The appeal
deadline is the decision time plus 183 days, inclusive; the next instant is late. A second appeal returns 409,
including after resolution. A first appeal after the deadline returns 422. An unrelated account cannot read or
appeal the decision (404); an overlong statement returns 422 without consuming the author's appeal opportunity.

An account with `moderation:takedown` on the target, other than the original decider, resolves a pending appeal
with a statement. The original decider and accounts lacking that authorization receive 403. `uphold` keeps the
takedown. `reverse` restores the target, makes it readable under its ordinary disclosure rules, raises its security
revision and emits a restore event. The resolution notifies the appellant with a mandatory moderation outcome.
Pending appeals appear alongside reports in the moderator queue and leave it on resolution. Board and thread appeal
list rows include the decision statement and its `{ kind, id }` target, plus `canResolve`, which is true only when
the current `moderation:takedown` check succeeds and the viewer is not the original decider. It is a current list
capability hint; resolving always repeats authorization at command time. List responses never include decider
identity. This scope covers content targets only, not other owners' takedowns.

The executable API contract is `specs/content-notification-outcomes.test.ts`, with the test-only interface in
`specs/content-notification-driver.ts`. `CONTENT_NOTIFICATION_DRIVER` selects a real product binding exporting
`createContentNotificationDriver()`; without it every scenario fails with
`Content notification outcome driver is required`. The suite remains red until that binding and the product
implementation exist. The specification verifier checks this intentional red state without substituting a driver.

## Linked post location

`GET /v1/threads/:id/posts/:postId/location` returns only `{ cursor: string | null }`, private/no-store. The cursor
uses the existing `content.posts` signed binding (thread, viewer, partition epoch and expiry). Null starts the first
page. Initial and final ordinary exact post disclosure must admit an available post in that exact thread; absent,
foreign-thread, withdrawn and unreadable posts all return the ordinary 404. A location grants no reading authority:
`post.list` independently checks current disclosure, including after a withdrawal between location and use.

Between those checks, a same-partition SQL seek reads one exact target and at most one predecessor in the existing
`(route, thread_id, created_at, post_id)` index. It preserves timestamp microseconds and the UUID tie-breaker, including
when the predecessor is unreadable. No predecessor content or identity is returned outside the signed cursor.
`POST_LOCATION_BOUNDS` states two native exact reads (each with the existing 33-node ancestry cap) plus two indexed
keys; total cost is `2 * nativePostRead + 2`, with logarithmic seeks independent of thread length. The subsequent
ordinary reader retains its own finite 200-candidate/100-result ceiling. A linked post takes precedence over a page
cursor; unavailable links recover at the thread beginning, while Next continues without the locator.

## Atomic content commands

Thread and post creation validate the complete document before inserting either the thread or post.
Validation stays inside the authorized command body, after receipt lookup, so replay retains its committed
identities without revalidating a later head. Thread, opening post, revision, author grants, media claims,
receipt and events share the native transaction; revision insertion and head advancement share it too.
A failed validation or transaction leaves no content or author grant from that attempt. Retrying a rejected
request with the same key may succeed because rejection stores no receipt.

## Post revision provenance

Ordinary site edits omit `licence`, allowing the native revision command to inherit the stored SPDX identifier.
New posts retain the site's default licence. This journey offers no relicensing control. Edits preserve the
canonical document and its block IDs, and a 412 retains the author's draft for recovery.

The post and history interfaces display each revision's own `subjectIds`, licence and optional `voteCitation`.
Current thread references and later votes never replace these immutable values. Labels reuse the existing bounded
Semantic subject summaries: one deduplicated page-level lookup within the four-subject display bound. Every stored
reference remains visible; unresolved labels use neutral reference text and the recorded ID without a link.
History retains its 20-revision cursor page; label resolution adds no per-revision requests or history walks.

Readers see citation units, question ID and vote revision. Only the authenticated author can receive a differing
current vote through the existing own-vote GET. An absent, cleared or unavailable own-vote read adds no comparison.

## Reviews

Global Context may hold several reviews boards, and a Realm one.

A review is a thread of kind `review` on a reviews board, with exactly one target subject. Its opening post may
cite the author's current vote by question, units and revision. Each citation is stored on an immutable post
revision and is never rewritten when the vote changes; a later post revision may cite a newer vote.

The review thread, its posts and its revisions live at the author's route, in the author's partition. This keeps
the vote primary-key read and the one-live-review index probe in the same partition as the write, and distributes
a popular board's reviews across authors instead of accumulating them in the board's partition. At most one live
review exists per author, subject and board. Deleting its opening post releases that slot; restoring it reclaims the
slot only if no other live review holds it.
A review creation conflict returns 409 `conflict` with optional `existingThreadId` identifying the author's live
review on that board, omitted if the review disappears before the point read after rollback.

`createThread` checks the board purpose during its existing board validation: reviews require a reviews board,
and discussion threads require a discussion board. The `board_identity` trigger makes purpose immutable, so this
command check cannot race a purpose change. Thread insert and update triggers never read the board. Board
listings and the subject thread index receive reviews through the same projections as discussion threads whose
boards live in other partitions.

### Public review discovery

`createReviewDiscoverySource` exports the Search producer contract: `ReviewDiscoverySource`, `IndexedReview`,
`ReviewDiscoverySummary`, `ReviewDiscoverySnapshot`, `ReviewDiscoveryHydration`, `ReviewDiscoveryPageKey`,
`ReviewDiscoveryPage`, `ReviewDiscoveryIncompletePage`, `ReviewDiscoveryHomeObservation`,
`ReviewDiscoveryContinuation`, `ReviewDiscoveryPopulationPage` and `ReviewDiscoveryCount`. Search keeps the existing
thread ID as the document identity. `sourceVersion` is an enumerable opaque value on candidate, read and hydration
records; it is equality evidence for refresh ordering, never disclosure authority or content identity.

The `rv1_` value is SHA-256 over the review ID, opening revision ID, thread security revision, opening-post security
revision, latest unique per-review receiving journal position, and each observed dependency home with its own epoch
and position. The latest journal position is allocated by the review-partition receiver from an authenticated original;
replaying the same original does not allocate another position. Positions from different homes remain keyed by home and
are never compared as a shared clock. Native home observations also make an unincorporated scope or Access change
change the version or make readiness incomplete. Current `readSubjectThread`, `accessCheck` and
`readSubjectReference` results remain authoritative. A delayed invalidation can change the equality version, but it
cannot restore old content or make a concealed review public.

Each current candidate comes from native thread, board, opening-post and lifecycle rows. Anonymous
`readSubjectThread` checks the current containing board, Realm/Space placement, source fence, review lifecycle,
author standing and opening post. The separate Semantic subject read checks the pinned subject and anonymous
`subject:read`. Protected or stale candidates are omitted; only current hydration determines whether a Search refresh
adds or removes the document. Count remains explicitly unavailable until a bounded native census can prove every
anonymous gate without exposing a protected population. Realm discussion-popularity counts continue to exclude
reviews.

#### Retained census installation

Decision: retain candidate installation as a private native projection; exhausting it remains `preparing` until
complete native eligibility authority and physical work have been established.

`createReviewDiscoverySource` additionally returns `NativeReviewDiscoverySource`, with
`maintainCensus(partition): Promise<ReviewCensusStep>` and
`censusCoverage(partition): Promise<ReviewCensusCoverage>`. The types and `createReviewCensus` are exported from
`review-census.ts`. This is installation groundwork, not the completed public-total capability. Search's existing
`count`, page, query-count adapter and final hydration retain their contracts. Web remains the owner of the existing
review reader, personal score/write-review controls and action/recovery experience; that experience is pending.

Each maintenance call consumes at most one existing coherent native page. It commits the signed continuation, cut,
generation and private contribution deltas together. A resumed factory uses the same stored key; duplicate workers
CAS the installation revision and cannot apply the same delta twice. Each replacement subtracts the previous
contribution in the same generation before adding the current observation. The retained episode keeps original
board/place, target Subject, opening revision and real `sourceVersion`, even after a later generation or physical
source removal. A changed cut starts a new generation without deleting old cleanup identities. No review body or
author presentation is copied into this store. Normal producer pages never include the private episode envelope.

Installation writes follow the existing native candidate projection transaction: they fence the owning home and
do not allocate a domain publication position. They release the checkout before native owner hydration. The final
CAS reobserves core home metadata and native lifecycle progress; it cannot certify missing authority coverage.
`installed: true` means the candidate keyset was exhausted at its captured cut. It never means a complete anonymous
count, including for an empty partition. Native maintenance registration, ongoing invalidation repair, complete
Access/citation/Semantic/source proof, ready total/current equality and three-scale physical acceptance remain to be
delivered together before this installation may back a public total.

##### Cost: retained census page

- **Touches:** one coherent producer page and its real Content/Access/Semantic owner calls; one installation point
  before that page; one locked installation point, bounded previous-contribution points, retained episode inserts,
  contribution replacements and installation CAS after it. The existing coherent cut is reobserved before writes.
- **Bound:** the page retains at most 100 episodes and 256 home observations. Installation adds at most 14 SQL
  statements and four transaction controls to the existing coherent-page operation. Previous contributions use
  exact `(route, thread_id)` keys; episode conflicts and foreign keys use exact `(route, thread_id, source_version)`
  keys. This bounds the store's work only. Nested authority examined rows/bytes and complete invalidation coverage
  still need derivation and Performance review before any public count ceiling or completeness claim.
- **Growth check:** `test/content/review-census.test.ts` exercises native exact-target writes, resumed installation,
  duplicate completion, revision replacement, retained cleanup keys, empty installation and fenced reads. The
  independent 256/1024/4096 installation/transition/count measurements remain pending.

##### Cost: installation coverage

- **Touches:** one installation primary-key read and the existing native cut observation; no candidate page,
  contribution history, body, member enumeration or author presentation.
- **Bound:** at most four SQL statements and two transaction controls, one installation row, at most 256 keyed
  home observations, one indexed pending-work probe and one native frontier point. Changed, missing and fenced
  observations cannot report installed coverage. An installed cut still reports missing native eligibility coverage.
- **Growth check:** the focused census test distinguishes preparing, stale, empty and unavailable without reading
  retained episodes on a coverage request; three-scale physical coverage measurement remains pending.

`read` and `hydrate` accept at most 100 IDs from one partition. Legacy `page` keeps its key and result shape and accepts
the initial page position as an optional `cut`. A continuation without that cut returns `cut-required`; a changed
partition position returns `cut-changed`, with no rows or exhaustion claim. This source-partition cut detects late
local publications, but it cannot prove that all cross-home eligibility dependencies stayed stable. Search currently
uses this legacy interface; its pages do not claim the stronger population coverage below.

`pageWithCut` is the coherent continuation API. It signs the full last-examined `(route, thread ID)` key, population
frontier and all source/dependency home epoch and position observations. It raw-seeks every review identity, including
concealed or withdrawn candidates, and captures dependency rows before owner reads. It reobserves the same finite home
set after final hydration. A changed cut returns typed `changed`; pending invalidations return `preparing`; missing or
fenced native capabilities return `unavailable` with the named capability. Passing a bare key returns
`preparing` with `missing: population-cut`. New eligibility behind the raw frontier changes the source-home cut and
requires a restart. Installation, an empty eligible page, the durable census frontier or a local partition position
alone never certifies full population coverage.

Both page paths accept limits 1–25, seek at most `C + 1` rows for `C = 4L ≤ 100`, hydrate at most C candidates and
advance by the last examined full native key. Concealed rows count against C and are never refilled. Empty and sparse
pages preserve that progress; a continuation is returned only when an unseen raw row exists. `pageWithCut` reads at
most `D = 512` dependency rows and retains at most `H = 256` distinct homes. Exceeding either bound is typed
unavailable. The population index supports the ordered raw seek, the latest-change index supports the keyed journal
probe and the pending-work index supports the fixed existence check. No all-partition scan, count sweep, history walk,
request-time replay or second candidate store is added.

Decision: keep Search's `page(..., cut)` contract compatible and require signed `pageWithCut` for coherent continued-population coverage.

#### Cost: current reads and hydration

- **Touches:** at most L ≤ 100 candidate identities, D ≤ 512 dependency rows, H ≤ 256 keyed home observations, one
  before and one final observation, two bounded pending-work probes and two bounded frontier reads. Each public
  candidate gets one Content owner read and one Semantic subject owner read. Concealed candidates return no document.
- **Bound:** fixed producer work is at most 9 SQL statements and 6 transaction controls before owner calls. Define
  `ContentOwner = (Sc, Kc)` for the bounded `readSubjectThread` plus its Access callees, and `SubjectOwner = (Ss, Ks)`
  for `subject:read` authorization plus `readSubjectReference`. Then SQL statements are at most
  `9 + L × (Sc + Ss)` and transaction controls at most `6 + L × (Kc + Ks)`. The existing owner methods retain their
  deadline, row and ancestry bounds. Dependency lookup is keyed; observations use partition keys; pending work and
  lifecycle version use their partial/latest indexes.
- **Growth check:** `test/content/growth-review-discovery.test.ts` measures current hydration after committed lifecycle
  changes at 256, 1024 and 4096 native reviews.

#### Cost: legacy partition-cut pages

- **Touches:** one ordered eligible seek of at most C + 1 candidates, dependency rows for at most C selected
  candidates, two cut observations and at most C current owner hydrations.
- **Bound:** fixed producer work is at most 9 SQL statements and 6 transaction controls, plus
  `C × (Sc + Ss)` statements and `C × (Kc + Ks)` controls. L ≤ 25, C = 4L ≤ 100 and D ≤ 512. This preserves the
  established Search call shape, but the root-only continuation cannot certify cross-home population coverage.
- **Growth check:** the same three-scale test checks sparse page progress and current hydration.

#### Cost: signed coherent population pages

- **Touches:** one ordered raw seek of C + 1 rows, D dependency rows, two population observations over H homes, two
  indexed pending-work probes, two indexed frontier probes and at most C current owner hydrations. Continued pages
  also reobserve the prior signed cut before seeking. The durable lifecycle receiver still delivers identity-only
  work in fixed pages of at most 100 keys; the source does not infer receiver or Search drainage from Content work.
- **Bound:** an initial page uses at most 8 fixed SQL statements and 6 transaction controls; a continued page uses at
  most 11 and 6. Add `C × (Sc + Ss)` statements and `C × (Kc + Ks)` controls for owner calls. C ≤ 4L ≤ 100,
  L ≤ 25, D ≤ 512 and H ≤ 256. These are whole-journey bounds, including empty and concealed candidates; no
  refill loop resets the deadline or work budget.
- **Growth check:** `test/content/growth-review-discovery.test.ts` checks the 256/1024/4096 native populations,
  committed lifecycle invalidation, current reads, physical rows/statements/controls, bounded frontier memory and the
  ordered population index without a sort.

Search owns the journal receiver, exact target writes, committed receiving progress, generation writer and default
supervisor. Its current producer adapter consumes legacy `page(..., cut)` and enumerable `sourceVersion`; adopting
`pageWithCut` remains necessary before Search can claim coherent cross-home continued coverage. Content changes here
do not infer Search convergence or main promotion.

### Review discovery lifecycle and Search handoff

Decision: retain identity-only invalidations, including concealed and disappeared reviews, and require current
native refresh before Search applies each receiving partition's ordered progress.

The actual shared callsites are `createContentWork` → `registerReviewDiscoveryWork` and the default
`registerContent` → `createContentWork`. They register `content_review_discovery_source` for the closed
`REVIEW_DISCOVERY_SOURCE_TYPES` original-event list, `content_review_discovery_dispatch` for
`com.rezics.content.review-discovery.opened.v1`, and the `content.review-discovery.invalidate` DBOS workflow.
No Search source interface, registration, generation writer or query consumer is changed. No route is added.
The existing post-revision HTTP handler spreads `RevisionInputSchema` into `revisePost`; that handler and native
`revisePost` callers are the shared title-revision callsites. An optional `title` revises only a review's opening
post, under its existing author, revision precondition and authorization, in the same transaction as the body revision.
It emits the existing original revision event, so a title-only edit still supplies a fresh current body revision.

Thread creation, opening title/body revisions, opening publication, soft deletion, restoration, takedown and
erasure invalidate their retained review identities. Replies have no opening-post dependency and therefore produce
empty source progress. Native subject lifecycle/identity events, account standing events, Realm/Space lifecycle,
Realm bans, board schemes, subject publication verdicts, resource grants and source-fence takedowns feed the same pipeline. A gate event never supplies a public
review document. Native reviews that began protected are present in the identity dependency directory and can become
public on a later gate refresh. Withdrawn and physically missing reviews retain their directory entries so removal
is delivered. Originals naming a thread directly invalidate that exact identity even when it disappeared before
the directory backfill. Board, pinned subject, author, opening post and immutable Realm/Space ancestry supply dependency keys;
old keys remain useful for removing stale hits after native identity changes. The migration backfills these keys,
without a second public census or eligibility projection. Source tuples use the existing native
`semantic.source_candidate` relation and an exact `(route,source,external_id,field_group,subject_id)` index.

An original must match the retained `core.outbox` envelope, including data, subject and event index. An unavailable
or minimized original throws; it does not acknowledge missing work. Source work stores original partition, epoch,
position, event index, ID and type, plus identity scopes and a versioned continuation. It stores no old review text,
permission snapshot or author presentation. Every page reads at most 101 dependency identities, delivers at most 100,
then CASes its source continuation. Receiving commands are grouped by native review partition. Source, receiving
and continuation transactions release their checkouts between operations, including with a one-connection Pool.
A crash after any receiver commits repeats those identities before the source cursor moves. Unique original/review
keys make that replay idempotent. Different original positions are all retained; reordered native events therefore
request current hydration instead of restoring an older payload. Source-fence work additionally persists the subject
cursor and never walks all records belonging to a provider. Public exposure changes conservatively invalidate the
entire identity directory because a group may gate any ancestor; this is bounded identity work, with no review body scan.

Search's exact consumer event is `com.rezics.content.review-discovery.changed.v1`, registered in `CONTENT_EVENTS`:
`{partition, through, ids, origin:{partition,epoch,position,eventIndex,id,type}}`. `through` is the receiving journal
position; `origin.position` is the lossless original native log position, never the receiving event's position.
The event is a wakeup; replay/catch-up uses `readReviewDiscoveryChanges(pool, partition, after, limit, through?)`
from `review-discovery-changes.ts`. Start `after` at `0n`; limits are 1–100. Continue with `next` and the returned
fixed `through`. Empty and final pages advance `after` through that cut. Changes include every identity regardless
of present eligibility. Positions from different original partitions are never compared. The append-only journal
has no pruning or expiration that could silently lose an unacknowledged removal.

`refreshReviewDiscoveryChanges(source, page)` calls the predecessor's existing `ReviewDiscoverySource.read` once
for the deduplicated IDs. It returns current `reviews`, explicit `removed` IDs, the independent `nativePosition`,
and receiving `after/through/next`. Missing rows and concealed rows both produce removals; dependency, disclosure
or hydration errors throw without advancing consumer progress. Search must serialize or CAS application per receiving
partition and commit the refresh and consumer frontier together. It must not apply a cached refresh after a newer one.
Final result hydration continues to call the existing `hydrate`, even while the index is catching up. Accounts still
owns current author presentation; Web owns reading surfaces.

`readReviewDiscoveryProgress(pool, {route,id})` exposes source work's version, completion and explicit continuation,
including empty source-fence subject ranges. Completion proves that original's current dependency keyset was
invalidated. Concurrent reviews or new source references behind a cursor have their own native creation/revision
events. Receiving journal completion does not prove that original-event dispatch is drained, nor that Search has
applied its generation. Current hydration is immediate native disclosure; index convergence still requires Search's
consumer and upstream effects progress. No collaborator query, indexing adapter, global convergence certificate or
native/main promotion proof is fabricated. New external gate event types must be connected explicitly by their owner;
raw SQL fixture changes and gate changes without a committed original event cannot wake a worker.

#### Cost: original admission and dispatch

- Touches: one exact retained outbox event, one source work key, one native command; dispatch adds one exact task read
  and one durable enqueue with a stable workflow ID.
- Bound: constant rows per original; at most eight identity scopes, no review scan or hydration.
- Growth check: focused lifecycle tests replay the original and enqueue, retaining one source task and stable workflow
  identity. No elapsed-time, native/main or broad growth result is inferred from this bound.

#### Cost: cross-partition invalidation page

- Touches: one source work key, one dependency index range (101 rows), at most 100 receiving identity writes and a
  receiving frontier per affected partition, then one version CAS. Every committed mutation emits a registered event.
- Bound: at most 100 receiving commands, 100 journal writes and one source command per page; receiver replay probes
  at most 100 exact keys twice. Source tuples add at most one indexed subject probe per page. Resource-key duplicate
  dependencies are bounded by the finite native ancestor keys. Work grows with affected identities, not all reviews
  or provider history; global exposure changes affect the complete directory.
- Growth check: the focused lifecycle test adds more than 100 disappeared identities across native partitions and
  unrelated dependencies, checks bounded examined counts, continuation, replay and explicit removal. This is a focused
  outcome/batch-bound check; physical block growth remains a dev-verifier measurement.

#### Cost: changed-source catch-up and refresh

- Touches: one active partition, one receiving frontier, at most 101 journal keys and at most 100 current review IDs.
- Bound: one sparse index range and one existing native `read` batch; current owner reads retain
  `REVIEW_DISCOVERY_BOUNDS`. No count, reply/history traversal, index query or extra public page reader is introduced.
- Growth check: focused lifecycle tests pin a journal cut while newer invalidations arrive, advance sparse progress,
  and distinguish current upserts from stale removals. Native hydration and index application remain separate costs.

## Review-backed question witnesses

`review-context-eligibility.ts` resolves an exact native rating question under current Global
`definitions:read`. `resolveRatingQuestionSelection` returns immutable metadata bound to the dependencies
and read context that resolved it. `assertCurrentRatingQuestionSelection` repeats authority and metadata
reads; a lost or revised question refuses with `invalid_cursor`.

`qualifyReviewContextWitnesses` accepts at most 160 positional pairs of primary and review witness:
`{kind:'subject'|'thread',subjectId,threadId}` or `{kind:'post',subjectId,threadId,postId}`.
The exact Subject must be readable. Its review must be live and currently readable, with exactly that
target and a readable current opening revision citing the selected question. A post additionally passes
its own native thread/parent disclosure. Ordinary discussions cannot qualify. Native thread disclosure
checks the independently anchored board, Realm, bans, author and document. Initial and final observations
must retain the opening revision and security anchors. Private votes and aggregates never enter this read.

Decision: witness inputs are positional exact primary/review pairs; deduplicated native reads preserve
duplicate positions, and a refused pair establishes no existential negative or population coverage.

The reader uses only full-key native reads, never a subject-to-review scan or a history walk. The static
`REVIEW_CONTEXT_BOUNDS` composes two question reads, at most 320 thread disclosure candidates, 320 Subject
checks and 320 post reads: at most 962 native read invocations per witness batch. Each post read retains
the existing selected-post plus 32-parent bound, hence at most 10,560 chain rows across both observations,
in addition to its native board/Realm/Access closure. These are additive producer bounds, not a runtime
quote protocol or a claim that the feed's 160 raw candidate slots pay for disclosure.

The Search request bridge retains the complete frozen Boolean tree and canonical question/revision keys.
These native point witnesses do not supply a review locator, baseline, retained Source population,
privacy-reduction routing or a feed selector. No incomplete witness page certifies nonmembership.

## Conversation contribution source

`createConversationActivityEffect(pool)` is installed by `registerContent` in the existing supervisor alongside
board ranking. It reuses `read-source-activity.sql` and native publication/lifecycle events. The source keeps
one episode per post in its thread's home, including the opening. An edit changes source progress but never
the contribution time. Erasure, takedown and restoration replace native eligibility from current post/head
state; delayed or duplicate events cannot restore an erased post. A purged post retires its retained episode.
Publication provenance is checked against the exact native outbox envelope before writing.

Decision: retain the earliest native public-publication time for each post, including across removal and
restoration; keep this internal source explicitly unproven until current cohort disclosure and repair are installed.

`readConversationActivitySources(pool, threadIds, deadline)` exports `ConversationActivitySource` and
`ConversationContributionSource`. It accepts at most 100 raw keys, deduplicates them and groups them by
represented home. Each home releases its read-only snapshot before the next starts. Each selected thread has
one ordered prefix of at most 32 native-eligible publication episodes. The partial index excludes removed
episodes, so finding the next retained contribution does not traverse removed posts or revision history.
The source preserves microsecond timestamps and returns its partition anchor. `more` is conservative.

These are trusted internal candidates, not installed Home/Search/Web activity DTOs. `coverage: 'unproven'`
is mandatory, including for an empty prefix. No caller may treat its length as a reply count or return its
timestamps without current disclosure. It does not establish thread/board/Realm/account/ancestry eligibility,
does not establish completeness for pre-installation publications, and does not include a protected-only
publication that has never had a native public-publication event. Existing hot/active/new ranking is unchanged.
Current disclosed batch figures, bounded repair and Board/thread/Subject integration remain to be delivered.

### Cost: contribution effect

- Touches: one native thread home and its registered supervisor effect; no Access preparation, document bodies,
  foreign checkouts or user receipts. The exact outbox position prefix proves the event. Each of at most 100
  event-named posts has one post PK lookup, one same-home thread/post source lookup and one episode PK upsert;
  a missing post uses one episode PK retirement instead of the source lookup/upsert. The command emits at most
  one registered event containing at most 100 UUIDs. The supervisor still owns dispatch/checkpoint work.
- Bound: local body statements are at most `1 + 3p`, for `p <= 100`; proof examines at most the envelope's
  1,000 event slots, then each post examines at most one post, one thread, one post, one head and one episode. Returned
  metadata has no body/subject/media arrays. Add the existing `runCommand` gate, time, partition fence,
  transaction control, record-source finalization, outbox write and supervisor/runner work; the complete
  all-pool physical/byte ceiling is pending Performance review and is not claimed here. A duplicate that changes
  neither watermark, time nor native state rolls back without a new event; malformed sources do not write.
- Growth check: focused native lifecycle coverage is in `conversation-activity-native-source.test.ts`.
  Independent 256/1024/4096 post-history, unrelated-thread and runner growth with strict native plans remains
  required before this source can be used for a disclosed figure.

### Cost: selected contribution prefixes

- Touches: only represented Content homes, sequentially; no Access, account, Realm, control pool or document
  hydration. Per home: begin, partition point, one lateral-prefix query, commit; failure adds rollback.
- Bound: for `t <= 100` raw inputs and `h <= t` represented homes, at most `4h` normal statements, `h` partition
  rows and `32t` episode rows through `(route, thread_id, contributed_at DESC, post_id DESC)` with the exact
  partial-index predicate. Input is at most 100 route/UUID pairs; each returned row is two UUIDs, a boolean and
  one 27-byte timestamp. The final grouped order sorts at most `32t` selected rows. No unrelated keys or inactive episodes are requested.
  Empty input performs no checkout; invalid/oversize input performs no SQL. Missing/moved homes throw the
  shared unavailable error rather than returning an empty figure. This bound covers the internal source only.
- Growth check: the focused native test covers an opening, replies, next remaining contribution, edit,
  restoration, delayed publication, duplicate replay and deduplication. Strict EXPLAIN-prefix and three-scale
  all-pool checks, current-disclosure work and externally usable byte ceilings remain deferred.

## Subject threads

`GET /v1/subjects/{subjectId}/threads?place={id}&kind=discussion|review&limit=&cursor=` returns a subject's threads
for one Global Context or Realm and one kind. `limit` is 1–20, default 20. Results are ordered by last activity,
newest first, with the indexed thread id as a stable tie-breaker. The signed keyset cursor binds the subject, place,
kind, viewer and subject partition epoch. It does not use an offset or a count.

The response retains `threads` and `next` and adds required `context: {subject, place, kind}`. Subject identity
uses Semantic's `readSubjectReference` and Content's installed current label disclosure
`prepareEditionSubjectIdentities`; a readable Subject without a label carries `label: null`. The Subject's
`source: {partition, epoch, position}` is the actual Semantic reference component, with its position serialized
as a decimal string. Realm identity uses the ordinary `readRealm` result: its exact id, current title, Space id
and head revision. Only the exact Global Context id produces `place.kind: global`. Missing and concealed Realms
both return 404, including on an empty index; they never produce a Global page.

Decision: retain requested Subject/place keys, conceal redirected Subject identities, and fail the page when
a required current context observation changes; context conveys no creation or command authority.

`prepareSubjectThreadContext(dependencies: ContentReadDependencies, subjectId: string, placeId: string,
kind: 'discussion' | 'review', context: ReadContext)` returns `{finish(): Promise<SubjectThreadContext>}`.
Preparation releases the Subject home before opening the Realm home. After bounded native candidate disclosure,
`finish` repeats ordinary Realm/Subject reads and compares the actual observations, including the Semantic source
component and Realm head. A current denial returns 404; a changed observation returns the ordinary 503
`dependency_unavailable` problem, preserving the caller's input cursor for retry. Operational failures propagate;
they cannot become a missing label or a successful empty page. The Author list keeps its existing response schema.

For example, a readable unlabeled empty Global review page has
`{threads:[],next:null,context:{subject:{id,label:null,source:{partition,epoch,position}},place:{kind:"global",id},kind:"review"}}`.
A concealed selection returns the ordinary 404 problem without context or threads; a failed or changed required
observation returns the ordinary problem without an advanced cursor. Existing native `ThreadView` entries still
lack the shared current interaction/action card and Home parent/target-context projections; those producers must
be installed before composing their recorded citations, reactions, activity and command advice here. The current
page context does not certify any such action or rendered Web acceptance. Derived OpenAPI/client publication and
the Web binding review remain with the controller and existing Subject interface owner.

### Cost: listSubjectThreads context

- Touches: one label-disclosure preparation round, then two Subject observations, each sharing one released
  repeatable-read snapshot between the Semantic reference and current label reader. Each observation prepares
  ordinary Subject Access outside that snapshot and evaluates it inside; the label reader additionally evaluates
  its prepared native Subject check. For a Realm selection, two separate ordinary Realm reads include current
  Realm/Space binding, membership/ban and native Access work. Global needs neither Realm read. Add the existing
  selection partition/Subject Access snapshot and up to 80 raw candidate ordinary disclosures, stopping at 20
  outputs. Every disclosure retains source chains, Board/place/Realm checks, citation/history and final authority
  costs from its native reader. No connection spans the Subject, Realm and candidate phases. Denied preparation
  stops selection; final failure withholds the whole page. Transaction controls, pool releases and nested Access
  preparation/executor/fence work remain charged even on empty or denied branches; a retry repeats these phases.
- Bound: the selection prefix is `(route,subject_id,place_id,kind,last_activity_at DESC,thread_id ASC)`;
  candidates use exact route/identity source probes, without a second index, refill, totals or reordered output.
  Context adds one Subject and at most one Realm. Subject reference uses route/id plus the latest redirect seek;
  current labels include the native current-term view's intermediate rows, language aggregation and ordering.
  Its examined/history work must not be inferred from one chosen label. Realm title admission is 1024 Unicode
  code points, at most 4096 UTF-8 bytes or 6144 JSON-escaped bytes before serialization copies; ordinary Realm
  reads also retain summary/presentation bytes not returned in context. Chosen-label bytes and all-label
  intermediate rows inherit Semantic admission, rather than a fabricated page byte ceiling. Retained memory
  includes both initial/final context observations and up to 20 native bodies of at most 2 MiB each, their parsed
  documents and wire serialization, plus native citation/context/identity authority intermediates. No complete
  nested byte or examined-work ceiling is claimed for the pending shared card projection.
- Growth check: focused HTTP/context tests cover Global empty/populated/continued identity, readable public and
  protected Realms, anonymous denial, current Realm revision change/retry and Subject withdrawal. Three-scale
  selection/history/authority measurement, all-pool runner accounting and full withheld/failed card outcomes
  remain deferred to integration and the card-composition continuation. Performance must review the current-term,
  nested Access/citation/history and serialization terms before a complete numerical bound is adopted.

The route returns a 404 for an unknown or unreadable subject. Index rows are candidates only: each candidate passes
the current thread, opening post, board, Realm and Access disclosure checks, and the final snapshot confirms that the
thread still references the subject and its board still belongs to the requested place. Hidden or stale candidates
are skipped without returning their ids. A page scans at most four times its requested limit, then returns a cursor
when more candidates may remain. Subject counts stay with semantic.
Reads of a Realm-owned board, thread or post require `realm:read` on its containing Realm at the read's authorization time. Active members of a protected Realm receive this through the `community.realm.member` group grant. Non-members and members whose leave has settled receive the same `404` as an unknown target. Public Realm reads retain their public eligibility.

Thread-page post items have three forms: `available` carries the body and digest; `erased` is a tombstone with
`removed: true`, `body: null` and `sha256: null` for both soft deletion and purge; `withheld` carries the same null
payload while retaining the post's metadata after takedown. Replies retain their parent in every form. Only the
post's author receives `restorableUntil` while restoration is possible, or `decisionId` on a withheld item. Exact
reads of withheld posts and revisions still return 404. These fields come from the existing route-bound chain
reads, including one indexed decision lookup within each post row read; page candidate and statement bounds stay unchanged.

Threads and posts can be taken down with `moderation:takedown` on the target or on its containing Realm. Realm owners and moderators carry that action for content in their own Realm; neither a parent resource nor another Realm grants it. Authorization is checked before receipt lookup, so a denied replay remains denied. Board and media takedown authorization is unchanged.

## Deletion

Published deleted posts remain in thread pages as `removed: true` with `body: null`. Their history is empty and
exact revision routes return 404 immediately. Replies retain their parent and order. Deleting the opening post
preserves the thread and replies; thread disclosure returns `title: null` until the opening post is restored.

Posts, including thread opening posts and reviews, are soft-deleted and restorable. An author uses
`DELETE /v1/posts/{id}` with an `Idempotency-Key` and the existing `post:erase` owner permission. Success and an
authorized replay return 204 with the stored session position. One tombstone records `deleted_at`, raises the post's
security revision and emits the ID-only `com.rezics.content.post.erased.v1` event. Bodies, digests and search text
remain stored but unreadable throughout the restore window.

`POST /v1/posts/{id}:restore` requires an `Idempotency-Key`, the native author and `post:erase`. Before 30 days have
elapsed it returns 204, restores the same revisions, raises the security revision and emits
`com.rezics.content.post.restored.v1` with `postId` and `securityRevision`. At the 30-day boundary, after purge starts,
or for another account it returns the same 404 as an unknown post. A review whose slot holds another live review
returns 409 `conflict`, optionally with `existingThreadId` using the same standard problem extension as creation.
After the genuine native uniqueness failure has rolled back and discovery abort has resolved,
`readCurrentRestorationConflict(deps: ContentReadDependencies, postId: string, context: ReadContext)` returns
`Promise<{ existingThreadId: string } | null>`. It reads only the original opening review's immutable author/board/subject
metadata under fresh native `post:erase` authority and restoration eligibility, then reuses `live-review-read.sql`'s
bounded author/board/subject probe. Its result is data until a fresh ordinary `readThread` with the actual request
actor and fixed deadline independently permits disclosure and matches that original identity. The existing native
source-subject guard (`prepareEditionSubject`) also checks the pinned subject before and after the thread read.
Each home is released
before foreign authority preparation; ordinary scope, subject, board, Realm, Space, ancestor and source fences remain
in force. Hidden, revoked or disappeared destinations omit the extension; typed native unavailability can still fail
the request. Null means unknown, not absence or authority. Replies never manufacture an opening-review hint.
The HTTP route supplies its real native Access and token dependencies; consumers need no new route or claims.
Author reply candidates are rebuilt from retained creation metadata by the restored event; author thread,
board and subject thread candidates and reaction totals are retained, and current disclosure re-admits their content
at once.

The durable hourly `content.collection.hourly` sweep visits the fixed 4096 partitions, at most eight concurrently.
Media collection uses two limited index branches on each of the partition's 16 exact routes, selecting at most
3,200 candidates for a batch of at most 100. `COLLECTION_BOUNDS` records the composed ceilings: at most 300
buffered candidates, 200 sequential command phases and 100 sequential storage prefix deletions per step.
Decision: retain only the oldest batch after each route merge; this lowers the host buffer bound while preserving
selection order, expiry and claim fencing. A committed collection fence also denies first completion and receipt
replay, so neither can revive the reservation while prefix deletion is interrupted.
Each partition visits its 16 routes. `page-deleted-posts.sql` selects at most 100 expired posts per durable step through
`post_deleted_page_idx(route,deleted_at,post_id)`. Each post gets an irreversible purge fence before its revision
pages, so restore cannot race cleanup. `clearErasedPostRevisions` clears bodies, SHA-256 digests and search text together
in existing `null-erased-revisions.sql` pages of 100, releasing the connection between pages. Completion removes the
post from the partial selection index. Each revision page is a durable step whose stored output preserves the cursor
after a worker crash. A lost step retries unfinished work; a duplicate erased event before expiry or
after completion changes nothing. No available post is changed. The purge's selection has constant statements and
at most 100 rows per page; body work is linear in affected revisions, without rescanning completed posts.

Moderation `:erase` routes and account author-erasure workflows retain their immediate, irreversible cleanup.
Reaction and vote clears change an answer in its slot rather than delete a record. Reports retain identifiers and
decisions. Media and authored documents are closed behind grants and still erase immediately; soft deletion for them
is a gap. Legal holds are not implemented and remain a gap.

Media owners erase their own media with `DELETE /v1/media/{id}` and an `Idempotency-Key`. The route requires the current
media owner and denies collection-pending media; success and authorized replay return 204 with the stored session
position.

## Author items

`content.author_item` keeps candidate threads and replies on the author's route for profile reads. The
`content_author_item` effect handles thread creation, reply creation and ID-only post erasure and restoration with one
guarded command in the author's partition per event. `actorId` supplies the author and the creation event's `activityAt`
supplies its original creation time, including microseconds. Thread creation emits only `thread.created.v1`, whose
`itemId` is the opening post; the index stores the thread identity instead, so the opening post is never a reply.
Both discussion and review threads retain their kind, and replies retain their containing thread. Erasure and
restoration read the retained post's author by primary key in the thread's partition and release that connection before
the author command. Missing posts and unchanged rows do nothing; receipts make committed replay inert and the source epoch
and position guard rejects stale writes. No backfill is needed.

`GET /v1/accounts/{accountId}/threads?kind=discussion|review&limit=&cursor=` returns `{ threads, next }` in
board-list summary shapes. Kind defaults to `discussion`; reviews use their own section. Threads are ordered by
creation time descending, then item id ascending. `GET /v1/accounts/{accountId}/posts?limit=&cursor=` returns
`{ posts, next }`: reply entries include `thread: { id, title }`, with a null title when thread disclosure hides it.
Opening posts belong only to the thread list. Both limits are 1–20, default 20.

Each page reads the account's public views once in its own partition before scanning candidates. The `posts` view
controls discussion threads and replies; the `reviews` view controls review threads. A private view returns an empty
page with `next: null`, except to the account itself or a viewer authorized by the existing `account:update`
presentation rule, including an organization's acting owners. The view read shares the candidate page's repeatable-read
snapshot, which commits before thread and post disclosure probes. Hiding a list does not change any item's own
visibility. Deleted, fenced and unknown accounts have private flags and empty pages.

Takedown, visibility and Realm changes are not mirrored. Index rows are candidates only: reads apply the current
thread, opening post, board, Realm and Access disclosure checks, and posts also pass their own disclosure checks.
Drafts, taken-down and erased items are omitted, including when exact reads would disclose an erased slot. An erased
opening post may still supply a reply's null thread title. Unknown, deleted and fenced accounts have empty pages from
the public-view check before any candidate scan. No membership or item count is returned.

Each page reads at most four times its limit in candidates and returns a continuation when more may remain, even
if filtering leaves the page empty. The signed keyset cursor binds account, list, thread kind, viewer and author
partition epoch. Its keyset position is also encrypted so a skipped item's identity cannot be decoded from the
continuation. Two disjoint index seeks handle timestamp ties and older rows within one combined scan budget;
there is no offset. The thread index includes kind, while a separate partial reply index spans both thread kinds.

## Sitemap feeds

`GET /v1/sitemap/boards` and `GET /v1/sitemap/threads` are the server-to-server feeds behind the sitemap shards in
[Search engines and sharing](../../../../docs/seo.md#sitemaps). Both declare `x-exposure: public`, use the public read
rate limit and return `{ items, next }`, where every item carries `lastModified` (an RFC 3339 instant). A board item is
`{ id, lastModified }`; a thread item is `{ id, title, lastModified }` with a `null` title when the thread shows none.
The kernel returns no URL or slug; web builds them. `SitemapQuerySchema` and `sitemapPageSchema` in `schemas.ts` are the
shared shape that other modules' feeds reuse.

These feeds return up to 1,000 entries per page (`limit` 1–1000, default 1000), an exception to the shared list
maximum of 100. `cursor` is an opaque string from a previous `next` and is bound to its feed; any other value is
`invalid_cursor`. The position uses the shared opaque list cursor contract in
[`../tokens/list-cursor.ts`](../tokens/list-cursor.ts), bound to the feed route, anonymous viewer and empty query.
Skipped candidates reveal no identity, route or creation time.

A feed evaluates as the anonymous reader even when the request carries a bearer, and lists exactly what an anonymous
reader can open:

- **Boards:** published and not taken down, with no Realm or a public Realm, and with at least one listed thread. An empty board is a thin page and is not listed.
- **Threads:** published and available, on a listed board, passing the thread disclosure of the anonymous
  `listBoardThreads` page (the shared `discloseThreads`), with an available opening post.
- Nothing under a protected Realm or a removed board, and no draft, protected, taken-down or erased thread, is listed.

Keyset order uses immutable keys: boards by `(route, board_id)`, and threads board by board through
`board_thread_page_idx` by `(created_at, thread_id)`. A walk lists every item that stays listed for the whole walk
exactly once. Threads under protected Realms and removed boards are never read. The board feed probes threads
newest first and resumes an unfinished probe on the next page, so any number of newer hidden candidates cannot
make a board with a listed thread disappear.

Board items come in strictly increasing `(route, id)` order. Thread items are board-major: boards follow that same
order, then each board's threads follow `(created_at, thread_id)` order. Thread items do not carry either key, so a
client cannot verify their order from the response alone.

A page examines at most 4 × `limit` candidate rows. When it reaches that cap it returns what it found with a non-null
`next`, possibly with no items; clients follow `next` until it is `null`.

`lastModified` is the last significant change of what the page shows, from columns the write paths already maintain:
for a thread `board_thread.last_activity_at`; for a board its newest listed thread's `created_at` (or its own
`created_at` if there is none, though thin boards are omitted). Post edits and
removals do not advance it, and no feed adds a write-path update, index or migration.

## Reactions

People have one reaction slot per thread, post or subject. Threads and posts accept upvote, downvote, like, love, laugh,
insightful and sad. Subjects accept like, love, laugh, insightful and sad; their semantic score remains the subject's
rating. Subject reactions require the actor to be admitted and hold `reaction:set` on the Global Context (route 0),
then require the subject to be readable at the same authorization time as a subject read. After semantic setup,
`setupContent` installs this standing grant for every active account. Its independent `content.setup` installation
runs once across restarts, including after platform governance revokes the grant. Suspension ends standing for that
account. A grant on an individual subject does not authorize reactions. Unknown or unreadable subjects return not
found. A merged subject id resolves to its survivor, and the slot is written on that survivor. Subjects have no board, Realm
participation or board Access step.

Exact post GETs include the current viewer slot and projected per-kind counts through the same readers as thread
GETs, enabling a bounded point reconciliation after an uncertain reaction. This adds one actor-home slot seek and
one target-home count read (at most seven kinds) without changing native commands, the relay or ranking.

Subject reaction changes use `com.rezics.content.reaction.changed.v1` with `targetKind: subject`. The relay maintains
the existing per-kind counts and total in the subject's partition. It also maintains one `content.subject_reactor` row
per reacting account in that same partition and transaction. Clearing a reaction or erasing an account removes the
reactor row through the relay.

Each target stores the latest projected kind and source watermark independently for each actor, retaining a null
kind after clearing. Deltas come from that projected slot, never the event's previous kind; a late event for another
actor in the same source partition still contributes. Slot, per-partition counts, totals and subject reactor changes
commit atomically, with aggregate kinds locked in a fixed order. Replays and stale actor events change nothing.
Installation freezes native slot writers and rebuilds this derived state once, recording each source partition's
cutover; older events are already represented, including cleared slots. Runtime reads that one source cutover before
releasing its checkout and updating one target, with no source history scan or producer changes.

Board activity is a separate monotone value from its source watermark: a delayed post creation can advance activity
even after a revision from the same or a later envelope. Such an update retains the newer source revision and
watermark and touches only that exact board/thread candidate.

A `com.rezics.subject.merged.v1` event starts one idempotent DBOS job for the merged subject. The job reads its
`content.subject_reactor` rows in actor ID keyset order from that subject's partition, up to 100 IDs per page. For
each actor it runs one command in the actor's partition and resolves the current final survivor with `resolveSubject`
at that command's T, so a later chained merge is followed. A source slot moves with its kind when the actor has no
survivor slot. When both slots exist, the source slot is cleared and the survivor slot stays. Every slot change emits
the ordinary reaction change event; the relay updates counts and reactor rows, and the merge job never writes counts.

The last actor ID in a page is the cursor. Each page step stores its result in the DBOS job state, so a restarted job
continues after the last completed page. Re-running an uncheckpointed page is safe: an actor whose slot already moved
has no source slot and produces no second change event. A final empty cursor check follows an exact multiple of 100.

Subject reactions are stored in the reacting account's partition. `readLikedSubjectPage` lists its current subject
likes and loves in subject id order, and `readLikedMembership` checks a bounded batch of subject ids. These readers
return raw stored ids: a subject can be unreadable, terminal or not yet reconciled after a merge. Commerce's Liked
binding owns disclosure and canonical identity; these functions are internal content reads, not public reads.

`readLikedVersion` returns the actor's raw source version. Page and membership reads return that same version
alongside `subjects`, in exactly one statement on the caller's client, even for an empty page or membership batch.
The version is a native `bigint` parsed from PostgreSQL int8 text; a stored copy is its canonical decimal string.
A missing `content.reaction_liked_version` row reads as version 0, the migration baseline only. It never means
empty, complete or allowed. The version says nothing about emptiness; the page says that. A version alone is never
a permission or a completeness claim.

One reaction row trigger bumps each affected actor when its like/love subject set changes, including a change
between like and love. It runs inside the reaction transaction for every writer, including subject reaction merge
writes. Changes to subject terminal state, merge-pending identity or account state never bump: the raw set did not
change. Unrelated reactions and timestamp-only updates do not bump. Bigint overflow fails the reaction write and
rolls back its transaction.

The kernel never migrates at startup. `server.ts` and `worker.ts` start after the separate migration step, so every
snapshot a version reader opens begins after the migration committed. A snapshot begun before that commit must
never read a version: its older facts would pair with baseline 0 and look current. Before the migration the readers
fail on the missing relation; they never return 0. Trigger installation waits for open reaction writers, and applies
to statements prepared before the cutover.

No path resets, expires or garbage-collects a version. Terminal account erasure must delete the version row last,
after the account's reaction rows are gone and late writers are fenced. Erasure participant work must follow this rule;
this change adds no deletion path.

| Read               | Cost                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liked subject page | One actor-partition statement, using the partial index for an index seek plus at most `limit + 1` index entries and heap rows: O(log n + limit), independent of other reaction kinds and accounts. |
| Liked membership   | One statement and one primary-key seek per requested id, for up to 256 ids: O(k log n).                                                                                                            |

### Cost

#### Selected report pages

- Touches: one board-candidate or exact-target index range of at most `limit + 1` raw references; at most
  `limit` current native report inspections, target disclosure and exact board-placement checks, plus the
  initial/final target authority fence. Status comes from the actual report, with no outcome projection.
- Bound: API limit 1–100 (default 20 on HTTP, Web fixed at 20); O(limit) point reads and O(limit × log R)
  indexed work, using descending or reverse ascending traversal. Filtered rows consume the same bound and
  advance the last examined position. No refill, total, private allow-bit index or whole-queue scan.
- Growth check: deferred to controller integration; existing report growth regressions remain applicable and
  selected current-status/sparse-cursor HTTP regressions are authored but unrun in this source delivery.

#### Subject reaction merge page

- **Touches:** At most 100 reactor IDs in the merged subject's partition; at most 100 actor commands, each with a
  constant number of statements in one actor partition; at most two reaction change events per actor.
- **Bound:** O(100) commands and rows per page; `ceil(R / 100)` actor pages for R reactors, plus an empty cursor check
  when R is an exact multiple of 100. Page work is independent of R.
- **Growth check:** `test/content/subject-reaction-merge.test.ts`, `one merge page`, at 256, 1024 and 4096 reactors on
  the merged subject. Rows and statements per page stay constant.

### Cost

#### Subject reaction slot

- Touches: account admission; one subject readability probe in the subject's partition; one slot upsert or delete in the actor's partition; at most one change event.
- Bound: constant rows and statements. Blocks O(log R) in the actor's partition.
- Growth check: `test/content/growth-reactions.test.ts`, `Subject reaction slot`, at 64, 512 and 4096 reactions on the subject.

#### Subject reaction relay

- Touches: one source cutover point read, then one actor contribution CAS, at most two per-partition count/total upserts and one reactor upsert or delete in the subject's partition in one transaction.
- Bound: constant statements. Blocks O(log R).
- Growth check: `test/content/growth-reactions.test.ts`, `Subject reaction relay`, at 64, 512 and 4096 reactors.

## Covers

Semantic cover claims through `claimMedia` delegate authority to the native cover port.
When authorization is supplied, a cover claim requires execute authorization on the subject or
`statement:propose` or `subject:create` on the Global Context, with the subject in the command partition.
Media, container and candidate retain their exact subject route binding.

A cover is a media object with purpose `cover`, named by a `schema:image` statement on its subject. One subject can have several images; the preferred-rank statement is its cover. An edition's cover belongs to the edition. A work without its own cover shows the cover of its representative edition, which the work names with one statement, so choosing a cover is one indexed read and never a scan of the work's editions. A work may name one representative edition per language; the cover then follows the same language choice as the title, so a reader never sees a title in one language over a cover chosen for another.

### Variants and metadata

Image publication decodes the original once and writes AVIF and WebP variants at fixed widths (320, 640, 960, 1280, 1920 and 2560 pixels, never enlarged; an image narrower than 320 pixels keeps its own width). The original is kept for reprocessing and never served to the public. Publication also records, on the media row:

- the original width and height, so a client knows the image's ratio before loading it;
- a placeholder: a ThumbHash of at most 32 bytes and the average colour, so the frame is painted while the image loads;
- an optional authored crop, a Media Fragments `xywh=` rectangle chosen by an editor (to remove a scan border, a store badge or a letterbox); variants are cut from the crop, and the original stays untouched;
- an optional focal point inside the crop, used when a client fits the image to a frame of another ratio.

Metadata is stripped from every variant. Variants are deterministic, so a reprocess with the same settings produces the same keys. Every image within the upload limits (20 MiB, 40 million pixels) gets variants; no valid cover is replaced by a placeholder because it is large, and no original is ever served in place of a variant.

An importer that fetches a source cover stores it through this same path, with the source's cover role mapped to `cover` (not to a gallery or screenshot role); a source record whose cover is missing or rejected leaves the subject without one, and the import report says why. A decode fault (a corrupt image or one over 40 megapixels) is reserved, uploaded, then rejected with `image-rejected`; a fault before storage is reserved, then rejected with a `source-*` code, where `source-integrity` means a byte count or digest mismatch.

### The cover summary

Every read that returns a subject for display (subject read, search hits, collection members, library entries, inverse relation pages, thread attachments) returns a cover summary with it, in the same response:

```json
{
  "media": "0192…",
  "width": 1200,
  "height": 1800,
  "placeholder": { "thumbhash": "…", "color": "#5a4632" },
  "variants": [
    { "format": "avif", "width": 320 },
    { "format": "webp", "width": 320 }
  ],
  "focalPoint": { "x": 0.5, "y": 0.5 },
  "credit": { "rightsHolder": "…", "via": { "name": "…", "url": "https://…" }, "license": "…" }
}
```

or `null` when the subject has no cover the reader may see. A missing, rejected, erased, taken-down or withheld cover is `null` (or carries a `withheld` reason for suitability), never an error, so a page never fails or waits because of an image. The summary is read with the subject in the same batched read; it never costs one request per item.

The summary's width and height describe the authored crop when one exists, or the original otherwise. Its ThumbHash is base64, its colour is the stored average colour, and variant entries are ordered by ascending width. `focalPoint` is null when no focal point was authored.

### Serving

Cover variants are served by the website's media route like every other media object: each request, conditional ones included, asks content for a decision, published bytes are sent `private, no-cache` with the SHA-256 as `ETag`, and a takedown or erasure takes effect on the next request. A page with k covers therefore costs k download decisions, so a page requests only the covers it shows: previews cap their items, and covers below the first viewport load lazily. Cover summaries are resolved from the media's current state at read time, so a takedown, erasure or rights change removes the cover from every summary at once and no page links to a removed image.

### Rights

Every imported cover carries its rights holder, the source it came through and its licence, and is credited where it is shown. A cover comes down on a valid complaint through the media takedown path, and its subject then shows its placeholder. The takedown also fences the source record's cover field, so a later import refresh cannot bring the same cover back.

## Document image presentations

`readDocumentMediaPresentations(deps, actor, ids, context)` in `media-presentation.ts` returns the closed
`DocumentMediaPage` (`{images}`) for one to 32 unique routed media IDs. `POST /v1/media/presentations` accepts
only `{ids: string[]}` and exposes this ordinary `media:read` operation to authenticated and anonymous readers.
It creates no resource or grants. Both successful and empty pages use `private, no-store`.

Each `DocumentImagePresentation` contains `id`, `containerId`, the current original `digest`, crop-aware `width`
and `height`, actual stored derivative `variants` with format/width/height, nullable stored `placeholder`, nullable
`focalPoint`, and native import `credit` or null. This read selects the largest actual WebP derivative, falling back
to an actual AVIF only when there is no usable WebP candidate. A single derivative is sufficient for this producer;
the list is not the potential processing ladder. It never returns originals, URLs, storage keys, uploader metadata,
document bodies or historical revisions. Consumers use the existing native media transport for the advertised slot.

After a derivative load failure, the document reader offers manual Retry only for an admitted image with actual variants; each action mounts one eager browser load at the same authorized derivative URLs, keeps the unavailable alt-text fallback and hides credit until success, and retires callbacks on attempt, ID/digest or disclosure replacement without automatic retries or metadata refills.

Enumeration is private storage fact gathering. The selected row then passes the same source/final verifier as
`downloadMedia` and `decideDownload`: ordinary media Access, available media state, permanent post claim, independent
declared container/ancestor/board gates, current Realm/Space lifecycle and protected Realm ban checks, or the native
cover subject and source fence or Realm asset gates as appropriate. No document or paid edition grants image access.
The expected metadata and selected derivative row must match at the native source and final media anchors, including
credit, dimensions, digest and security revision. A changed or denied selection is omitted without selecting a
replacement. Missing/denied images leave no metadata in the response; typed dependency/partition/deadline errors
remain errors. Every checkout is released before a foreign anchor or Access preparation, supporting a one-slot pool.

### Cost

Let N be supplied IDs (1..32), V the actual derivative count per image (0..12, enforced by the native format/width
constraints and unique `media_variant_slot_idx`), and H the native parent chain (at most 33 posts and one thread).
There is exactly one exact `(route, media_id)` enumeration per supplied ID, examining at most one media row and V
derivative rows, and at most one native derivative authorization per image. Thus the page performs at most 32
enumerations, examines at most 384 derivative rows there, and makes at most 32 native variant checks (within the
32*12 ceiling). Its cost is `N * (one indexed media seek + indexed V derivative rows + D(H))`, where `D(H)` is the
existing bounded native download verification, including its fixed source/final exact-slot and independent parent,
board, Realm/Space and Access anchors. There is no additional history, body or table scan, HTTP request per image,
unbounded dependency expansion, retry or refill. This read does not change image processing, 40 MP limits, imports,
collection or erasure. Focused native privacy, current-variant and schema cases live in
`test/content/media-presentation.test.ts`; existing native download/privacy suites remain applicable.

Media download eligibility callbacks carry optional Access work declarations. Captured initial rows perform pure
preparation; their original reads belong to the enclosing Source. Current board, thread and post callbacks declare
their exact primary-key probes, including the post head revision and conditional draft-author probe. Each invocation
records only its dispatched plans, keeps native row charges on empty seeks, and binds the receipt to its exact
context and result. Failure retains the complete admitted envelope. These receipts never replace the independent
current image, container, ancestor, board, Realm, Space or source-fence authority.

Metered avatar, post-image and Realm-image callbacks use separate `read-download-media-work.sql` and
`realm-media-read-work.sql` projections. Each download point selects only its exact variant; Realm assets select
at most twelve actual slots, bounded by the native unique slot index. Work-only optional ThumbHash and colour
fields follow the generator's <=32-byte and `#rrggbb` formats. Malformed historical optional fields become null;
a signature mismatch still fails closed. Whole credit/provenance must fit the existing import envelope's
8192/65536 UTF-8 byte limits or the point returns unavailable. A captured null uses a zero SQL limit, so changed
nonnull metadata fails closed before projection; it is never treated as absent. Required rights and binding facts
are never clipped.
These are field projection contracts, not Source allowances or assumptions that historical rows passed a constraint.
The cover-only `NOT VALID` display constraint supplies no historical proof.

Post-image verification also accounts for each actual native ancestor dispatch. Its declaration uses the captured
chain (at most 33 posts and a thread); changed keys or kinds fail before an undeclared additional seek. The original
native walker still proves routes, cycles, thread binding and availability. Closed wire projection and parameter
bytes settle synchronously from the dispatched invocation; rows retain the full native plan charge, including on
empty seeks. Initial captured rows and independent outer/final reads belong to their enclosing domain owner.

Cover verification composes the existing bounded media point, the exact `semantic/subject-exists.sql` primary-key
probe (`found: 1`, including an empty seek), and the original prepared actor and anonymous subject Access checks.
`cover-prepared-access-work.ts` consumes the declared `PreparedAccessCheckWork.bound/run/actual` ABI through a
Content-local optional boundary until the original request module exports it. Only identical prepared check handles
share an invocation; an actor grant never supplies the anonymous result used for public transport cacheability.
The original `subjectReadEligibility` remains the sole Semantic resource verifier.

The pure declaration includes both complete nested producer bounds before callback IO. Their exact invocation
receipts join the media and existence work in the existing parent envelope; Content neither reserves those children
again nor subtracts cumulative ledger usage. The Accounts accounting frame owns nested native/owner settlement.
Failed or unknown execution retains the complete admitted bound. The existence probe costs one key, point and native
row, with parameter bytes plus the closed constant projection; no subject label, payload or history is selected.

Metered cover verification requires the same genuine live `AuthoritativeTime` and `AccessWorkAccounting` that were
forwarded to original subject preparation on the released pool. Each original producer must admit that preparation;
missing producers, undefined bounds, missing time/accounting or unadmitted earlier preparation refuse before callback
IO. The trusted caller port is `MediaDependencies.downloadContext: DownloadContext` for `decideDownload`, or the
existing `DownloadContext` argument for `authorizeMediaDerivative`: optional `time: AuthoritativeTime` and
`work: AccessWorkAccounting` accompany the existing deadline and route key. They are forwarded to released
preparation and the final media check. Current media-route and Collection presentation callers supply only the
deadline/route key, so their metered cover variants remain unsupported.
Initial/final media and independent tuple-fence snapshots remain at their original released homes and belong to their
enclosing Source, outside these callback receipts. Unmetered queries, native checks and cache policy retain their
existing behavior. This consumer does not establish cover, native or whole-source readiness.

## Realm presentation media

Content adopts the native Realm asset slice of the [community presentation research](../../../../docs/research/content-community-presentation-contract.md).
This section owns assets; Realm settings/revisions and presentation enrichment belong to Community and its consumers.
Space assets, board overrides, rules and member counts are outside this producer.

`realm-icon` and `realm-banner` are native media purposes with the actual Realm as `containerId`.
`POST /v1/realms/{realmId}/media` accepts only `{ purpose, mediaType, byteCount, sha256? }`, with no undeclared fields.
It uses `parentCreationAuthorization` with current `realm:manage` on the active `community.realm` at authoritative T,
then the existing uploader/new-media initializer, reservation receipt and reserved event. The media and Realm share
an exact route/home. It adds no `media:create` grant on a Realm and no account-avatar reuse.
Reservation status includes the native purpose. The existing `/v1/media` request schema remains unchanged.

Completion uses the existing website uploader BFF, uploader/media:complete authorization, reservation identity,
20 MiB measured-byte limit and declared digest checks. For Realm purposes it also checks the active Realm and current
`realm:manage` at each command attempt's T, before receipt replay. No client scope is widened. Accounts owns scope
mapping; an unavailable or missing mapping denies admission. The existing image job publishes reencoded AVIF/WebP,
with its 40-million-pixel ceiling, width ladder, at most twelve variants and normal rejected outcome. Unclaimed
media follows the existing 24-hour collector.

`claimRealmPresentationMedia(tx, { realmId, author, avatarMediaId, bannerMediaId })` is called by the native Realm
settings command **after** appending its revision and moving the head with CAS, in the same transaction. It requires
the live command's execute authorization for exact `realm:manage`, home and account/client/requested-by binding;
the supplied Actor grants nothing. The exact current Realm head and revision must be written by that transaction,
with the same author and a predecessor. An arbitrary command or a copied query executor cannot claim.
Each non-null slot claims one available, unfenced same-route/same-Realm image uploaded by that actor, with matching
purpose. A mismatch throws `MediaUnavailableError`, for the settings consumer's uniform 409 `media_unavailable`.
The permanent `claimed_realm_id` and `claimed_at` cannot move or clear. Null slots clear selection only; immutable
prior revision claims survive. No separate claim HTTP route or generic claim constructor exists.

`readRealmPresentationImages` returns the exact optional image types exported by `realm-media.ts`. Unset, erased,
concealed, unclaimed or mismatched images produce `{state:'none',value:null}` without identifying reasons.
Optional dependency failures produce `unavailable` with no cached value. Available summaries contain only native
media/container IDs, largest derivative digest and actual dimensions and at most twelve derivative format/width/height
facts. Missing stored placeholder/focal-point metadata is null; uploaded native assets have null credit. No storage
key, original, account identity or source URL is disclosed.

The helper checks the current Realm, its independently anchored active Space host, native Access and exact media
availability/security fences at fixed source/final anchors. It preserves the Realm's Context binding and has no
removed-container Global fallback. The existing media-id/variant download transport repeats that native chain for
every request, including conditional requests. It permits only available derivatives of permanently claimed Realm
assets and uses `private, no-store`; originals are never served. A summary is never download permission.

Collection already excludes `claimed_at` media. Account upload erasure recognizes actual permanent Realm claims
through the existing retained-upload disposition, retaining the locator for its ordinary proof pass and the objects
with their Realm revision owner. Explicitly erased media still requires prefix deletion before locator removal.
There is no new cleanup coordinator, acknowledgement or custody proof; later native/physical evidence remains due.

### Cost: Realm asset reservation

- Touches: current Realm parent/head/Access, one media insert, uploader initializer, receipt and existing reserved event.
- Bound: constant rows/statements, O(log R) indexed work; no account-image or revision-history search.
- Growth check: later reuse `test/content/growth-media.test.ts` with the Realm parent.

### Cost: Realm asset completion

- Touches: exact reservation/uploader, current media:complete and Realm management, one update/receipt/event.
- Bound: constant rows/statements, O(log R), existing 20 MiB byte bound; authorization repeats before replay.
- Growth check: later reuse `test/content/growth-media.test.ts` with current Realm management.

### Cost: Realm presentation claim

- Touches: authorized Realm settings head/revision, at most two exact media rows and permanent claim updates.
- Bound: O(changes log R), at most two changes in stable lock order; no history walk or reference scan.
- Growth check: later reuse `test/community/growth-realm.test.ts` with two matching assets.

### Cost: Realm image summary and download

- Touches: fixed source/final Realm/media anchors, independent host anchors and Access; at most two media and twelve derivatives each (one selected slot for bytes).
- Bound: constant rows/statements, O(log R) per exact probe, fixed anchors and no retry/discovery loop.
- Growth check: later reuse `test/content/growth-media-realm-download.test.ts` with native assets and conditional requests.

### Cost: Realm asset publication

- Touches: existing image job, one source object/media row, at most twelve derivative objects/rows.
- Bound: constant indexed statements, O(log R); existing 20 MiB and 40-million-pixel decode bounds.
- Growth check: `test/content/growth-realm-asset-publication.test.ts` captures Realm HTTP reservation and registered image-workflow completion.

### Cost: Realm asset collection and account erasure

- Touches: existing fixed collection/upload pages; each media disposition reads the exact permanent claim marker.
- Bound: O(p log R) for existing page size p; no extra owner fanout, coordinator or historical revision walk.
- Growth check: `test/content/growth-realm-asset-collection.test.ts` measures native Realm icon/banner collection and retained permanent-claim exclusion; account erasure remains `test/content/account-erasure-uploads.test.ts`.
- Fixture decision: selected Realm assets and the permanent claim use native HTTP; unrelated media and retained history are seeded outside observation, while collector pages, refusal, retry and storage effects stay inside capture.

## Avatars

An avatar is an image media object with purpose `avatar`. Its container and uploader are the same account,
so it lives in that account's partition. Only the admitted account using the website client may reserve and
complete it, with the same image types and upload limits as post images. The image job produces the same
variants, ThumbHash and average colour. Available avatar variants are public; originals and pending, rejected,
taken-down, erased or collection-pending avatars are never served. Owners erase avatars with the existing
`DELETE /v1/media/{id}`.

Reserve an avatar with `POST /v1/media`, setting `purpose: "avatar"` and `containerId` to the authenticated
account id. Another account's container returns 404, even with a creation grant; `newThread` remains exclusive
to post images. The reservation response and `GET /v1/media/{id}` include `purpose: "avatar"` alongside the
existing reservation metadata. Complete the upload with `POST /v1/media/{id}:complete`, supplying the account
container, reservation request id, byte count and SHA-256; its response is `{ media: { id, state: "uploaded" } }`.
Post-image request and response shapes are unchanged.

Avatar reservation uses the existing media reservation work with the account in place of the thread or post
container. It adds no statement, keeps the same bound and uses the existing media reservation growth check.

Access stores the selected media id on the account and calls `checkAvatarMedia(client, mediaId, accountId)`
inside its set-avatar command. The port checks availability, purpose and container with one primary-key read
in the account's partition. `readAvatarSummaries(client, ids)` accepts 1–256 input ids, deduplicates them and
returns a map with one statement per media partition. Each available avatar has the cover summary shape with
`credit: null`; unknown, unavailable and non-avatar ids map to null. An account upload has no source credit.

## Private uploader inventory

Authenticated `GET /v1/media?cursor=...` returns the current account's own bounded history. The person identity
comes only from the verified account actor. There is no account selector, organization impersonation or library
count. A successful page with no entries and `nextCursor: null` means that the current actor home has no remaining
raw locators; sparse withheld entries can produce an empty page with a next cursor. If the account home or a selected
object home is unavailable, the endpoint returns 503 rather than an empty terminal page. Responses are `private, no-store`.

The page advances over at most 20 raw `content.account_upload` media keys in UUID order, then batches the selected
objects by native partition. A signed cursor binds the actor, authentication epoch, client, requested-by binding,
filter and raw UUID frontier. Sparse missing, erased-by-retention or currently withheld objects do not consume a
replacement slot; the next cursor advances over the raw page, and an operational home failure returns the same
input cursor frontier on retry. The actor-home table is the existing account-erasure locator and its registered
`content_account_upload_index` event effect remains the repair path. Browser reservation also upserts that same
locator in a separate actor-home command after the media reservation commits, so a lost HTTP response can be
replayed with the same reservation intent without making a second object.

Each visible entry contains the routed media ID, purpose, current native state, declared type/size, measured size
where present, creation and claim times, current admissible container ID/kind, collection/takedown flags and action
descriptors. Actual media type is null because the native media row stores the declared type and measured size, not
a separately sniffed type. A read action names `media.authorize_download` and only lists stored `original` or actual
variant slots; `recheckAtUse` is true because the existing transport repeats current media, container, source and
Access checks before returning any storage key. Remove names the existing `media.erase` command only when its
current owner authority is allowed. Resume appears only for reserved or uploaded post images, retains the original
reservation and requires the original file for the current Web transport. A rejected image stays rejected and only
offers `media.create` as its retry action with `choose-new-file` guidance. No rejection reason, reservation request
identity, storage key, signed credential, guessed URL or private imported provenance is included.

Avatar reads list only actual derivatives. Realm asset actions use the current Realm/Space/media authority and the
actual stored derivative ladder in batches of at most two. Imported covers stay role-only in uploader history; the
inventory never exposes their source provenance or browser resume action. This page does not authorize a public
download and does not replace the document-media presentation or image transport owners.

### Cost: uploader locator maintenance

- Touches: one actor-home command, the exact account erasure fence read/lock and one idempotent insert into the existing `(route, account_id, phase, id)` primary key.
- Bound: one locator row and a fixed number of statements per reservation; indexed work is O(log U), with U the selected account's locator rows, and no source-home write or history scan.
- Growth check: `test/content/own-media-http.test.ts` proves initial population and exact reservation replay; controller growth acceptance must add unrelated actors and the selected actor's retained lifecycle rows at 256, 1024 and 4096.

### Cost: uploader inventory page

- Touches: one account-home raw page; at most 20 exact media keys grouped into at most 20 object partitions; exact post, head-revision and thread context probes; at most twelve stored derivative rows per selected object; three media Access decisions and up to two container Access decisions per participating object home. Realm entries add at most 20 current Realm groups and 20 existing Realm-media batches, each selecting at most two images.
- Bound: 20 raw locators and returned entries; at most 20 media rows, 60 post/revision/thread context rows, 240 variant rows, and a maximum 13 safe variant names per returned post image. Statements and bytes are page-bounded; indexed blocks grow logarithmically in account locators, selected home rows and nested Access authority. No exact total, unrelated account enumeration, SQL join across homes, per-row HTTP fetch or refill.
- Growth check: `test/content/own-media-http.test.ts` covers reserved, uploaded, available, rejected, claimed post, selected read, replay, erase and uploader privacy. Controller native growth acceptance must hold the selected actor/page fixed while unrelated objects, uploaders, retired objects and lifecycle history grow at 256, 1024 and 4096, capture every participating pool and runner, and prove strict uploader/object prefixes and empty, denied and stale branches.

## Source fences

`content.source_fences` retains one stable `(route, source, external_id, field_group)` tuple independently of
subject identity. `takedownSourceFence` authorizes platform governance at the command's authoritative time before
writing only the tuple's partition. The first takedown stores that command time in `taken_down_at` and a new
route-local UUID in `takedown_id`. Takedown never reverts; repeats increase `security_revision` and preserve both
original values. While a takedown remains active, the database guard rejects partial pairs and any change to its
provenance. A reset can end the period only while clearing both provenance fields; no command does this in this scope.
Importing from a taken-down source answers HTTP 409 `conflict` to a caller holding both `source_fence:read` on the
Global Context and the creation permission; permission denial comes first.

Every `com.rezics.content.source_fence.taken_down.v1` event reads the original pair back from the row as optional
`takenDownAt` and `takedownId`. The time uses the kernel's authoritative PostgreSQL timestamp text, preserving
database precision. Rows already taken down before these fields existed keep both null and their events omit both;
neither migration nor replay derives them from a revision or delivery time. Existing v1 events remain valid.

The internal `readFences` read returns that same optional pair as `takenDownAt` and `takedownId` in its existing
partition-local statement. Legacy takedowns, standing fences and missing tuples omit both fields.

`(takedownId, takenDownAt)` identifies one takedown period; repeats within the period keep the same pair. The first
scope has no fence restore, so a period never ends and its pair never changes. Fences hide imported data and keep
it, as [Deletion](../../../../docs/deletion.md) requires. A future restore will end the period with its own event
carrying that period's `takedownId` and clear the current pair. A later takedown starts a new period with a fresh id
and time. Consumers key on `takedownId` and never assume one period per tuple.

## Authored field documents

An authored field document stores the editor's canonical document body, SPDX licence and BCP 47 language in
`content.authored_field`, beside the subject's route. Its row binds the body to the semantic subject, candidate and
revision, and records the acting account as `author_account_id`. `appendAuthoredField` requires a current execute command:
without an anchor, its authorization resource must be the subject; with an anchor, the anchor must carry the subject's
route and be declared by the command's live parent creation, without comparing the authorization resource to the subject.
The row stores the declared anchor, or null for an anchorless append. It returns the document `{ id, digest }` for semantic
to store as the statement value.
The semantic command emits `com.rezics.content.authored-field.created.v1` with the document, subject, candidate and author IDs
in the same transaction. Append also initializes the `content.authored_field.owner` Access role for the author at that
command's authorization time; it carries `document:erase`.
Documents are text-only until subject-field media claims exist; image and media nodes are refused.

### Original source history enrollment

`readAuthoredFieldHistorySource(tx, documentId)` in `authored-fields-history.ts` is an internal data port returning
the actual immutable native `{ kind: 'contribution', subjectId, candidateId, revision, documentId }`. It reads only
the exact authored row's id, subject, candidate and original revision, validates the current command home, routed
tuple and positive safe revision, and includes retained erased metadata. It reads no body, author or private profile.
It grants no permission. Missing metadata returns `null`, which is never historical completeness or no-copies evidence;
row retention follows Content's existing owner policy, with no historical UUID or body search.

Semantic owns the outer native command containing `appendAuthoredField`. It collects all actual new, old and current
contribution references from its native source snapshots and the returned append `id`, then calls
`declareCommandRecordSources(tx, sources)` exactly once before any native history serialization. The helper is optional
when Semantic already has the actual tuple. Append retains exactly `{ id, digest }`, its direct SQL and owner grants;
neither append nor nested purge hooks declare sources. A command copying more than 16 distinct sources needs resolution
by Semantic and Accounts; callers must never truncate references or raise the shared limit silently.

Content's standalone `eraseAuthoredField` owns its own declaration. After current `document:erase` admission and an
exact native author check, it obtains that document's original metadata and declares the single source before mutation
or serialization. Permanent command-kind ID 2000 binds `content.authored_field.erase` to the native shared-history sink.
Its author association is separate from the automatic verified actor/principal/human/delegate associations supplied by
Access. The actual serializers enroll the generated receipt and outbox locators; the public result and event gain no proof
property. Replay uses the existing authorized receipt path; an unchanged tombstone rolls back the entire attempt.

Source declarations associate ownership only: they confer no source validity, disclosure or maintenance authority,
historical completeness or erasure acknowledgement. Old or foreign custody, active work and other resource coverage
remain partial and unknown. Other Content post, thread, media and lifecycle records are not contribution/Context/Zone
sources; a referenced Context or invented semantic candidate cannot enroll them.

Cost per operation:

- **Touches:** The helper reads one exact metadata point in the current home. Standalone erase also probes the exact
  author key, declares one source and one author's receipt/event scope, then performs the existing exact erase and
  native receipt/outbox writes with their generated locator associations.
- **Bound:** Fixed keys and statements; at most one metadata row and one source, with indexed O(log R) work as unrelated
  rows grow. No source/history scan, body read, cross-home query or dependency fanout.
- **Growth check:** Existing `test/content/authored-fields.test.ts` covers the authored primary-key population;
  `test/content/authored-fields-history.test.ts` adds focused original-tuple and outer-declaration controls. No new
  growth campaign or complete custody claim is made.

### Reads and author erasure

Authenticated `GET /v1/threads/{id}` adds the private optional envelope field
`authorErasure: { authorId: string, mayErase: boolean }`. Anonymous reads omit it. The acting account supplies
`authorId`; no request selector, displayed post, ownership flag or Global staff role supplies this admission.
`author-erasure-admission.ts` reuses `read-first-erasure-post.sql`'s two same-thread/same-author indexed prefix
seeks, then current native Access `post:erase` on the actual first selected post. It binds native read time,
clock, deadline and account lifetime, releasing each connection before consulting an independent anchor.
No selected post or an actual permission denial yields false. Unavailable/deadline failures propagate as 503.

The ordinary thread and its complete containing chain must be readable before selection. `reads.ts` retains the
original observations and Access checks across admission and repeats final thread/container disclosure afterwards;
a removed, hidden or changed container cannot disclose either body or admission. Missing and invisible remain
identical 404. The response exposes no selected post ID, authored bytes, upper tuple or count through admission.
This presentation value grants no command capability: the existing author-scope POST and every workflow step
continue to check their own current authority.

- **Touches:** Ordinary thread/container disclosure, at most two indexed author-prefix seeks and Access on one
  selected post, followed by the same final disclosure; fixed response fields, zero writes/receipts/effects/workflows.
- **Bound:** O(log R) index work at fixed chain/membership bounds, constant rows and statements independent of
  author history. Original physical erasure bounds remain unchanged.
- **Growth check:** `test/content/author-erasure-admission-http.test.ts` uses the existing native harness at three
  small history scales, holding actor, chain and selected endpoints fixed while growing same-thread and unrelated
  author history; it checks actual rows and statements without timing assertions. Source and typing do not prove
  native admission or erasure closure.

`readAuthoredField` is a low-level exact storage read that includes erased tombstones and must never serve as a public
handler. Disclosure follows the current semantic candidate, as it does for imported documents; a document ID by itself
does not authorize disclosure.

`eraseAuthoredField` requires account admission and `document:erase` on the document at the command's authorization time.
It runs in the document's partition, clears the body and marks the row erased, while retaining its identity and digest.
Only the author receives this owner permission. A repeat succeeds without another erased event. Moderation is separate:
moderators end a harmful field's disclosure with native candidate hide or takedown, so its body is no longer served.

`GET /v1/documents/{id}` serves an authored field document only while its stored semantic candidate is disclosed and
the subject passes the current `subject:read` check. Its response identifies `origin: account`, the author account and
the document licence. Erased authored documents, like missing or undisclosed documents, answer not found. The matching
`DELETE /v1/documents/{id}` requires an `Idempotency-Key` and the author's `document:erase` permission; a successful
deletion and authorized replay return 204 with the stored session position.

### Ordinary record physical purge

`purgeAuthoredFieldForDeletedRecord(tx, authority)` is the adopted internal Content port for ordinary deleted
semantic records. It consumes the same opaque `RecordPurgeAuthority` as shared-history minimization, from
`semantic/record-purge-authority.ts`. Content itself calls `lockRecordPurgeAuthoritySource` inside the current
source command. A structural payload, serialized authority, author identity, account deletion time or
`document:erase` permission cannot authorize this maintenance operation.

Semantic owns issuance and the native lifecycle lock: the real committed deletion, original tuple, generation,
source version and deletion transaction, its thirty-day deadline, and current hold, takedown and restoration
state at the current command T. Its source lock and progress must serialize hold, restore and generation
changes, including refusal of ordinary restoration after expiry or irreversible purge. Takedown alone is not
ordinary deletion. Content never reads Semantic lifecycle SQL or infers eligibility from an earlier issuance.
Until Semantic supplies the native issuer, reader and lock, those original-module functions throw unavailable;
the declarations alone confer no permission and this hook cannot purge through that seam.

After that native lock, Content locks exactly one routed `authored_field` and compares its stored subject,
candidate and revision. It clears physical `body` bytes and sets `availability = erased`, preserving the original
digest, licence, language and reference skeleton. `authored_field_purge` records the exact source binding and
deletion generation in that same transaction, alongside the source owner's progress. A pre-existing author or
account tombstone also needs that live source validation and binding; its absence of bytes alone is no completion
evidence. Existing author erasure and account erasure semantics are unchanged.

`null` means ineligible source or no exact binding and authorizes no custody acknowledgement. `already-purged`
requires the exact native tombstone, physical NULL bytes and the verified source generation; a mismatched stored
generation or source binding returns no completion. `purged` requires the physical transition and binding in this
transaction. Rollback loses both Content changes; source exceptions, dependency failures and unknown outcomes
propagate. This is Content body custody only: shared-history copies, receiving custody and consumer closure belong
to their owners. Neither return state claims global cleanup. The writer rejects image and media nodes, so this port
has no attached-media acknowledgement; future media support needs an actual Content custody source.

Cost per operation:

- **Touches:** Semantic's exact native source lock; one exact authored row lock and one exact optional custody
  binding read; at most one body transition and one binding insert in that source home.
- **Bound:** Fixed keys, rows and statements; O(log R) indexed work as unrelated records grow. No source-history
  walk, JSON scan, foreign-home SQL or cross-home transaction.
- **Growth check:** The existing `test/content/authored-fields.test.ts` “authored document append and read”
  covers the authored primary-key population. The purge adds one primary-key binding lookup and insert.
  `test/content/authored-field-retention.test.ts` supplies focused custody controls, not a new growth campaign
  or proof that the still-unavailable native source lifecycle has landed.

## Media claims

Post-image download and document media presentation inherit the permanent
`claimed_item_id` post's current disclosure chain, including its reservation
container, board and Realm. A claim must still belong to that container's chain;
its current post admission cannot be replaced by the reservation thread's public
visibility. Reservations without an item binding keep their container prerequisite.
The exact item binding is included in source/final media signatures and the bounded
Access work projection. No membership, grant or claim producer is duplicated.

Document media pages recheck their selected exact media and current parent/Realm
admission after selection, omitting withdrawn members without refill. Each page
still accepts at most 32 IDs and each chain at most 33 posts plus its thread;
the second round adds O(ids × H) indexed point work and scans no unrelated media.
The page and download routes retain their existing cache policy and read authority;
Realm participation is not substituted for Realm reading.

A post image belongs to the first post that claims it; that post's later revisions may name it again, any other reference is `media_unavailable`, and erasing the post erases it.

A malformed media ID list is a 400 `invalid_request`. Any well-formed reference that cannot be claimed returns the same 409 `media_unavailable` response, whether its ID is unknown, belongs to another route, container or uploader, or its media is reserved, uploaded, rejected, erased or claimed by another post. This response does not identify which case applied; uploaders can read their own media state through the media routes. A 422 `idempotency_conflict` is reserved for reusing an idempotency key with a different request.

## Account erasure

The content participant closes an account-local locator fence before its first page. Each effect that writes
`author_item`, `report_reporter`, `party_locator` or `account_upload` locks that fence in the same transaction. A
locator committed before closure is visible to later pages; an effect arriving after closure writes no locator,
records an Access late item, applies the same disposition and resolves the late item only after that disposition
commits. The participant processes at most 50 keys per page and never holds a connection across partitions.
Locator effects add one locked point read, or one insert for the account's first locator; closing the fence is one
account-partition statement.

The retention inventory is:

| Store                                                   | Erasure disposition                                                                                                                                                         | Retained data and purpose                                                                                                             | Trigger                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `content.post` and `content.revision`                   | Erase every available post not both available and published; clear its title when it opens a thread. Erase every non-head revision body and search text for retained posts. | A published, available post, its current revision and author id remain public; Accounts renders the author as `{ id, state, kind }`.  | Authored-items page under the closed fence.                    |
| `content.thread`                                        | Clear the title and review-live state when its opening post is erased.                                                                                                      | A thread whose opening post remains published and available is retained with that post.                                               | Authored-items page under the closed fence.                    |
| `content.media` and stored objects                      | Erase uploader media not attached to retained public content and delete every stored object before removing its upload locator.                                             | Media on an available, published post stays with that post; a permanent native Realm claim stays with its Realm revisions.            | Uploads page; object deletion is the delivery proof.           |
| Authored fields                                         | Clear body and mark erased unless the anonymous reader is served the field.                                                                                                 | Fields served to anonymous readers remain as public contributions.                                                                    | Uploads page.                                                  |
| `content.report`                                        | Clear reporter identity and evidence text; keep the report and its decision.                                                                                                | No account attribution or evidence text is retained.                                                                                  | Reporter-locator page.                                         |
| `content.moderation_decision`                           | Clear the decider. Clear statements outside the exception window.                                                                                                           | Statements of reasons from the previous 183 days remain for the affected person's complaint and are purged at each decision's expiry. | Moderation-locator page and expiry purge.                      |
| `content.account_erasure_statement`                     | Delete the expiry key after the statement purge.                                                                                                                            | Only the decision id, owner route and exact expiry are held to schedule that purge; the row is deleted at expiry.                     | Retained statement disposition, including late fenced effects. |
| `content.operation`                                     | Clear every party field naming the account after its workflow is terminal.                                                                                                  | No account party attribution remains.                                                                                                 | Party-locator page.                                            |
| `content.reaction` and `content.reaction_liked_version` | Delete the account's reaction rows first; delete its exact source-version row only after the indexed reaction existence probe is empty.                                     | No reaction or source version remains after terminal erasure.                                                                         | Reactions page under the closed fence.                         |

One content acknowledgement covers authored items, uploads, reactions, reports and moderation records. `none` means
every bounded phase found no data; otherwise it is `erased`. A recent moderation statement adds the single
`content.moderation_decision.statement` exception with the complaint purpose and exact expiry. Retained statements
move from the party locator to `content.account_erasure_statement`, an account-partition expiry key that also handles
late effects without recreating an erasure locator. The participant proves its author, report, party, reaction and
source-version seeks empty, verifies remaining upload entries are retained public media, permanent Realm assets or fields, then acknowledges.
One phase step adds constant progress reads and writes beyond the phase's own work; retaining a statement adds one
account-partition expiry-key write.

### Delivery

The `delivery` participant covers media storage and the media service. Media responses are `private, no-cache` and
make a content decision on every request, so no shared cache holds a platform copy; browser caches are outside the
platform's custody. `content.account_upload` is the storage-deletion proof: an erased media locator remains until
`purgeObject` returns, including for already-erased media and late uploads. Delivery acknowledges `none` when no
media locator was found and `erased` after every erased media object's stored prefix is deleted. Retained public
media and permanently claimed Realm assets keep their objects. The uploads page touches at most 50 locators; each already-erased media key adds one
idempotent prefix delete, plus one acknowledgement command per account.

## Cost

| Operation                                 | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Bound                                                                                                                                                                                                                                                                                                                                                                                              | Growth check                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Viewer actions                            | One batch read per Content type, at most 100 IDs; source/ancestor rows share the thread partition, containers use separate full keys. At most one source, container and edition-evidence statement per selected type, no bytes or history enumeration.                                                                                                                                                                                                                  | Constant statements: owner preparation ≤6; at most 33 post formula pages + four container/thread pages + 100 subject-type pages, each ≤2 statements: ≤283 additional statements per type. Chain ≤33 posts per reference (3,300 total), ≤100 boards/Realms/Spaces/creators/subjects and two ban identities. Existing shared endpoint bounds and 64-action/256-binding caps remain unchanged.        | `test/content/viewer-actions.test.ts`                                                                                                                                                                                                                                                                                          |
| Account authored-items erasure            | At most 50 `author_item` keys; one item-partition disposition per key and at most 100 older revisions per step.                                                                                                                                                                                                                                                                                                                                                         | Linear rows/statements in fixed page and revision bounds; O(k log P) blocks.                                                                                                                                                                                                                                                                                                                       | `test/content/account-erasure-authored.test.ts`: “an account erasure page stays within its bound as other authors' items grow”                                                                                                                                                                                                 |
| Account upload erasure                    | At most 50 `account_upload` keys; media, stored-prefix and authored-field dispositions.                                                                                                                                                                                                                                                                                                                                                                                 | Linear rows/statements in the page; O(k log M) blocks.                                                                                                                                                                                                                                                                                                                                             | `test/content/account-erasure-uploads.test.ts`: “upload erasure stays bounded as other accounts' uploads grow”                                                                                                                                                                                                                 |
| Account reaction and report erasure       | At most 50 actor-leading reaction or reporter-locator keys; reaction source-version deletion follows an empty reaction probe.                                                                                                                                                                                                                                                                                                                                           | Linear rows/statements in the page plus constant exact-key cleanup; O(k log N) blocks.                                                                                                                                                                                                                                                                                                             | `test/content/account-erasure.test.ts`: terminal reaction source-version cleanup                                                                                                                                                                                                                                               |
| Account moderation erasure                | At most 50 party-locator keys and one owner-partition disposition per key; retained statements add one account-partition expiry-key write.                                                                                                                                                                                                                                                                                                                              | Linear rows/statements in the page; O(k log N) blocks.                                                                                                                                                                                                                                                                                                                                             | `test/content/account-erasure.test.ts`: moderator statement retention and expiry                                                                                                                                                                                                                                               |
| Content erasure participant               | One progress row read/write per step, fence closure, final existence probes and one participant acknowledgement.                                                                                                                                                                                                                                                                                                                                                        | Constant work beyond each phase's own bound; total work linear in the account's content.                                                                                                                                                                                                                                                                                                           | `test/content/account-erasure.test.ts`: content participant outcomes and tombstone replay                                                                                                                                                                                                                                      |
| Delivery erasure acknowledgement          | Upload page's at most 50 media keys; one idempotent object-prefix deletion for each erased media and one acknowledgement.                                                                                                                                                                                                                                                                                                                                               | Linear rows and statements in the page; O(k log M) blocks.                                                                                                                                                                                                                                                                                                                                         | `test/content/delivery-erasure.test.ts`: delivery waits for stored-object deletion                                                                                                                                                                                                                                             |
| Authored document append/read             | Validate/hash <= 2 MiB; append one field and event; exact-key read.                                                                                                                                                                                                                                                                                                                                                                                                     | Constant rows/statements; logarithmic blocks in documents.                                                                                                                                                                                                                                                                                                                                         | `test/content/authored-fields.test.ts`: “authored document append and read”                                                                                                                                                                                                                                                    |
| Authored document erasure                 | Account admission, `document:erase` Access, one exact tombstone and first-transition event.                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks plus Access and command.                                                                                                                                                                                                                                                                                                                              | `test/content/authored-field-erasure.test.ts`: “authored document erasure”                                                                                                                                                                                                                                                     |
| Authored document HTTP read               | Initial/final imported/authored probes, prepared Access recheck and candidate disclosure.                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements independent of documents.                                                                                                                                                                                                                                                                                                                                                 | `test/content/authored-document-http.test.ts`: “authored document read”                                                                                                                                                                                                                                                        |
| Document read                             | Bounded candidate tuples and selected body; Accounts formula and exact tuple probes.                                                                                                                                                                                                                                                                                                                                                                                    | Constant candidate rows/statements; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                                                                         | `test/content/document-http.test.ts`: “checkGrowth includes actual Accounts formula and constant exact document candidate and tuple probes”                                                                                                                                                                                    |
| Avatar summaries                          | One statement per media partition; media row and variants per ID, n <= 256.                                                                                                                                                                                                                                                                                                                                                                                             | Linear rows in n; fixed statements per partition, independent of media history.                                                                                                                                                                                                                                                                                                                    | `test/content/avatar-media.test.ts`: “avatar summaries”                                                                                                                                                                                                                                                                        |
| Avatar check                              | One media primary-key read in account partition.                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/avatar-media.test.ts`: “avatar check”                                                                                                                                                                                                                                                                            |
| Author item index                         | Guarded upsert/delete per event; erasure reads post and thread anchor; command event.                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks in index history.                                                                                                                                                                                                                                                                                                                                     | `test/content/author-item-index.test.ts`: “author item index”                                                                                                                                                                                                                                                                  |
| Author thread page                        | Public-view point read, <= 4L author-index candidates and thread/board disclosure probes.                                                                                                                                                                                                                                                                                                                                                                               | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                                                                                                                                                                                                                                                                                                  | `test/content/author-item-reads.test.ts`: “author thread page”                                                                                                                                                                                                                                                                 |
| Author post page                          | Public-view point read, <= 4L author-index candidates and post/thread disclosure probes.                                                                                                                                                                                                                                                                                                                                                                                | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                                                                                                                                                                                                                                                                                                  | `test/content/author-item-reads.test.ts`: “author post page”                                                                                                                                                                                                                                                                   |
| Board projection                          | Bounded source ancestry/page; fixed candidate/change set in destination command.                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks at fixed page/change set.                                                                                                                                                                                                                                                                                                                             | `test/content/board-read-growth.test.ts`: “Board projection stays within its bound as T grows”                                                                                                                                                                                                                                 |
| Board candidate page                      | Keyset-read at most d created-at candidates; active rank uses separate rank index.                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements and logarithmic blocks for fixed d; ascending growth is not captured.                                                                                                                                                                                                                                                                                                     | `test/content/board-read-growth.test.ts`: “Board candidate page stays within its bound as d grows”                                                                                                                                                                                                                             |
| Board pages (newest, active, hot)         | Board point read, <= 200 candidates and bounded thread/board/Realm disclosure; result <= 100.                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements for fixed page/chain; logarithmic indexed blocks.                                                                                                                                                                                                                                                                                                                         | `test/content/boards-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”, `test/content/board-hot-http.test.ts`: “the hot page stays within its bound as boards and threads grow”, `test/content/board-ranking.test.ts`: “active board pages keep constant cost as boards and threads grow” |
| Board rank refresh                        | Lock <= 500 candidates; per-partition totals/Realm weights, then batch update.                                                                                                                                                                                                                                                                                                                                                                                          | Linear B rows with logarithmic blocks in R, <= 2B + 2 statements (B <= 500); independent of reactions/thread.                                                                                                                                                                                                                                                                                      | `test/content/board-hot-refresh.test.ts`: “one refresh batch stays within its bound as candidates and reactions grow”                                                                                                                                                                                                          |
| Collection selection                      | Select eligible media through bounded indexed page, limit 100.                                                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements for fixed page; logarithmic blocks in media history.                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media.test.ts`: “Collection selection stays within its bound as P grows”                                                                                                                                                                                                                                  |
| Collection per object                     | Read and update one selected object and bounded state.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Collection per object stays within its bound as u grows”                                                                                                                                                                                                                                 |
| Cover reference read/claim                | Exact media probes and bounded cover-reference writes.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Cover reference read and claim stays within its bound as u grows”                                                                                                                                                                                                                        |
| Thread creation with first post           | Validate bounded board/Realm ancestry; insert thread/post/revision/indexes, Access and command.                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                                                                                   | `test/content/growth-threads.test.ts`: “Thread creation with first post stays within its bound as T grows”                                                                                                                                                                                                                     |
| Review creation                           | Board validation; thread/post/revision writes, live-review probe, Access and command; one point read only on conflict.                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in author's reviews; success independent of board review count.                                                                                                                                                                                                                                                                                       | `test/content/growth-threads.test.ts`: “Review creation stays within its bound as the reviews board grows”; `test/content/review-conflict-http.test.ts` pins success and conflict statements.                                                                                                                                  |
| Reply                                     | Validate <= 32 parent posts and bounded ancestry; insert post/revision/indexes.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks, independent of post count.                                                                                                                                                                                                                                                                                                                           | `test/content/growth-threads.test.ts`: “Reply stays within its bound as p grows”                                                                                                                                                                                                                                               |
| Post edit                                 | Read target/head and bounded chain; insert revision and update head.                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements; logarithmic blocks, independent of revision history.                                                                                                                                                                                                                                                                                                                     | `test/content/growth-threads.test.ts`: “Post edit (new revision) stays within its bound as r grows”                                                                                                                                                                                                                            |
| Thread read                               | Exact thread/board and bounded disclosure; +1 board-home snapshot, Access and current Realm ban key; no history walk.                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-threads.test.ts`: “Thread read stays within its bound as T grows”                                                                                                                                                                                                                                         |
| Post read                                 | Exact post/head and bounded disclosure; +1 board-home snapshot, Access and current Realm ban key; bounded body.                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-threads.test.ts`: “Post read stays within its bound as T grows”                                                                                                                                                                                                                                           |
| Revision read                             | Exact revision key and bounded chain; +1 board-home snapshot, Access and current Realm ban key; no history walk.                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks, independent of revision history.                                                                                                                                                                                                                                                                                                                     | `test/content/growth-threads.test.ts`: “Revision read stays within its bound as T grows”                                                                                                                                                                                                                                       |
| Post keyset page                          | <= s + 1 identities (s <= 200), bounded disclosure; public page <= 100.                                                                                                                                                                                                                                                                                                                                                                                                 | Linear rows in fixed s; constant statements, logarithmic blocks; no older-history walk.                                                                                                                                                                                                                                                                                                            | `test/content/growth-threads.test.ts`: “Post keyset page stays within its bound as p grows”                                                                                                                                                                                                                                    |
| Revision keyset page                      | <= s + 1 identities (s <= 200); full enumeration costs O(r) across pages.                                                                                                                                                                                                                                                                                                                                                                                               | Linear rows in fixed s; constant statements, logarithmic blocks.                                                                                                                                                                                                                                                                                                                                   | `test/content/growth-threads.test.ts`: “Revision keyset page stays within its bound as r grows”                                                                                                                                                                                                                                |
| Public board read                         | Exact board key and current disclosure state.                                                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements; logarithmic blocks in thread history.                                                                                                                                                                                                                                                                                                                                    | `test/content/growth-threads.test.ts`: “Public board read stays within its bound as T grows”                                                                                                                                                                                                                                   |
| Subject thread page                       | Bounded subject-thread index page and candidate disclosure.                                                                                                                                                                                                                                                                                                                                                                                                             | Linear rows in fixed page size; constant statements and logarithmic blocks.                                                                                                                                                                                                                                                                                                                        | `test/content/growth-subject-threads.test.ts`: “subject thread page stays within its bound as the subject thread index grows”                                                                                                                                                                                                  |
| Subject thread index projection           | Write one subject-thread index entry per thread event.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks as other threads grow.                                                                                                                                                                                                                                                                                                                                | `test/content/subject-thread-index.test.ts`: “indexing one thread has constant rows and statements and logarithmic blocks as other threads grow”                                                                                                                                                                               |
| Author erasure request                    | Admission snapshot, provenance and operation row; command and workflow binding.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/erasure-initiation-provenance.test.ts`: “initiation keeps its wire, admission and one-attempt cost; the growth check holds at three scales”                                                                                                                                                                      |
| Author erasure binding/status             | Point-read/write workflow identity and operation status.                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-lifecycle.test.ts`: “Author erasure binding and status stays within its bound as P grows”                                                                                                                                                                                                                 |
| Native author erasure                     | Fixed posts/revisions/media page and operation/initiator reads; count only page revision identities.                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements per page; linear rows in affected k revisions; logarithmic blocks.                                                                                                                                                                                                                                                                                                        | `test/content/erasure-workflow.test.ts`: “native content erasure pages”; “affected erasure revisions”; “native logical author page”                                                                                                                                                                                            |
| Author post deletion/restore/cleanup      | One tombstone command; clear revisions in bounded pages, only affected keys. Delete and restore each raise one security revision and emit one event; restore reclaims one review slot without enumerating revisions. Cleanup starts after the restore window or an immediate moderation/account purge.                                                                                                                                                                  | Constant rows/statements per command/page; linear in affected revisions across pages.                                                                                                                                                                                                                                                                                                              | `test/content/author-post-delete.test.ts`: “delete is one bounded tombstone and cleanup runs in bounded pages as posts and revisions grow” `test/content/post-soft-deletion.test.ts`: “post delete and restore stay bounded”, scales [64, 256, 1024].                                                                          |
| Thread/post takedown                      | Read/write target/security revision and bounded projection; command event.                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/moderation-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                |
| Report storage                            | Insert one report and its event through the report-home command.                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks in report and command history.                                                                                                                                                                                                                                                                                                                        | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report read and target listing            | Owner read checks the exact report reference, native `account:read` on the reporter's account, the exact report record and current owner/authority again. Moderators retain the target Access check. Listing uses the target-index keyset page and selected report rows, bounded by the fixed page limit.                                                                                                                                                               | Constant rows/statements for a point read; linear rows in page limit for listing; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                           | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report inspection HTTP admission          | Authenticate and read the target partition, Access grant and report state for each inspection request.                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in grant and report history.                                                                                                                                                                                                                                                                                                                          | `test/content/reports-http.test.ts`: “checkGrowth proves constant report HTTP work with unrelated and hot-partition growth at three scales”                                                                                                                                                                                    |
| Report effect projection                  | Read one committed report source reference and run one target-partition reverse-index command.                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements per report event; logarithmic blocks in source and target histories.                                                                                                                                                                                                                                                                                                      | Missing: no native projection growth check covers source and target history.                                                                                                                                                                                                                                                   |
| Thread/post reaction slot                 | Actor-target slot read/update and command; post targets add bounded ancestry. Current check measures thread set at 64/512/4096.                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements, logarithmic blocks for measured set branch; known defect, owner fix pending for clear/post branches.                                                                                                                                                                                                                                                                     | `test/content/growth-reactions.test.ts`: “Reaction slot”                                                                                                                                                                                                                                                                       |
| Subject reaction slot                     | Global `reaction:set` key probe and actor-subject slot read/update; current slot check measures set only.                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in Global grants for set; clear bound pending.                                                                                                                                                                                                                                                                                                        | `test/content/growth-reactions.test.ts`: “Subject reaction slot”; `test/content/subject-reaction-standing.test.ts`: “a subject reaction's Global standing probe stays within its bound as Global grants to other accounts grow”                                                                                                |
| Reaction count aggregation                | Apply fixed event changes to totals and relay projections.                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements for fixed changes; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                    | `test/content/reaction-projection.test.ts`: “aggregation cost is O(changes) as reactions and targets grow”                                                                                                                                                                                                                     |
| Reaction count read                       | `reaction-projection.readReactionCounts` reads <= 7 totals/target; page <= 7L rows per partition for L targets.                                                                                                                                                                                                                                                                                                                                                         | Linear rows in fixed L; constant statements per partition, independent of contributors.                                                                                                                                                                                                                                                                                                            | `test/content/subject-reactions-http.test.ts`: “subject reaction read”                                                                                                                                                                                                                                                         |
| Report outcome                            | Per page, at most 100 reports by an index range on `report_target`, with one notice each. Dismiss is one report row, one authorization check and one notice.                                                                                                                                                                                                                                                                                                            | Amortized one resolution per report.                                                                                                                                                                                                                                                                                                                                                               | Reports per target at scales [64, 256, 1024], with constant rows per page.                                                                                                                                                                                                                                                     |
| Subject reaction count batch              | One statement/target partition for <= 100 IDs; <= 5 totals/ID.                                                                                                                                                                                                                                                                                                                                                                                                          | O(n) rows, n <= 100; constant statements per partition, independent of reactors.                                                                                                                                                                                                                                                                                                                   | `test/content/subject-reactions-http.test.ts`: “batched subject reaction counts”                                                                                                                                                                                                                                               |
| Subject own reaction read                 | Subject visibility/redirect/Access then caller-home slot read; no reactor scan.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements at fixed target; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                      | `test/content/subject-reactions-http.test.ts`: “subject own reaction read”                                                                                                                                                                                                                                                     |
| Liked version write                       | Reaction statement: at most two actor primary-key upserts of `content.reaction_liked_version` for eligible changes; otherwise only the trigger predicate.                                                                                                                                                                                                                                                                                                               | Constant rows; statements unchanged (trigger work is inside the write); logarithmic blocks in versions per partition.                                                                                                                                                                                                                                                                              | `test/content/growth-reactions.test.ts`: “Subject reaction slot”, at 64, 512 and 4096, unchanged.                                                                                                                                                                                                                              |
| Liked version read                        | One primary-key read in the actor's partition, joined in page and membership statements.                                                                                                                                                                                                                                                                                                                                                                                | Constant rows and one statement; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                               | `test/content/liked-read.test.ts`: raw primitive check at 0, 1,000 and 10,000 other reactions.                                                                                                                                                                                                                                 |
| Subject reaction merge                    | Process one page of source slots and update target slots/count events.                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements per fixed page; linear in changed slots across pages.                                                                                                                                                                                                                                                                                                                     | `test/content/subject-reaction-merge.test.ts`: “one merge page”                                                                                                                                                                                                                                                                |
| Realm board listing                       | Keyset-read boards and native Realm/member/grant disclosure.                                                                                                                                                                                                                                                                                                                                                                                                            | Linear rows in fixed limit; constant statements and logarithmic blocks.                                                                                                                                                                                                                                                                                                                            | `test/content/realm-boards.test.ts`: “Realm board keyset listing stays bounded as other Realms add boards”                                                                                                                                                                                                                     |
| Protected Realm thread read               | Resolve membership/access and disclose bounded thread ancestry.                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements for fixed ancestry; logarithmic blocks in grant/member/board history.                                                                                                                                                                                                                                                                                                     | `test/content/realm-boards.test.ts`: “Protected Realm member thread read”                                                                                                                                                                                                                                                      |
| Global board creation                     | Read Concept type, read authority and Global anchor; insert the board, grants and command state in the Concept partition.                                                                                                                                                                                                                                                                                                                                               | O(1) statements and rows, independent of boards, Concepts and threads.                                                                                                                                                                                                                                                                                                                             | `test/content/global-board-create-http.test.ts`: “a governance account creates published and protected Global boards over HTTP and authors post reviews and discussions on them”                                                                                                                                               |
| Realm board point read                    | Resolve one board by its Realm/concept keys through the route's native Access and disclosure checks.                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements; logarithmic blocks as other boards, threads and Realms grow.                                                                                                                                                                                                                                                                                                             | `test/content/board-read-growth.test.ts`: “Realm board read by concept stays within its bound as boards grow”.                                                                                                                                                                                                                 |
| Media reserve                             | Validate bounded ancestry; read/write reservation/object keys, Access and command.                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media reserve stays within its bound as u grows”                                                                                                                                                                                                                                         |
| Media complete                            | Read reservation and write completion state for one upload.                                                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media complete stays within its bound as u grows”                                                                                                                                                                                                                                        |
| Media reservation/state reads             | Exact reservation/state/fence key probes.                                                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media reservation and state reads stays within its bound as u grows”                                                                                                                                                                                                                     |
| Post media claim                          | Read bounded post/revision ancestry and claim one media object.                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks in revision history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Post media claim stays within its bound as r grows”                                                                                                                                                                                                                                      |
| Image publication                         | Read bounded job/object state and publish at most twelve variants.                                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements for fixed input; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Image publication stays within its bound as u grows”                                                                                                                                                                                                                                     |
| Imported image processing                 | Read source fence then checkout selected media; publish bounded variants.                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Imported image processing stays within its bound as u grows”                                                                                                                                                                                                                             |
| Imported document append/read             | Append/read exact imported-field key with bounded metadata.                                                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks in partition history.                                                                                                                                                                                                                                                                                                                                 | `test/content/growth-lifecycle.test.ts`: “Imported document append and read stays within its bound as P grows”                                                                                                                                                                                                                 |
| Source fence check                        | Read fixed source-fence keys for requested page.                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media.test.ts`: “Source fence check stays within its bound as P grows”                                                                                                                                                                                                                                    |
| Source fence takedown                     | Update one fence and emit one command event.                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-lifecycle.test.ts`: “Source fence takedown stays within its bound as T grows”                                                                                                                                                                                                                             |
| Media takedown                            | Read/update selected moderation state by exact keys.                                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements; logarithmic blocks in media history.                                                                                                                                                                                                                                                                                                                                     | `test/content/media-moderation.test.ts`: “checkGrowth with actual formula across three informative scales and no content sequential scan”                                                                                                                                                                                      |
| Standalone media erasure                  | Tombstone selected media and emit media-erased event.                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media-erase.test.ts`: “Erase media stays within its bound as M grows”                                                                                                                                                                                                                                     |
| Media download decision                   | Validate exact original/variant and recheck current post/container chain and board.                                                                                                                                                                                                                                                                                                                                                                                     | Constant rows/statements for bounded ancestry; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                 | `test/content/media-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                     |
| Committed media purge                     | Read partition/media keys, delete only committed erased prefix; R2 listing/key quotas apply.                                                                                                                                                                                                                                                                                                                                                                            | Constant SQL rows/statements; logarithmic blocks; R2 <= 10,000 pages and 100,000 keys.                                                                                                                                                                                                                                                                                                             | `test/content/growth-lifecycle.test.ts`: “Committed media purge stays within its bound as T grows”                                                                                                                                                                                                                             |
| Sitemap board/thread feeds                | Keyset boards and bounded newest-first thread probes/disclosure; L <= 1000 and 200 thread candidates/probe.                                                                                                                                                                                                                                                                                                                                                             | O(L log N) rows and constant statements per fixed-L page.                                                                                                                                                                                                                                                                                                                                          | `test/content/growth-sitemap.test.ts`: “${feed} sitemap page stays within its bound as listed items grow”                                                                                                                                                                                                                      |
| Durable content work                      | Enqueue/status and registered steps; collection check includes actual Delta linearity.                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements for fixed payload/page; linear only in changed collection objects.                                                                                                                                                                                                                                                                                                        | `test/content/work.test.ts`: “checkGrowth proves bounded real collection SQL with same-partition distractors at three scales”                                                                                                                                                                                                  |
| Source fence HTTP routes                  | Validate two independent roots, tuple-home snapshot and final authentication.                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements for fixed ancestry; logarithmic blocks in same-source partition rows.                                                                                                                                                                                                                                                                                                     | `test/content/source-fence-http.test.ts`: “checkGrowth keeps actual HTTP authorization and exact tuple cost bounded amid same-source partition rows”                                                                                                                                                                           |
| Deleted post purge                        | One deletion-time index range selects <=100 unfinished expired posts, then existing revision-index pages of <=100 with exact post fences. Completion excludes the post from the selection index.                                                                                                                                                                                                                                                                        | Constant statements/rows per selection and revision page; total work linear in deleted posts and their revisions.                                                                                                                                                                                                                                                                                  | `test/content/post-soft-deletion.test.ts`: `deleted post purge selection stays bounded`, scales 64, 256, 1024.                                                                                                                                                                                                                 |
| Operation                                 | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Bound                                                                                                                                                                                                                                                                                                                                                                                              | Growth check                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------      | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                  | ------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                                                                                                                     | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authored document append/read             | Validate/hash <= 2 MiB; append one field and event; exact-key read.                                                                                                                                                                                                                                                                                                                                                                                                     | Constant rows/statements; logarithmic blocks in documents.                                                                                                                                                                                                                                                                                                                                         | `test/content/authored-fields.test.ts`: “authored document append and read”                                                                                                                                                                                                                                                    |
| Authored document erasure                 | Account admission, `document:erase` Access, one exact tombstone and first-transition event.                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks plus Access and command.                                                                                                                                                                                                                                                                                                                              | `test/content/authored-field-erasure.test.ts`: “authored document erasure”                                                                                                                                                                                                                                                     |
| Authored document HTTP read               | Initial/final imported/authored probes, prepared Access recheck and candidate disclosure.                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements independent of documents.                                                                                                                                                                                                                                                                                                                                                 | `test/content/authored-document-http.test.ts`: “authored document read”                                                                                                                                                                                                                                                        |
| Document read                             | Bounded candidate tuples and selected body; Accounts formula and exact tuple probes.                                                                                                                                                                                                                                                                                                                                                                                    | Constant candidate rows/statements; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                                                                         | `test/content/document-http.test.ts`: “checkGrowth includes actual Accounts formula and constant exact document candidate and tuple probes”                                                                                                                                                                                    |
| Avatar summaries                          | One statement per media partition; media row and variants per ID, n <= 256.                                                                                                                                                                                                                                                                                                                                                                                             | Linear rows in n; fixed statements per partition, independent of media history.                                                                                                                                                                                                                                                                                                                    | `test/content/avatar-media.test.ts`: “avatar summaries”                                                                                                                                                                                                                                                                        |
| Avatar check                              | One media primary-key read in account partition.                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/avatar-media.test.ts`: “avatar check”                                                                                                                                                                                                                                                                            |
| Author item index                         | Guarded upsert/delete per event; erasure reads post and thread anchor; command event.                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks in index history.                                                                                                                                                                                                                                                                                                                                     | `test/content/author-item-index.test.ts`: “author item index”                                                                                                                                                                                                                                                                  |
| Author thread page                        | Public-view point read, <= 4L author-index candidates and thread/board disclosure probes.                                                                                                                                                                                                                                                                                                                                                                               | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                                                                                                                                                                                                                                                                                                  | `test/content/author-item-reads.test.ts`: “author thread page”                                                                                                                                                                                                                                                                 |
| Author post page                          | Public-view point read, <= 4L author-index candidates and post/thread disclosure probes.                                                                                                                                                                                                                                                                                                                                                                                | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                                                                                                                                                                                                                                                                                                  | `test/content/author-item-reads.test.ts`: “author post page”                                                                                                                                                                                                                                                                   |
| Board projection                          | Bounded source ancestry/page; fixed candidate/change set in destination command.                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks at fixed page/change set.                                                                                                                                                                                                                                                                                                                             | `test/content/board-read-growth.test.ts`: “Board projection stays within its bound as T grows”                                                                                                                                                                                                                                 |
| Board candidate page                      | Keyset-read at most d created-at candidates; active rank uses separate rank index.                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements and logarithmic blocks for fixed d; ascending growth is not captured.                                                                                                                                                                                                                                                                                                     | `test/content/board-read-growth.test.ts`: “Board candidate page stays within its bound as d grows”                                                                                                                                                                                                                             |
| Board pages (newest, active, hot)         | Board point read, <= 200 candidates and bounded thread/board/Realm disclosure; result <= 100.                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements for fixed page/chain; logarithmic indexed blocks.                                                                                                                                                                                                                                                                                                                         | `test/content/boards-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”, `test/content/board-hot-http.test.ts`: “the hot page stays within its bound as boards and threads grow”, `test/content/board-ranking.test.ts`: “active board pages keep constant cost as boards and threads grow” |
| Board rank refresh                        | Lock <= 500 candidates; per-partition totals/Realm weights, then batch update.                                                                                                                                                                                                                                                                                                                                                                                          | Linear B rows with logarithmic blocks in R, <= 2B + 2 statements (B <= 500); independent of reactions/thread.                                                                                                                                                                                                                                                                                      | `test/content/board-hot-refresh.test.ts`: “one refresh batch stays within its bound as candidates and reactions grow”                                                                                                                                                                                                          |
| Collection selection                      | Select eligible media through bounded indexed page, limit 100.                                                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements for fixed page; logarithmic blocks in media history.                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media.test.ts`: “Collection selection stays within its bound as P grows”                                                                                                                                                                                                                                  |
| Collection per object                     | Read and update one selected object and bounded state.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Collection per object stays within its bound as u grows”                                                                                                                                                                                                                                 |
| Cover reference read/claim                | Exact media probes and bounded cover-reference writes.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Cover reference read and claim stays within its bound as u grows”                                                                                                                                                                                                                        |
| Thread creation with first post           | Validate bounded board/Realm ancestry; insert thread/post/revision/indexes, Access and command.                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                                                                                   | `test/content/growth-threads.test.ts`: “Thread creation with first post stays within its bound as T grows”                                                                                                                                                                                                                     |
| Review creation                           | Board validation; thread/post/revision writes, live-review probe, Access and command; one point read only on conflict.                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in author's reviews; success independent of board review count.                                                                                                                                                                                                                                                                                       | `test/content/growth-threads.test.ts`: “Review creation stays within its bound as the reviews board grows”; `test/content/review-conflict-http.test.ts` pins success and conflict statements.                                                                                                                                  |
| Reply                                     | Validate <= 32 parent posts and bounded ancestry; insert post/revision/indexes.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks, independent of post count.                                                                                                                                                                                                                                                                                                                           | `test/content/growth-threads.test.ts`: “Reply stays within its bound as p grows”                                                                                                                                                                                                                                               |
| Post edit                                 | Read target/head and bounded chain; insert revision and update head.                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements; logarithmic blocks, independent of revision history.                                                                                                                                                                                                                                                                                                                     | `test/content/growth-threads.test.ts`: “Post edit (new revision) stays within its bound as r grows”                                                                                                                                                                                                                            |
| Thread read                               | Exact thread/board and bounded disclosure; +1 board-home snapshot, Access and current Realm ban key; no history walk.                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-threads.test.ts`: “Thread read stays within its bound as T grows”                                                                                                                                                                                                                                         |
| Post read                                 | Exact post/head and bounded disclosure; +1 board-home snapshot, Access and current Realm ban key; bounded body.                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-threads.test.ts`: “Post read stays within its bound as T grows”                                                                                                                                                                                                                                           |
| Revision read                             | Exact revision key and bounded chain; +1 board-home snapshot, Access and current Realm ban key; no history walk.                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks, independent of revision history.                                                                                                                                                                                                                                                                                                                     | `test/content/growth-threads.test.ts`: “Revision read stays within its bound as T grows”                                                                                                                                                                                                                                       |
| Post keyset page                          | <= s + 1 identities (s <= 200), bounded disclosure; public page <= 100.                                                                                                                                                                                                                                                                                                                                                                                                 | Linear rows in fixed s; constant statements, logarithmic blocks; no older-history walk.                                                                                                                                                                                                                                                                                                            | `test/content/growth-threads.test.ts`: “Post keyset page stays within its bound as p grows”                                                                                                                                                                                                                                    |
| Revision keyset page                      | <= s + 1 identities (s <= 200); full enumeration costs O(r) across pages.                                                                                                                                                                                                                                                                                                                                                                                               | Linear rows in fixed s; constant statements, logarithmic blocks.                                                                                                                                                                                                                                                                                                                                   | `test/content/growth-threads.test.ts`: “Revision keyset page stays within its bound as r grows”                                                                                                                                                                                                                                |
| Public board read                         | Exact board key and current disclosure state.                                                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements; logarithmic blocks in thread history.                                                                                                                                                                                                                                                                                                                                    | `test/content/growth-threads.test.ts`: “Public board read stays within its bound as T grows”                                                                                                                                                                                                                                   |
| Subject thread page                       | Bounded subject-thread index page and candidate disclosure.                                                                                                                                                                                                                                                                                                                                                                                                             | Linear rows in fixed page size; constant statements and logarithmic blocks.                                                                                                                                                                                                                                                                                                                        | `test/content/growth-subject-threads.test.ts`: “subject thread page stays within its bound as the subject thread index grows”                                                                                                                                                                                                  |
| Subject thread index projection           | Write one subject-thread index entry per thread event.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks as other threads grow.                                                                                                                                                                                                                                                                                                                                | `test/content/subject-thread-index.test.ts`: “indexing one thread has constant rows and statements and logarithmic blocks as other threads grow”                                                                                                                                                                               |
| Author erasure request                    | Admission snapshot, provenance and operation row; command and workflow binding.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/erasure-initiation-provenance.test.ts`: “initiation keeps its wire, admission and one-attempt cost; the growth check holds at three scales”                                                                                                                                                                      |
| Author erasure binding/status             | Point-read/write workflow identity and operation status.                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-lifecycle.test.ts`: “Author erasure binding and status stays within its bound as P grows”                                                                                                                                                                                                                 |
| Native author erasure                     | Fixed posts/revisions/media page and operation/initiator reads; count only page revision identities.                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements per page; linear rows in affected k revisions; logarithmic blocks.                                                                                                                                                                                                                                                                                                        | `test/content/erasure-workflow.test.ts`: “native content erasure pages”; “affected erasure revisions”; “native logical author page”                                                                                                                                                                                            |
| Author post deletion/restore/cleanup      | One tombstone command; clear revisions in bounded pages, only affected keys. Delete and restore each raise one security revision and emit one event; restore reclaims one review slot without enumerating revisions. Cleanup starts after the restore window or an immediate moderation/account purge.                                                                                                                                                                  | Constant rows/statements per command/page; linear in affected revisions across pages.                                                                                                                                                                                                                                                                                                              | `test/content/author-post-delete.test.ts`: “delete is one bounded tombstone and cleanup runs in bounded pages as posts and revisions grow” `test/content/post-soft-deletion.test.ts`: “post delete and restore stay bounded”, scales [64, 256, 1024].                                                                          |
| Thread/post takedown                      | Read/write target/security revision and bounded projection; command event.                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/moderation-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                |
| Report storage                            | Insert one report and its event through the report-home command.                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks in report and command history.                                                                                                                                                                                                                                                                                                                        | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report read and target listing            | Exact report read; target-index keyset page and selected report rows, bounded by the fixed page limit.                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements for a point read; linear rows in page limit for listing; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                           | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report inspection HTTP admission          | Authenticate and read the target partition, Access grant and report state for each inspection request.                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in grant and report history.                                                                                                                                                                                                                                                                                                                          | `test/content/reports-http.test.ts`: “checkGrowth proves constant report HTTP work with unrelated and hot-partition growth at three scales”                                                                                                                                                                                    |
| Report effect projection                  | Read one committed report source reference and run one target-partition reverse-index command.                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements per report event; logarithmic blocks in source and target histories.                                                                                                                                                                                                                                                                                                      | Missing: no native projection growth check covers source and target history.                                                                                                                                                                                                                                                   |
| Thread/post reaction slot                 | Actor-target slot read/update and command; post targets add bounded ancestry. Current check measures thread set at 64/512/4096.                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements, logarithmic blocks for measured set branch; known defect, owner fix pending for clear/post branches.                                                                                                                                                                                                                                                                     | `test/content/growth-reactions.test.ts`: “Reaction slot”                                                                                                                                                                                                                                                                       |
| Subject reaction slot                     | Global `reaction:set` key probe and actor-subject slot read/update; current slot check measures set only.                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in Global grants for set; clear bound pending.                                                                                                                                                                                                                                                                                                        | `test/content/growth-reactions.test.ts`: “Subject reaction slot”; `test/content/subject-reaction-standing.test.ts`: “a subject reaction's Global standing probe stays within its bound as Global grants to other accounts grow”                                                                                                |
| Reaction count aggregation                | Apply fixed event changes to totals and relay projections.                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements for fixed changes; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                    | `test/content/reaction-projection.test.ts`: “aggregation cost is O(changes) as reactions and targets grow”                                                                                                                                                                                                                     |
| Reaction count read                       | `reaction-projection.readReactionCounts` reads <= 7 totals/target; page <= 7L rows per partition for L targets.                                                                                                                                                                                                                                                                                                                                                         | Linear rows in fixed L; constant statements per partition, independent of contributors.                                                                                                                                                                                                                                                                                                            | `test/content/subject-reactions-http.test.ts`: “subject reaction read”                                                                                                                                                                                                                                                         |
| Report outcome                            | Per page, at most 100 reports by an index range on `report_target`, with one notice each. Dismiss is one report row, one authorization check and one notice.                                                                                                                                                                                                                                                                                                            | Amortized one resolution per report.                                                                                                                                                                                                                                                                                                                                                               | Reports per target at scales [64, 256, 1024], with constant rows per page.                                                                                                                                                                                                                                                     |
| Subject reaction count batch              | One statement/target partition for <= 100 IDs; <= 5 totals/ID.                                                                                                                                                                                                                                                                                                                                                                                                          | O(n) rows, n <= 100; constant statements per partition, independent of reactors.                                                                                                                                                                                                                                                                                                                   | `test/content/subject-reactions-http.test.ts`: “batched subject reaction counts”                                                                                                                                                                                                                                               |
| Subject own reaction read                 | Subject visibility/redirect/Access then caller-home slot read; no reactor scan.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements at fixed target; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                      | `test/content/subject-reactions-http.test.ts`: “subject own reaction read”                                                                                                                                                                                                                                                     |
| Liked version write                       | Reaction statement: at most two actor primary-key upserts of `content.reaction_liked_version` for eligible changes; otherwise only the trigger predicate.                                                                                                                                                                                                                                                                                                               | Constant rows; statements unchanged (trigger work is inside the write); logarithmic blocks in versions per partition.                                                                                                                                                                                                                                                                              | `test/content/growth-reactions.test.ts`: “Subject reaction slot”, at 64, 512 and 4096, unchanged.                                                                                                                                                                                                                              |
| Liked version read                        | One primary-key read in the actor's partition, joined in page and membership statements.                                                                                                                                                                                                                                                                                                                                                                                | Constant rows and one statement; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                               | `test/content/liked-read.test.ts`: raw primitive check at 0, 1,000 and 10,000 other reactions.                                                                                                                                                                                                                                 |
| Subject reaction merge                    | Process one page of source slots and update target slots/count events.                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements per fixed page; linear in changed slots across pages.                                                                                                                                                                                                                                                                                                                     | `test/content/subject-reaction-merge.test.ts`: “one merge page”                                                                                                                                                                                                                                                                |
| Realm board listing                       | Keyset-read boards and native Realm/member/grant disclosure.                                                                                                                                                                                                                                                                                                                                                                                                            | Linear rows in fixed limit; constant statements and logarithmic blocks.                                                                                                                                                                                                                                                                                                                            | `test/content/realm-boards.test.ts`: “Realm board keyset listing stays bounded as other Realms add boards”                                                                                                                                                                                                                     |
| Protected Realm thread read               | Resolve membership/access and disclose bounded thread ancestry.                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements for fixed ancestry; logarithmic blocks in grant/member/board history.                                                                                                                                                                                                                                                                                                     | `test/content/realm-boards.test.ts`: “Protected Realm member thread read”                                                                                                                                                                                                                                                      |
| Global board creation                     | Read Concept type, read authority and Global anchor; insert the board, grants and command state in the Concept partition.                                                                                                                                                                                                                                                                                                                                               | O(1) statements and rows, independent of boards, Concepts and threads.                                                                                                                                                                                                                                                                                                                             | `test/content/global-board-create-http.test.ts`: “a governance account creates published and protected Global boards over HTTP and authors post reviews and discussions on them”                                                                                                                                               |
| Realm board point read                    | Resolve one board by its Realm/concept keys.                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant rows/statements; logarithmic blocks in board history.                                                                                                                                                                                                                                                                                                                                     | Missing: no native growth check covers this point read.                                                                                                                                                                                                                                                                        |
| Media reserve                             | Validate bounded ancestry; read/write reservation/object keys, Access and command.                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media reserve stays within its bound as u grows”                                                                                                                                                                                                                                         |
| Media complete                            | Read reservation and write completion state for one upload.                                                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media complete stays within its bound as u grows”                                                                                                                                                                                                                                        |
| Media reservation/state reads             | Exact reservation/state/fence key probes.                                                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media reservation and state reads stays within its bound as u grows”                                                                                                                                                                                                                     |
| Post media claim                          | Read bounded post/revision ancestry and claim one media object.                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks in revision history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Post media claim stays within its bound as r grows”                                                                                                                                                                                                                                      |
| Image publication                         | Read bounded job/object state and publish at most twelve variants.                                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements for fixed input; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Image publication stays within its bound as u grows”                                                                                                                                                                                                                                     |
| Imported image processing                 | Read source fence then checkout selected media; publish bounded variants.                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Imported image processing stays within its bound as u grows”                                                                                                                                                                                                                             |
| Imported document append/read             | Append/read exact imported-field key with bounded metadata.                                                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks in partition history.                                                                                                                                                                                                                                                                                                                                 | `test/content/growth-lifecycle.test.ts`: “Imported document append and read stays within its bound as P grows”                                                                                                                                                                                                                 |
| Source fence check                        | Read fixed source-fence keys for requested page.                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media.test.ts`: “Source fence check stays within its bound as P grows”                                                                                                                                                                                                                                    |
| Source fence takedown                     | Update one fence and emit one command event.                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-lifecycle.test.ts`: “Source fence takedown stays within its bound as T grows”                                                                                                                                                                                                                             |
| Media takedown                            | Read/update selected moderation state by exact keys.                                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements; logarithmic blocks in media history.                                                                                                                                                                                                                                                                                                                                     | `test/content/media-moderation.test.ts`: “checkGrowth with actual formula across three informative scales and no content sequential scan”                                                                                                                                                                                      |
| Standalone media erasure                  | Tombstone selected media and emit media-erased event.                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media-erase.test.ts`: “Erase media stays within its bound as M grows”                                                                                                                                                                                                                                     |
| Media download decision                   | Validate exact original/variant and recheck current post/container chain and board. A Realm board adds three `realm-read.sql` probes: initial eligibility, final native eligibility and final signature check. Each seeks at most one Realm identity and its exact head revision. Protected Realms add two `ban-current.sql` seeks, each matching at most one current ban row; the last Realm snapshot also adds one authoritative-time and one partition-anchor query. | Constant extra statements/rows for H<=34 and two fixed native Access preparations/formulas; O(H log R) blocks over Realm, grant and ban indexes, using the request's fixed deadline.                                                                                                                                                                                                               | `test/content/media-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”; `test/content/growth-media-realm-download.test.ts`: “Native Realm media download cost stays bounded with unrelated Realm, ban, grant, media and receipt history”                                                   |
| Committed media purge                     | Read partition/media keys, delete only committed erased prefix; R2 listing/key quotas apply.                                                                                                                                                                                                                                                                                                                                                                            | Constant SQL rows/statements; logarithmic blocks; R2 <= 10,000 pages and 100,000 keys.                                                                                                                                                                                                                                                                                                             | `test/content/growth-lifecycle.test.ts`: “Committed media purge stays within its bound as T grows”                                                                                                                                                                                                                             |
| Sitemap board/thread feeds                | Keyset boards and bounded newest-first thread probes/disclosure; L <= 1000 and 200 thread candidates/probe.                                                                                                                                                                                                                                                                                                                                                             | O(L log N) rows and constant statements per fixed-L page.                                                                                                                                                                                                                                                                                                                                          | `test/content/growth-sitemap.test.ts`: “${feed} sitemap page stays within its bound as listed items grow”                                                                                                                                                                                                                      |
| Durable content work                      | Enqueue/status and registered steps; collection check includes actual Delta linearity.                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements for fixed payload/page; linear only in changed collection objects.                                                                                                                                                                                                                                                                                                        | `test/content/work.test.ts`: “checkGrowth proves bounded real collection SQL with same-partition distractors at three scales”                                                                                                                                                                                                  |
| Source fence HTTP routes                  | Validate two independent roots, tuple-home snapshot and final authentication.                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements for fixed ancestry; logarithmic blocks in same-source partition rows.                                                                                                                                                                                                                                                                                                     | `test/content/source-fence-http.test.ts`: “checkGrowth keeps actual HTTP authorization and exact tuple cost bounded amid same-source partition rows”                                                                                                                                                                           |
| Deleted post purge                        | One deletion-time index range selects <=100 unfinished expired posts, then existing revision-index pages of <=100 with exact post fences. Completion excludes the post from the selection index.                                                                                                                                                                                                                                                                        | Constant statements/rows per selection and revision page; total work linear in deleted posts and their revisions.                                                                                                                                                                                                                                                                                  | `test/content/post-soft-deletion.test.ts`: `deleted post purge selection stays bounded`, scales 64, 256, 1024.                                                                                                                                                                                                                 |
| Operation                                 | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Bound                                                                                                                                                                                                                                                                                                                                                                                              | Growth check                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------      | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                  | ------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                                                                                                                     | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authored document append/read             | Validate/hash <= 2 MiB; append one field and event; exact-key read.                                                                                                                                                                                                                                                                                                                                                                                                     | Constant rows/statements; logarithmic blocks in documents.                                                                                                                                                                                                                                                                                                                                         | `test/content/authored-fields.test.ts`: “authored document append and read”                                                                                                                                                                                                                                                    |
| Authored document erasure                 | Account admission, `document:erase` Access, one exact tombstone and first-transition event.                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks plus Access and command.                                                                                                                                                                                                                                                                                                                              | `test/content/authored-field-erasure.test.ts`: “authored document erasure”                                                                                                                                                                                                                                                     |
| Authored document HTTP read               | Initial/final imported/authored probes, prepared Access recheck and candidate disclosure.                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements independent of documents.                                                                                                                                                                                                                                                                                                                                                 | `test/content/authored-document-http.test.ts`: “authored document read”                                                                                                                                                                                                                                                        |
| Document read                             | Bounded candidate tuples and selected body; Accounts formula and exact tuple probes.                                                                                                                                                                                                                                                                                                                                                                                    | Constant candidate rows/statements; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                                                                         | `test/content/document-http.test.ts`: “checkGrowth includes actual Accounts formula and constant exact document candidate and tuple probes”                                                                                                                                                                                    |
| Avatar summaries                          | One statement per media partition; media row and variants per ID, n <= 256.                                                                                                                                                                                                                                                                                                                                                                                             | Linear rows in n; fixed statements per partition, independent of media history.                                                                                                                                                                                                                                                                                                                    | `test/content/avatar-media.test.ts`: “avatar summaries”                                                                                                                                                                                                                                                                        |
| Avatar check                              | One media primary-key read in account partition.                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/avatar-media.test.ts`: “avatar check”                                                                                                                                                                                                                                                                            |
| Author item index                         | Guarded upsert/delete per event; erasure reads post and thread anchor; command event.                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks in index history.                                                                                                                                                                                                                                                                                                                                     | `test/content/author-item-index.test.ts`: “author item index”                                                                                                                                                                                                                                                                  |
| Author thread page                        | Public-view point read, <= 4L author-index candidates and thread/board disclosure probes.                                                                                                                                                                                                                                                                                                                                                                               | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                                                                                                                                                                                                                                                                                                  | `test/content/author-item-reads.test.ts`: “author thread page”                                                                                                                                                                                                                                                                 |
| Author post page                          | Public-view point read, <= 4L author-index candidates and post/thread disclosure probes.                                                                                                                                                                                                                                                                                                                                                                                | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                                                                                                                                                                                                                                                                                                  | `test/content/author-item-reads.test.ts`: “author post page”                                                                                                                                                                                                                                                                   |
| Board projection                          | Bounded source ancestry/page; fixed candidate/change set in destination command.                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks at fixed page/change set.                                                                                                                                                                                                                                                                                                                             | `test/content/board-read-growth.test.ts`: “Board projection stays within its bound as T grows”                                                                                                                                                                                                                                 |
| Board candidate page                      | Keyset-read at most d created-at candidates; active rank uses separate rank index.                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements and logarithmic blocks for fixed d; ascending growth is not captured.                                                                                                                                                                                                                                                                                                     | `test/content/board-read-growth.test.ts`: “Board candidate page stays within its bound as d grows”                                                                                                                                                                                                                             |
| Board pages (newest, oldest, active, hot) | E Access preparation statements; one candidate snapshot; at most two selection snapshots (6 statements each); one final snapshot over at most s + 1 survivors. s <= 100, Q <= 200.                                                                                                                                                                                                                                                                                      | At most 43 data statements per database: 26 + E outside a Realm, 30 + E on a public Realm board, 32 + E on a non-public Realm board. E <= 6 per [Accounts read-decision bound](../access/README.md#read-decisions). Rows O(2Q + (Q + s + 1) D_rows + B_rows); blocks logarithmic in indexed relations. These batched key reads follow [data access](../../../../docs/architecture.md#data-access). | `test/content/growth-board-sorts.test.ts`: “board pages under newest, oldest, active and hot, with their disclosure passes, stay within the written bound as threads, boards and hidden candidates grow”                                                                                                                       |
| Board rank refresh                        | Lock <= 500 candidates; per-partition totals/Realm weights, then batch update.                                                                                                                                                                                                                                                                                                                                                                                          | Linear B rows with logarithmic blocks in R, <= 2B + 2 statements (B <= 500); independent of reactions/thread.                                                                                                                                                                                                                                                                                      | `test/content/board-hot-refresh.test.ts`: “one refresh batch stays within its bound as candidates and reactions grow”                                                                                                                                                                                                          |
| Collection selection                      | Select eligible media through bounded indexed page, limit 100.                                                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements for fixed page; logarithmic blocks in media history.                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media.test.ts`: “Collection selection stays within its bound as P grows”                                                                                                                                                                                                                                  |
| Collection per object                     | Read and update one selected object and bounded state.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Collection per object stays within its bound as u grows”                                                                                                                                                                                                                                 |
| Cover reference read/claim                | Exact media probes and bounded cover-reference writes.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Cover reference read and claim stays within its bound as u grows”                                                                                                                                                                                                                        |
| Thread creation with first post           | Validate bounded board/Realm ancestry; insert thread/post/revision/indexes, Access and command.                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                                                                                   | `test/content/growth-threads.test.ts`: “Thread creation with first post stays within its bound as T grows”                                                                                                                                                                                                                     |
| Review creation                           | Board validation; thread/post/revision writes, live-review probe, Access and command; one point read only on conflict.                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in author's reviews; success independent of board review count.                                                                                                                                                                                                                                                                                       | `test/content/growth-threads.test.ts`: “Review creation stays within its bound as the reviews board grows”; `test/content/review-conflict-http.test.ts` pins success and conflict statements.                                                                                                                                  |
| Reply                                     | Validate <= 32 parent posts and bounded ancestry; insert post/revision/indexes.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks, independent of post count.                                                                                                                                                                                                                                                                                                                           | `test/content/growth-threads.test.ts`: “Reply stays within its bound as p grows”                                                                                                                                                                                                                                               |
| Post edit                                 | Read target/head and bounded chain; insert revision and update head.                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements; logarithmic blocks, independent of revision history.                                                                                                                                                                                                                                                                                                                     | `test/content/growth-threads.test.ts`: “Post edit (new revision) stays within its bound as r grows”                                                                                                                                                                                                                            |
| Thread read                               | Exact thread/board and bounded disclosure; +1 board-home snapshot, Access and current Realm ban key; no history walk.                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-threads.test.ts`: “Thread read stays within its bound as T grows”                                                                                                                                                                                                                                         |
| Post read                                 | Exact post/head and bounded disclosure; +1 board-home snapshot, Access and current Realm ban key; bounded body.                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-threads.test.ts`: “Post read stays within its bound as T grows”                                                                                                                                                                                                                                           |
| Revision read                             | Exact revision key and bounded chain; +1 board-home snapshot, Access and current Realm ban key; no history walk.                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks, independent of revision history.                                                                                                                                                                                                                                                                                                                     | `test/content/growth-threads.test.ts`: “Revision read stays within its bound as T grows”                                                                                                                                                                                                                                       |
| Post keyset page                          | <= s + 1 identities (s <= 200), bounded disclosure; public page <= 100.                                                                                                                                                                                                                                                                                                                                                                                                 | Linear rows in fixed s; constant statements, logarithmic blocks; no older-history walk.                                                                                                                                                                                                                                                                                                            | `test/content/growth-threads.test.ts`: “Post keyset page stays within its bound as p grows”                                                                                                                                                                                                                                    |
| Revision keyset page                      | <= s + 1 identities (s <= 200); full enumeration costs O(r) across pages.                                                                                                                                                                                                                                                                                                                                                                                               | Linear rows in fixed s; constant statements, logarithmic blocks.                                                                                                                                                                                                                                                                                                                                   | `test/content/growth-threads.test.ts`: “Revision keyset page stays within its bound as r grows”                                                                                                                                                                                                                                |
| Public board read                         | Exact board key and current disclosure state.                                                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements; logarithmic blocks in thread history.                                                                                                                                                                                                                                                                                                                                    | `test/content/growth-threads.test.ts`: “Public board read stays within its bound as T grows”                                                                                                                                                                                                                                   |
| Subject thread page                       | Bounded subject-thread index page and candidate disclosure.                                                                                                                                                                                                                                                                                                                                                                                                             | Linear rows in fixed page size; constant statements and logarithmic blocks.                                                                                                                                                                                                                                                                                                                        | `test/content/growth-subject-threads.test.ts`: “subject thread page stays within its bound as the subject thread index grows”                                                                                                                                                                                                  |
| Subject thread index projection           | Write one subject-thread index entry per thread event.                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks as other threads grow.                                                                                                                                                                                                                                                                                                                                | `test/content/subject-thread-index.test.ts`: “indexing one thread has constant rows and statements and logarithmic blocks as other threads grow”                                                                                                                                                                               |
| Author erasure request                    | Admission snapshot, provenance and operation row; command and workflow binding.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/erasure-initiation-provenance.test.ts`: “initiation keeps its wire, admission and one-attempt cost; the growth check holds at three scales”                                                                                                                                                                      |
| Author erasure binding/status             | Point-read/write workflow identity and operation status.                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-lifecycle.test.ts`: “Author erasure binding and status stays within its bound as P grows”                                                                                                                                                                                                                 |
| Native author erasure                     | Fixed posts/revisions/media page and operation/initiator reads; count only page revision identities.                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements per page; linear rows in affected k revisions; logarithmic blocks.                                                                                                                                                                                                                                                                                                        | `test/content/erasure-workflow.test.ts`: “native content erasure pages”; “affected erasure revisions”; “native logical author page”                                                                                                                                                                                            |
| Author post deletion/restore/cleanup      | One tombstone command; clear revisions in bounded pages, only affected keys. Delete and restore each raise one security revision and emit one event; restore reclaims one review slot without enumerating revisions. Cleanup starts after the restore window or an immediate moderation/account purge.                                                                                                                                                                  | Constant rows/statements per command/page; linear in affected revisions across pages.                                                                                                                                                                                                                                                                                                              | `test/content/author-post-delete.test.ts`: “delete is one bounded tombstone and cleanup runs in bounded pages as posts and revisions grow” `test/content/post-soft-deletion.test.ts`: “post delete and restore stay bounded”, scales [64, 256, 1024].                                                                          |
| Thread/post takedown                      | Read/write target/security revision and bounded projection; command event.                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/moderation-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                |
| Report storage                            | Insert one report and its event through the report-home command.                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks in report and command history.                                                                                                                                                                                                                                                                                                                        | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report read and target listing            | Exact report read; target-index keyset page and selected report rows, bounded by the fixed page limit.                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements for a point read; linear rows in page limit for listing; logarithmic blocks in indexed history.                                                                                                                                                                                                                                                                           | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report inspection HTTP admission          | Authenticate and read the target partition, Access grant and report state for each inspection request.                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements; logarithmic blocks in grant and report history.                                                                                                                                                                                                                                                                                                                          | `test/content/reports-http.test.ts`: “checkGrowth proves constant report HTTP work with unrelated and hot-partition growth at three scales”                                                                                                                                                                                    |
| Report effect projection                  | Read one committed report source reference and run one target-partition reverse-index command.                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements per report event; logarithmic blocks in source and target histories.                                                                                                                                                                                                                                                                                                      | Missing: no native projection growth check covers source and target history.                                                                                                                                                                                                                                                   |
| Thread/post reaction slot                 | Actor-target slot read/update and command; post targets add bounded ancestry. Current check measures thread set at 64/512/4096.                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements, logarithmic blocks for measured set branch; known defect, owner fix pending for clear/post branches.                                                                                                                                                                                                                                                                     | `test/content/growth-reactions.test.ts`: “Reaction slot”                                                                                                                                                                                                                                                                       |
| Subject reaction slot                     | Global `reaction:set` key probe and actor-subject slot read/update; current slot check measures set only.                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in Global grants for set; clear bound pending.                                                                                                                                                                                                                                                                                                        | `test/content/growth-reactions.test.ts`: “Subject reaction slot”; `test/content/subject-reaction-standing.test.ts`: “a subject reaction's Global standing probe stays within its bound as Global grants to other accounts grow”                                                                                                |
| Reaction count aggregation                | Apply fixed event changes to totals and relay projections.                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements for fixed changes; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                    | `test/content/reaction-projection.test.ts`: “aggregation cost is O(changes) as reactions and targets grow”                                                                                                                                                                                                                     |
| Reaction count read                       | `reaction-projection.readReactionCounts` reads <= 7 totals/target; page <= 7L rows per partition for L targets.                                                                                                                                                                                                                                                                                                                                                         | Linear rows in fixed L; constant statements per partition, independent of contributors.                                                                                                                                                                                                                                                                                                            | `test/content/subject-reactions-http.test.ts`: “subject reaction read”                                                                                                                                                                                                                                                         |
| Report outcome                            | Per page, at most 100 reports by an index range on `report_target`, with one notice each. Dismiss is one report row, one authorization check and one notice.                                                                                                                                                                                                                                                                                                            | Amortized one resolution per report.                                                                                                                                                                                                                                                                                                                                                               | Reports per target at scales [64, 256, 1024], with constant rows per page.                                                                                                                                                                                                                                                     |
| Subject reaction count batch              | One statement/target partition for <= 100 IDs; <= 5 totals/ID.                                                                                                                                                                                                                                                                                                                                                                                                          | O(n) rows, n <= 100; constant statements per partition, independent of reactors.                                                                                                                                                                                                                                                                                                                   | `test/content/subject-reactions-http.test.ts`: “batched subject reaction counts”                                                                                                                                                                                                                                               |
| Subject own reaction read                 | Subject visibility/redirect/Access then caller-home slot read; no reactor scan.                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements at fixed target; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                      | `test/content/subject-reactions-http.test.ts`: “subject own reaction read”                                                                                                                                                                                                                                                     |
| Liked version write                       | Reaction statement: at most two actor primary-key upserts of `content.reaction_liked_version` for eligible changes; otherwise only the trigger predicate.                                                                                                                                                                                                                                                                                                               | Constant rows; statements unchanged (trigger work is inside the write); logarithmic blocks in versions per partition.                                                                                                                                                                                                                                                                              | `test/content/growth-reactions.test.ts`: “Subject reaction slot”, at 64, 512 and 4096, unchanged.                                                                                                                                                                                                                              |
| Liked version read                        | One primary-key read in the actor's partition, joined in page and membership statements.                                                                                                                                                                                                                                                                                                                                                                                | Constant rows and one statement; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                               | `test/content/liked-read.test.ts`: raw primitive check at 0, 1,000 and 10,000 other reactions.                                                                                                                                                                                                                                 |
| Subject reaction merge                    | Process one page of source slots and update target slots/count events.                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements per fixed page; linear in changed slots across pages.                                                                                                                                                                                                                                                                                                                     | `test/content/subject-reaction-merge.test.ts`: “one merge page”                                                                                                                                                                                                                                                                |
| Realm board listing                       | Keyset-read boards and native Realm/member/grant disclosure.                                                                                                                                                                                                                                                                                                                                                                                                            | Linear rows in fixed limit; constant statements and logarithmic blocks.                                                                                                                                                                                                                                                                                                                            | `test/content/realm-boards.test.ts`: “Realm board keyset listing stays bounded as other Realms add boards”                                                                                                                                                                                                                     |
| Protected Realm thread read               | Resolve membership/access and disclose bounded thread ancestry.                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements for fixed ancestry; logarithmic blocks in grant/member/board history.                                                                                                                                                                                                                                                                                                     | `test/content/realm-boards.test.ts`: “Protected Realm member thread read”                                                                                                                                                                                                                                                      |
| Global board creation                     | Read Concept type, read authority and Global anchor; insert the board, grants and command state in the Concept partition.                                                                                                                                                                                                                                                                                                                                               | O(1) statements and rows, independent of boards, Concepts and threads.                                                                                                                                                                                                                                                                                                                             | `test/content/global-board-create-http.test.ts`: “a governance account creates published and protected Global boards over HTTP and authors post reviews and discussions on them”                                                                                                                                               |
| Realm board point read                    | Resolve one board by its Realm/concept keys.                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant rows/statements; logarithmic blocks in board history.                                                                                                                                                                                                                                                                                                                                     | Missing: no native growth check covers this point read.                                                                                                                                                                                                                                                                        |
| Media reserve                             | Validate bounded ancestry; read/write reservation/object keys, Access and command.                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media reserve stays within its bound as u grows”                                                                                                                                                                                                                                         |
| Media complete                            | Read reservation and write completion state for one upload.                                                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media complete stays within its bound as u grows”                                                                                                                                                                                                                                        |
| Media reservation/state reads             | Exact reservation/state/fence key probes.                                                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Media reservation and state reads stays within its bound as u grows”                                                                                                                                                                                                                     |
| Post media claim                          | Read bounded post/revision ancestry and claim one media object.                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows/statements; logarithmic blocks in revision history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Post media claim stays within its bound as r grows”                                                                                                                                                                                                                                      |
| Image publication                         | Read bounded job/object state and publish at most twelve variants.                                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements for fixed input; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Image publication stays within its bound as u grows”                                                                                                                                                                                                                                     |
| Imported image processing                 | Read source fence then checkout selected media; publish bounded variants.                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in uploader history.                                                                                                                                                                                                                                                                                                                                  | `test/content/growth-media.test.ts`: “Imported image processing stays within its bound as u grows”                                                                                                                                                                                                                             |
| Imported document append/read             | Append/read exact imported-field key with bounded metadata.                                                                                                                                                                                                                                                                                                                                                                                                             | Constant rows/statements; logarithmic blocks in partition history.                                                                                                                                                                                                                                                                                                                                 | `test/content/growth-lifecycle.test.ts`: “Imported document append and read stays within its bound as P grows”                                                                                                                                                                                                                 |
| Source fence check                        | Read fixed source-fence keys for requested page.                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media.test.ts`: “Source fence check stays within its bound as P grows”                                                                                                                                                                                                                                    |
| Source fence takedown                     | Update one fence and emit one command event.                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-lifecycle.test.ts`: “Source fence takedown stays within its bound as T grows”                                                                                                                                                                                                                             |
| Media takedown                            | Read/update selected moderation state by exact keys.                                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements; logarithmic blocks in media history.                                                                                                                                                                                                                                                                                                                                     | `test/content/media-moderation.test.ts`: “checkGrowth with actual formula across three informative scales and no content sequential scan”                                                                                                                                                                                      |
| Standalone media erasure                  | Tombstone selected media and emit media-erased event.                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                                      | `test/content/growth-media-erase.test.ts`: “Erase media stays within its bound as M grows”                                                                                                                                                                                                                                     |
| Media download decision                   | Validate exact original/variant and recheck current post/container chain and board.                                                                                                                                                                                                                                                                                                                                                                                     | Constant rows/statements for bounded ancestry; logarithmic blocks.                                                                                                                                                                                                                                                                                                                                 | `test/content/media-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                     |
| Committed media purge                     | Read partition/media keys, delete only committed erased prefix; R2 listing/key quotas apply.                                                                                                                                                                                                                                                                                                                                                                            | Constant SQL rows/statements; logarithmic blocks; R2 <= 10,000 pages and 100,000 keys.                                                                                                                                                                                                                                                                                                             | `test/content/growth-lifecycle.test.ts`: “Committed media purge stays within its bound as T grows”                                                                                                                                                                                                                             |
| Sitemap board/thread feeds                | One E preparation per HTTP page; keyset boards and bounded newest-first thread probes, with each probe's board and Realm candidate snapshot plus set-based final disclosure; L <= 1000 and 200 thread candidates/probe.                                                                                                                                                                                                                                                 | Per probe: 14 + E statements outside a Realm, 18 + E on a public Realm board, or 20 + E on a non-public Realm board for the opening board seek and final disclosure; later probes reuse the page's E preparation. E <= 6 per [Accounts read-decision bound](../access/README.md#read-decisions). Rows O(L log N); blocks logarithmic in indexed relations.                                         | `test/content/growth-sitemap.test.ts`: “${feed} sitemap page stays within its bound as listed items grow”                                                                                                                                                                                                                      |
| Durable content work                      | Enqueue/status and registered steps; collection check includes actual Delta linearity.                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements for fixed payload/page; linear only in changed collection objects.                                                                                                                                                                                                                                                                                                        | `test/content/work.test.ts`: “checkGrowth proves bounded real collection SQL with same-partition distractors at three scales”                                                                                                                                                                                                  |
| Source fence HTTP routes                  | Validate two independent roots, tuple-home snapshot and final authentication.                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements for fixed ancestry; logarithmic blocks in same-source partition rows.                                                                                                                                                                                                                                                                                                     | `test/content/source-fence-http.test.ts`: “checkGrowth keeps actual HTTP authorization and exact tuple cost bounded amid same-source partition rows”                                                                                                                                                                           |
| Deleted post purge                        | One deletion-time index range selects <=100 unfinished expired posts, then existing revision-index pages of <=100 with exact post fences. Completion excludes the post from the selection index.                                                                                                                                                                                                                                                                        | Constant statements/rows per selection and revision page; total work linear in deleted posts and their revisions.                                                                                                                                                                                                                                                                                  | `test/content/post-soft-deletion.test.ts`: `deleted post purge selection stays bounded`, scales 64, 256, 1024.                                                                                                                                                                                                                 |

### Realm Concept board creation

- Touches: native participation, Realm read and `board:create` proofs; current Realm scheme/head; Semantic's
  current Global Concept scheme reference; then the native parent authorization, board insert, resource-role
  initialization, command receipt/basis/outbox and existing result disclosure. Preparation releases each source
  home before the next owner and before the new-board transaction. Parent validation reuses the native Realm
  participation eligibility and repeats Realm read/participation formulas on its own checkout.
- Bound: constant rows and statements for the admitted 32-entry membership slot, logarithmic index blocks in
  unrelated catalogue/history/relations, plus existing Access bounds. The fixed ceiling is the minimum of the
  request and already prepared creation/source/target/Realm/participation evidence, without TTL renewal. It is
  checked again on transaction authorization and finalization. Mapping and type proof grant no permission;
  refusal produces no new board, grants, receipt, write basis or outbox event.
- Growth check: `test/content/board-read-growth.test.ts`: “Concept board creation stays within its bound as boards grow” measures the route wrapper with native Access. Semantic's current-term subject read is a keyed `current_term_fact` lateral, so unrelated board, Realm and grant history cannot expand that probe. `test/semantic/growth-concept-scheme-reference.test.ts` captures the real native caller at
  `[64,512,4096]`, including native Access and result bytes with a one-connection pool. Compact, expanded imported
  and absent membership retain fixed output while unrelated catalogue and known Concept histories/relations grow.
  `test/content/realm-board-create-native.test.ts` covers real Auth/Realm grants, retained projection lag,
  replay/conflict, selected membership, concealment, fence/retraction, redirect, source/Realm revocation,
  changed parent scheme and fixed evidence expiry. Global's independent bounded branch remains covered by
  `test/content/global-board-create-http.test.ts`.

Content setup writes one installation marker and one Global `reaction:set` grant once. The Global grant growth
check uses scales [256, 1024, 4096] with the series rule.

### Hot board page

- **Touches:** One board point read, at most 200 candidates and bounded thread/board/Realm disclosure; at most 100 results.
- **Growth check:** `test/content/board-hot-http.test.ts`: “the hot page stays within its bound as boards and threads grow”.

### Board pins

#### Pin and unpin

- **Touches:** One board row lock, one target and at most five current pin rows; at most six projection writes and
  one counter update, plus the existing command receipt, Access and registered event envelope.
- **Bound:** Constant rows/statements; indexed board and slot probes grow logarithmically. No thread enumeration,
  rank refresh or history reconstruction. True no-ops leave the pin counter unchanged.
- **Growth check:** Structural fixed-key/slot bound; focused capacity/concurrency outcomes in
  `test/content/board-pin-http.test.ts`. Broader growth verification is deferred.

#### Initial section and ordinary continuation

- **Touches:** One indexed range of at most five pins in the candidate snapshot; one board revision point read there
  and another in a released final board/Realm snapshot. Initial pages disclose at most five pin candidates;
  continuations disclose none. Ordinary work retains its fixed 200-candidate, two-round limit and exact sort key.
- **Bound:** Constant rows/statements beyond existing disclosure/Access costs, logarithmic indexed probes; no
  pinned-content cache, unlimited refill or other index. Cursors carry one encrypted key and authenticate one counter.
- **Growth check:** Structural fixed-window bound; focused sparse continuation beyond 200 raw rows and four-sort
  traversal in `test/content/board-pin-http.test.ts`. Broader growth verification is deferred.

Decision: Mount the combined reader at `GET /v1/boards/{id}/page`; accept `new`, `active` and `hot` while binding continuation to the existing native sort, viewer and pin revision.

### Cost: mounted Board opening envelope

- Touches: The mounted factory runs two `readRealmBoard` observations and two `listBoardOpeningThreads` passes
  to bracket author, media and action hydration with current Board and thread equality. Each page pass reads at most
  21 raw ordinary candidates, selects/discloses at most 20 ordinary threads and, only on an initial request, selects
  and discloses the existing five-pin cohort. Each ordinary pass also reads its pin revision and repeats the native
  final parent observation. The action reader prepares current Access evidence once, batches `thread:create` for one
  Board and `post:create`/`reaction:set` for at most 25 threads, and checks current Realm participation once. Two
  public author batches read at most 50 deduplicated identities grouped by account route. Two existing media
  media projection passes cover at most 800 deduplicated opening-post media keys each in batches of 32; each selected key
  retains the helper's current parent, Realm and final derivative authorization. Reaction totals use the existing
  one-seek-per-target-partition projection; signed-in viewer reactions add one batch in the viewer's home. The page
  reports comments as unavailable because `conversation-activity.ts` has no proven current coverage for this read.
- Bound: A single request observes at most 42 raw candidates across its two validation passes, hydrates at most 40
  ordinary candidates and 10 initial pins, and never refills a sparse page. Existing page passes retain their own
  bounded Access preparation, partition fence, BEGIN/COMMIT or rollback controls, source-cursor validation, chain
  reads, citation checks and native dispatch retries. Account, media and reaction calls use their existing pools,
  home grouping, deadlines and runner work; this wrapper adds no cross-partition join or shared transaction. One
  opening post admits up to `MAX_DOCUMENT_BYTES` (2 MiB) and 32 media references, title limits remain 1,024
  characters, and published rules are limited to 64 KiB; JSON escaping and repeated copies mean these source caps
  are not themselves a response-byte or retained-memory cap. The aggregate byte, statement, control and runner
  bounds still need the native capture below; no fitted cap is asserted.
- Growth check: Deferred to controller acceptance. Exercise initial and continuation pages at 256/1024/4096 unrelated
  Board, pin/history, thread/review, Realm/Space, account/authority, reaction and target/reference rows; separately
  grow unrelated author/media and membership/ban history. Capture each participating pool and runner phase for
  populated, empty, withheld, stale and retry paths and preserve strict physical-plan refusal.

### Mention notices

- **Touches:** One thread-route first-revision body read (at most 2 MiB), one independent board point read, and, for up to ten recipients, one preference check, one current Access read check and one notice row.
- **Bound:** Constant source rows and statements plus a bounded board point and bounded thread/board/Realm read checks per recipient; logarithmic blocks in their indexed histories.
- **Growth check:** `test/content/growth-mention-notices.test.ts`; mention nodes per post at scales [16, 64, 256], with at most ten notices and constant database rows beyond ten. `test/content/mention-notices.test.ts` proves native first-publication delivery when board and thread routes differ.

### Cost: notification inbox projection

- Touches: One recipient index range of C = 4 × limit <= 200 notice rows, one frontier lookup and up to C exact acknowledgement probes. D distinct source targets are grouped by native partition and chunks of 100. Each chunk runs two current witness passes; each pass reads up to 33 body-free post-header batches, one thread header batch, one board header batch and one Realm header batch. Author decisions use three exact decision/target snapshots each. Reporter outcomes use two report-reference snapshots, two reporter account:read proofs and at most one post-to-thread locator. Current actor labels use two Accounts identity batches per routed partition and up to two profile point reads per listed actor for avatars and stability checks. The viewer's active account/session check runs before and after hydration.
- Bound: With D post/thread refs, G board refs, M decisions, R reporter outcomes and B = Σ ceil(D_partition / 100) + Σ ceil(G_partition / 100), at most 2B × 38 source/header/partition statements, 72D + 4G target-header rows, 3M decision/target reads and 5R report/account reads plus one locator per post report. Full-body and revision reads are zero. Access authority work is bounded by these keys and uses the shared Access Cost A. Actor rows, statements and profile bytes are bounded by 2 × limit <= 100. Inbox, acknowledgement and seen-frontier work examines at most C notice keys plus one frontier row; indexed blocks grow logarithmically.
- Growth check: `test/content/growth-notice-inbox.test.ts` covers 256/1024/4096 unrelated Inbox rows, a current independently routed post and the 201-row summary truncation probe. `test/content/notice-inbox-http.test.ts` covers exact target withholding, retry cursor behavior and current actor/context output.

### Cost: current-visible unread summary

- Touches: One unread recipient index range of at most 201 rows, including the exact acknowledgement lookup and bulk frontier predicate, followed by the same source, target and current disclosure checks as the list. Actor profile hydration is not needed for counts.
- Bound: At most 200 raw candidates are disclosed; the extra row only establishes truncation. The result counts at most 100 disclosed notices. A complete range with at most 100 visible notices is exact; otherwise `capped` declares the result a lower bound. Rows, source proofs, Access work and bytes are independent of older Inbox rows and post body size.
- Growth check: `test/content/growth-notice-inbox.test.ts` holds the unread result fixed while growing unrelated rows at 256/1024/4096 and exercises exact, 100-capped and incomplete-coverage results. `test/content/notice-inbox-http.test.ts` proves hidden raw rows do not inflate the visible summary.

### Cost: exact one-notice acknowledgement

- Touches: Current `account:read` and account-state/fence check before every attempt; one exact recipient-owned notice point locked `FOR SHARE` and one `notice_ack` primary-key insert with `ON CONFLICT DO NOTHING`; notice retention cascades the acknowledgement.
- Bound: Fixed route admission, one Access authorization and account-state point, then two statements in one recipient-route transaction, one notice row and at most one acknowledgement row; replay or a concurrent acknowledgement changes no other notice and does not touch `notice_seen`.
- Growth check: `test/content/notice-inbox-http.test.ts` replays concurrent exact acknowledgements and verifies that only the selected item becomes read while the bulk frontier remains absent.

### Cost: bulk seen frontier

- Touches: Current `account:read` and account-state/fence check before every attempt; one exact recipient-owned notice point locked `FOR SHARE` and one `notice_seen` upsert that copies the immutable `(created_at, notice_id)` tuple.
- Bound: Fixed route admission, one Access authorization and account-state point, then two statements in one recipient-route transaction, one notice row and at most one frontier row; tuple comparison keeps concurrent and replayed marks monotonic.
- Growth check: `test/content/notice-inbox-http.test.ts` covers concurrent marks, older retries, delayed delivery and retention of the precise frontier.

Derivations use the implemented adapters and SQL in `db/content/migrations/` and `db/content/schema.sql`. At fixed admitted input, unique-key B-tree probes examine constant rows and use O(log N) shared blocks; changing k indexed rows uses O(k log N) blocks. Rows include filtered candidates; blocks include bounded body access but exclude dead tuples, vacuum debt and lock waits. `C` is the command envelope (receipt/partition/outbox and bounded write-basis inserts), adding constant rows/statements and logarithmic blocks. `A` is an authenticated Access check, derived in [Access Cost](../access/README.md#cost). Transactions, settings, catalogue checks and time reads add fixed statement constants. Body and metadata byte caps bound read/write bytes.

Limits: board candidates <= 200, collection <= 100, public pages <= 100 results with at most 200 hydrated candidates. Post/revision candidate helpers cap s at 200 and fetch s + 1 identities. Reply validation checks at most 32 parent posts; edit at most 33. Rank refresh locks <= 500 candidates. Sitemap pages cap L at 1000. Media input is <= 20 MiB / 40 million decoded pixels, with at most twelve variants. Reaction slot growth scales are [64, 512, 4096]. The `subject-reactions-http` “subject reaction read” capture covers `reaction-projection.readReactionCounts`.

### Author item index

- Touches: guarded upsert or delete per event; erasure reads the post and thread anchor and writes one command event.
- Bound: constant rows and statements; logarithmic blocks in index history.
- Growth check: `test/content/author-item-index.test.ts`.

### Reply notices

- Touches: per post, at most two parent or thread primary-key reads and, per recipient, one `notificationAllowed`,
  one complete post read check (including board, Realm and bounded ancestors), and one notice row.
- Bound: constant rows and statements per post at fixed reply depth; logarithmic blocks in thread history.
- Growth check: `test/content/growth-reply-notices.test.ts`, posts per thread at scales [64, 256, 1024], with
  constant rows per post.

### Appeals

- **Touches:** Appeal reads one decision and inserts one appeal row. Resolve updates one appeal row and checks target authorization, plus `liftTakedown`'s bound and one notice. Pending lists follow the report list bound: at most L + 1 queue candidates and L independently authorized source reads, with L <= 100. The existing appeal read returns the decision statement, target and decider identity internally; list projection exposes only the statement and target, and derives `canResolve` from that same current target authorization plus the independent-review comparison. Board candidates are projected from committed events on the board route; a resolution permanently removes the candidate from its pending index.
- **Bound:** Constant rows and statements per appeal and resolution; O(L) rows and statements per list, independent of appeals per board.
- **Growth check:** `test/content/appeals-http.test.ts`, `appeals per board`, at 64, 256 and 1024 appeals; rows per call stay constant.

## Realm discovery source

`createThread` records original public discussion starts in the thread home. Qualification belongs to that
command's authoritative T: published discussion/thread/opening, published Realm board, active explicitly public
Realm epoch and independently anonymous-readable active host Space. Board, Realm and Space checks release their
connections before the next home. Drafts, reviews, replies, edits, publication, membership and Global or protected
boards supply no contribution. Existing threads are never backfilled. Canonical documents, references, grants and
parent creation retain their native command behavior.

`realm_discovery_contribution` stores only exact source identities, original epoch, UTC creation day, current state
and a bigint source version. The closed internal `com.rezics.content.realm-discovery.changed.v1` event commits with
the source command in its native outbox. It carries no body or actor identity. Native opening-post deletion/erasure
and thread/opening takedown retract an originally qualified start once; replies do not retract it. Native page erasure
uses the same exact source module. Source versions advance on actual state changes, independently of receipt replay.

Community's consumer contract is `readDiscoverySource` followed by `prepareDiscoverySourceApply` from
`discovery.ts`: release the source read before the aggregate command, compare immutable binding, and apply the
absolute source state only above the consumer's stored version. A delayed positive delta reads a newer negative
source fact rather than resurrecting it. The native envelope supplies causality and deduplication; this preparation
is not a fence acknowledgement or permission to disclose a rank.

The outer native command boundary in `discovery-mutation.ts` commits preparation using the exact requested
actor/action/receipt intent before entering any source mutation. The opaque intent hashes the native identity,
command kind/key/digest and exact source; the journal stores no actor, credentials or submitted body. Preparation
checks the original command's completion only after current authorization, so an authorized replay adds no fence.
Each generation binds the native security revision, contribution version and original Realm epoch. Board takedown
binds the current same-home Realm epoch and emits an exact board-version fact, never scans its threads.

`prepareDiscoveryMutation` releases source preparation before `commitDiscoveryFence` enters Realm home, then
separately commits the exact fence acknowledgement in source home. The actual point, author page, restoration or
appeal command still authorizes at its fresh T before its original receipt lookup and preserves the synchronous
response/receipt. `lockDiscoveryMutation` checks READY, exact generation and both native/source versions in that
original source transaction. `applyDiscoveryMutation` verifies the actual native version change, applies the source
delta and records APPLIED with the executor's transaction binding atomically. No callback may assert success.
Appeal reviewer independence runs in both preparation and effect; `liftTakedown` stays inside the appeal transaction
and refuses counted targets without that outer lock. Author pages restore their existing initiator in both commands,
retain the exact page/step receipt identity and the maximum of 100 posts. Physical cleanup is unchanged.

Restoration checks the independently anonymous-readable active Space, explicit-public active Realm and original
epoch again at the actual command T, plus the published board and current available/published thread/opening.
Only originally qualified contributions can regain a positive state. Epochs never change on the contribution itself.
Protected creation, a protected interval, removed containers and delayed positive deltas cannot upgrade old input.

The registered native effect verifies the real outbox envelope and reads the committed operation/source outcome,
then assigns absolute versioned state in Realm home and resolves only that exact fence. Terminal fence tombstones
prevent delayed preparation from reopening it. A failed source executor is resolved by a locked ABORTED CAS before
its fence can clear; an APPLIED winner projects its actual outcome. The same source lock prohibits any late effect
once abortion wins. The existing collection step recovers at most 50 terminal unprojected keys per partition step; it never
infers abortion from time, missing process, unavailable evidence or an exception alone. A crash leaving an unknown
live generation stays pending until a native attempt resolves it. A new authorized retry uses a new generation after
ABORTED; old cleanup cannot erase its fence. No new workflow API, scheduler, queue or erasure coordinator is added.

Community's exported `readRealmDiscoveryGate` returns the exact current epoch/generation and whether it is settled.
Later aggregate disclosure must match that generation after bounded bucket application, check current board state,
Realm/host eligibility and final disclosure again. `realm_discovery_source` and `realm_discovery_board` contain
versioned native facts, not public counts. No aggregate or endpoint is exposed by this source delivery.

Cost: qualifying creation retains one exact board/Realm/Space neighborhood and one source INSERT/outbox delta.
A source change adds one source preparation, one exact Realm fence, one source acknowledgement, the original source
effect and terminal projection/acknowledgement, each a separate bounded native command. Source/receipt/fence reads
are exact indexed keys. A board change touches one board fact; the later bucket consumer must use at most 31 day
keys per board, durable bounded pages for multiple boards, and O(changes log R) rank updates. Erasure pages retain
100 posts and one opening contribution; recovery reads at most 50 terminal keys per partition step. There is no thread,
membership, revision-history or descendant scan, cross-home SQL join or held cross-home transaction.

The Community producer also exports `RealmDiscoveryChangeValue`, `RealmDiscoveryCommittedChange`,
`RealmDiscoveryChangePage` and `readRealmDiscoveryChanges` from `community/discovery-source.ts`. This is a bounded
committed Realm-home log, not a callback for consumer-supplied records. Every changed mirror fact and exact gate
resolution commits with consecutive Realm generations and the actual executor transaction id. Native source
versions remain separate from these generations. `projectDiscoveryMutation` and `recoverDiscoveryMutations`
retain their original source-owned outcome/recovery contract; aggregate callers never acknowledge or abort them.
See the [Community owner contract](../community/README.md#public-realm-discussion-discovery) for the exact reader,
predecessor, lifecycle binding and consumer obligations. Source qualification and synchronous mutation responses
are unchanged.

## Community presentation

`community-presentation-model.ts` exports `CommunityPresentation` and its closed runtime schema, composed into
`BoardView.community`. Only a genuinely Global board whose native `realmId` is null has null community.
Realm/Space dependency failure fails disclosure, rather than manufacturing a Global board or another container.
Board title/purpose remain separate from current Realm title/summary; `description` preserves even an empty summary.
The current native Realm and Space heads, lifecycle versions, active state, read authority and placement epochs are checked before
and at final disclosure. The native `contextId` remains independent of Global identity and editorial grants.

`readCommunityPresentations({pool, access, clock?}, realmIds, {actor, deadline})` accepts at most 100 distinct
routed Realm identities and returns a map of currently readable verified presentations. It batches full keys by
row kind in one REPEATABLE READ snapshot per round. Realm board lists retain their existing candidate window,
deduplicate container/rules references and enrich the response once. No client per-card HTTP, cross-partition
SQL join, page refill or retry scan is introduced. The native internal BoardRecord remains independent of
presentation, so ordinary exact post reads never recursively enrich their container.

`readExactPublishedRules({pool, access, clock?}, refs, {actor, deadline})` is the native exact rules dependency;
each reference is `{realmId, postId, revisionId}`. It batches native post/ancestor/thread/board/Realm/revision keys,
uses the same Content row admissibility and Access decision formula as ordinary reads, and requires the selected
post to remain published and its ancestors to remain ordinarily readable. It verifies the exact native revision belongs to that post
and a board of the specified Realm, plus current parent disclosure and matching before/final source signatures
and epochs. Text-profile canonical bytes are bounded to 65,536; native document parsing, SPDX and digest validation
remain authoritative. Missing, concealed or erased sources produce no rules; a dependency error produces unavailable.
No caller can supply a successful authorization flag, and no authored body is stored in Realm or Semantic JSON.

`RealmPresentationOptional<T>` and `RealmPresentationImage` belong to `realm-media.ts`. Unset images are `none`.
The installed `readRealmPresentationImages` reads at most two exact media keys per distinct Realm after releasing
other source snapshots; repeated boards share that result within the existing limit of 100 Realms. It owns current
media authorization and source/final checks; the outer final round still verifies Realm/Space binding and lifecycle.
Concealed or erased images are `none`, and native dependency failures are `unavailable` without cached facts. Available
images may contain only actual derivative facts (at most twelve variants), actual largest derivative dimensions,
and stored optional placeholder/focal-point/credit, with absent metadata null. They never carry original URLs,
storage keys or account identity. Summaries never authorize downloads: the existing media id/variant transport
must check current container and media fences, including conditional requests. No successful media claim is stubbed.

`members` consumes Accounts' original `community/member-count.ts` export
`readRealmMemberCount(client: AccessClient, {realmId, at: AuthoritativeTime})` returning
`Promise<Readonly<{count:number, version:string}>|null>`. The installed producer owns native source version,
removal coverage and bounded initialization; Content owns no count, version, control row or transition engine.
Until that producer lands, its declaration throws unavailable. Null or source failure maps only to
`{state:'unknown', count:null, version:null}`. A native positive result maps exactly to
`{state:'current', count, version}`, including a genuinely proven zero. The reader calls the native fixed-point
helper once per distinct readable Realm in each existing round, using that snapshot's actual `AuthoritativeTime`.
It releases other source homes before the final Realm snapshot. Final source loss or a changed count/version
withholds members as unknown without retry or refill; privacy, lifecycle, source binding and epochs must still
pass independently. No membership COUNT, roles, follows, visitors, fabricated zero or cached total is substituted.
`join.membership` reads the actual current self interval; its action also needs
the native `realm:join` admission used by join/leave. Public anonymous readers receive sign-in, protected self-join
is absent, and owners or viewer actions are never treated as membership. A 202 workflow remains pending until its
native interval settles. All membership, permission and source evidence is refreshed at final disclosure.

### Cost: community presentation read

- Touches: distinct full Realm/Space keys, current self memberships and protected bans; fixed source/final
  placement/head anchors and native Access batches; one native member-count point helper and at most one exact
  rules pin per distinct Realm per round; at most two selected media keys per distinct Realm.
- Bound: O(changes log R), at most 100 returned boards and their deduplicated containers/rules, two fixed
  source rounds, at most 33 post keys per rules chain, 65,536 canonical bytes per rules document and at most
  twelve actual derivative facts per image. Existing list candidate bounds remain; no count scan or history walk.
- Growth check: later reuse `test/community/growth-realm.test.ts`, `test/content/growth-threads.test.ts` and
  the existing media growth harness. Native, physical, visual, cleanup, main and root
  proof remain outstanding; focused cases and a compiler pass do not claim these outcomes.

## Fixed authored paid editions

A native `content.edition` is a pointer to exactly one authored post revision in the source post's route. It stores
creator, target subject, thread/post/revision, canonical SHA256 and immutable SPDX licence; it stores no body, file or URL.
`POST /v1/contentEditions` accepts only `{ postId, revisionId, targetSubjectId }`, requires current `post:revise` and the actual
post and revision writer, and returns 201 `{ editionId, editionRevision }`. The revision writer is checked by its
exact native `editorial.write_basis` transaction, without a history scan. Missing original provenance refuses enrollment.
The target must already belong to that exact immutable revision's `subject_ids` and be currently readable through
native `subject:read`. A different current head cannot add an association to the selected revision. Publication pins
that original subject in the immutable source digest; missing, hidden or redirected subjects refuse sale and delivery.
Creation makes a draft and initializes the narrow `content.edition.owner` role atomically through parent creation.
The role adds only `edition:read`, `edition:sell`, and `edition:unpublish` on that edition.

`POST /v1/contentEditions/{id}:publish` accepts `{}`, requires `Idempotency-Key`, quoted `If-Match: "1"`, current
`edition:sell` AND source `post:revise`, and the same actual native author. Publication is a separate native command
after owner grants exist. Its immutable operation records the real admitted actor, scopes, floor/operator and
original delegation, source digest, executor transaction and exact receipt locator/digest. The receipt commits the
entire allowlisted durable initiator record. Content's concrete `readEditionInitiator` independently verifies that
operation, exact source, native write basis and original receipt; missing/collected or replaced evidence cannot
restore a publisher. A draft is never sellable or byte deliverable. A new version requires a new edition ID.
`POST /v1/contentEditions/{id}:unpublish` accepts `{}` with current revision `If-Match`, requires the current creator
and native owner action, and is terminal. Both commands return `{ editionId, editionRevision }`; unpublication does
not issue refunds. Receipt replay repeats fresh native admission and source guards before receipt lookup.

`GET /v1/contentEditions/{id}` returns exactly `{ editionId, editionRevision, state, targetSubjectId,
creatorAccountId, revisionId, sha256, licence }` under current `edition:read`. State is `draft`, `published` or
`withdrawn`. Draft metadata additionally requires the creator's ordinary source read.
`GET /v1/contentEditions/{id}/revision` returns exactly `{ editionId, revisionId, sha256, licence, body }`, where body is the
canonical native DocumentSnapshot. Buying or granting `edition:read` never grants ordinary `post:read`.
Both reads use private, no-store responses; conditional headers never skip authorization or return an unchecked 304.
Unknown, removed and hidden resources return 404; ordinary native refusals and retryable infrastructure errors retain
their normal problem semantics.

### Returning to authored editions

`readCreatorEditions({ pool, access, clock? }, actor, { accountId, cursor?, limit? }, { deadline })` returns
`CreatorEditionPage = Readonly<{ editions: readonly ContentEditionView[]; next: string | null }>`, importing the
actual edition model. `GET /v1/accounts/{accountId}/editions` exposes that exact page under the installed
`edition:read` action with private, no-store responses. Only an authenticated actor for that same account can list;
another account receives 404, including when it could read an individual published edition.

The native default worker's `content_creator_edition` effect consumes the existing committed creation event.
It validates the exact outbox slot and original account write basis against the immutable edition creation
transaction, releases the original home, and inserts only `(creator account, edition ID)` in the creator home.
Duplicate delivery has no effect. The existing creation and publication commands, identity attribution, owner grants,
immutable bindings and sole native body remain unchanged. A closed native content erasure fence refuses late
candidate enrollment; this locator is not a new erasure participant or acknowledgement proof.

The primary key supports ascending immutable edition-ID keysets. Each request examines at most `min(limit, 20)`
candidates (default 20), with no refill or lookahead row. A full candidate page has a continuation even if every
candidate was hidden; a final full page can require one empty continuation. Shared authenticated encrypted list
cursors bind account, viewer, effective page size, home epoch and the last examined ID, expire after 15 minutes,
and conceal skipped IDs. A dedicated HMAC-derived key uses the existing pool-bound native receipt key ring, so
the producer interface needs no new signing configuration and does not reuse receipt MACs.

Candidates confer no authority. Each candidate is read through the owning metadata reader before and at final
disclosure, with the creator's ordinary source read required for published editions as well. Current source,
subject, seller/creator identity, ancestry and installed edition metadata grants decide the exact DTO. Refused or
missing resources are skipped; retryable source/partition/Access failures propagate and never become an empty
success. Drafts and withdrawn editions follow that same native metadata authority. Inventory does not require or
claim Commerce sale eligibility, entitlement, delivery, ownership count or body access. There is no historical
backfill or completeness claim: pre-index editions require a separately supported bounded original-row enrollment,
never a request-time table scan. Web owns the consuming creator page.

`readContentEditionSaleAuthority({ pool, access, clock? }, editionId, context)` returns only an active current
publication. The server-only `readContentEditionMechanicalSaleAuthority({ pool, access, clock? }, editionId,
{ deadline })` uses that same private native verifier for fresh Commerce capture/fulfilment eligibility without a buyer
actor or workflow ReadContext. It returns only the same closed native identifiers, creator and licence; it grants no
delivery or cleanup authority and has no HTTP route, fact issuance, grant or write side effect. The normal caller
entry retains its actual actor's subject and parent checks. Every sale/fulfilment independently restores its original
publisher for `edition:sell` and `post:revise`
at the same live native read T, before target checkout. Each action uses its own restored identity and current
formula; neither identity grants anything to the request's buyer. The publisher also independently restores each
subject, board, Realm, Space, thread and source/ancestor post read at that same T and fixed deadline. Each exact
authority anchor validates its own native row before checkout of the edition home. Action evidence is never reused
for another action; the real buyer still passes its own independent read checks. Current consent comes from the
mounted Auth reader or the standard Auth consent configuration. Absent configuration is typed unavailability. Current seller grants,
native author/source/licence/binding and original receipt are checked again before returning authority or bytes.
One fixed deadline bounds all restorations and final evidence to at most 1,000 ms. Reads mint T on a released
bounded connection and release it in finally; commands use only the executor's T.

The buyer independently passes the ordinary board, thread, every ancestor post, Realm and Space reads and native
lifecycle checks. Only the explicitly enrolled protected source post's own read grant can be supplied by the edition.
Draft, takedown, erased/removed source or ancestry, pending account-erasure fence and missing source bytes refuse
delivery before preparation and at final disclosure. Source erasure immediately disables edition reads. The existing
[post cleanup](erased-post-cleanup.ts) nulls those same revision bytes; the edition has no surviving copy.

The canonical benefit type is re-exported from `access/authenticated-benefit.ts`. Kernel composition mounts
Commerce's `createContentEditionBuyerFactReader` on `AccessConfig.contentEditionBuyerFactReader`; Commerce never
calls Content recursively. The Access owner's opaque issuer and formula integration and Commerce's native current
entitlement reader are installed; the reader issues a fact only after releasing its buyer-home checkout. Native owner/direct
grants still use the ordinary formula. No Content permission evaluator is added.

| Operation                                     | Touches                                                                                                                                                                                                                                  | Bound                                                                                                                                                                                                                   | Growth check                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edition draft creation                        | Exact post/revision/write basis and selected subject association, released native subject and board/Realm/Space/account homes, ordinary ancestry, one edition INSERT and native owner grant initialization                               | One fixed source and subject; at most 33 posts; body at most 2 MiB; O(H log N) plus existing Access bounds                                                                                                              | None: focused native outcomes in `test/content/edition.test.ts`; no growth claim in this delivery                                                                            |
| Edition publish/unpublish                     | Exact edition/source/subject, ordinary source/ancestry Access, one CAS; publication adds one immutable operation and receipt commitment                                                                                                  | One source, subject and operation; at most 512 recorded scopes; no history scan                                                                                                                                         | None: focused native outcomes in `test/content/edition.test.ts`; fixed indexed keys                                                                                          |
| Edition metadata                              | Exact edition/source and released subject existence/read checks before and final, ordinary current parent guards and edition Access                                                                                                      | One pinned subject; at most 33 posts and one board/Realm/Space; no bytes or source URLs                                                                                                                                 | None: focused native outcomes in `test/content/edition.test.ts`; no growth run requested                                                                                     |
| Creator edition candidate projection          | One native outbox envelope (at most 1,000 slots), immutable edition and original write basis in one released source snapshot; one creator-home fence and idempotent candidate insert                                                     | Constant bounded envelope and indexed point keys; one candidate per creation event; O(log N) per home; no cross-home write inside creation                                                                              | Focused native outcomes in `test/content/edition-index.test.ts`; no growth claim                                                                                             |
| Creator edition inventory                     | One creator-home primary-key range; at most two owning metadata reads per examined candidate, each releasing all checkouts                                                                                                               | At most min(limit,20) examined keys, no refill; O(log N + L × H log N) plus native Access bounds, L ≤ 20 and H ≤ 33 posts per metadata read; no body DTO, count or history scan                                         | Focused native denial, continuation, race and unavailability outcomes in `test/content/edition-index.test.ts`; no growth run requested                                       |
| Edition sale/mechanical eligibility/byte read | Independent native publisher restorations per action and resource, exact receipt/operation/source, current subject and parent guards, final native checks; authenticated delivery separately checks the buyer edition grant and ancestry | At most 40 restorations for two sale actions, subject, board, Realm, Space, thread and at most 33 posts; shared 1,000 ms deadline; one exact revision at most 2 MiB; no history/entitlement enumeration or copied bytes | None: focused native outcomes in `test/content/edition.test.ts` and `test/content/edition-mechanical.test.ts`; producer integration and runtime verification remain separate |

## Board slow mode

Decision: all opening/reply creation (including drafts) and revisions count; only a current explicit
`moderation:takedown` capability on that board exempts the actual actor, never a role label or authorship.
Decision: existing board-scoped actor HMAC rows transfer their latest timestamp on first use; untouched legacy hashes expire under the seven-day retention sweep.

`PUT /v1/boards/{id}/slowMode` requires that moderator capability, bearer and idempotency key, and the closed
body `{ intervalSeconds }` (integer 0–86400; zero disables). It returns the committed setting and the additive
Web policy fields with `canChange` and `exempt` true for its authorized moderator. Replaying the
same key returns its original result without resetting any author's timer. Current account, scope and board
state pass the existing command pipeline on every attempt, including receipt replay.
`GET /v1/boards/{id}/slowMode` requires ordinary current board/Realm disclosure before and after reading.
It returns `{ intervalSeconds, retryAt, nextEligibleAt, canChange, exempt, admissionState, retryAfterSeconds }`.
`nextEligibleAt` and `canChange` preserve the delivered Web policy names; the other fields are additive. The retry
timestamp describes only the actual actor. A pending reservation returns a one-second retry hint until recovery
decides it. No response exposes the posting identity or another account's state.
An early ordinary write returns HTTP 429 `board_slow_mode`, `effect_status=not_applied`, the current
`intervalSeconds`, stable UTC `retryAt` and `Retry-After`. Changing the interval applies it to the last
successful ordinary admission; disabling does not clear that timestamp. Exempt writes do not advance it. A
temporarily unresolved command returns retryable 503 with `effect_status=not_applied`; it is never treated as a
successful admission.

Each posting attempt first runs current authorization and exact receipt lookup. A replay returns its original result
before admission. For a new command, Content reserves a monotonic, command-bound permit on the board home, prepares
one ticket on the target thread home, and releases both checkouts before the thread transaction starts. The
explicit moderator decision uses that command attempt's authoritative T. The thread transaction changes only its
own partition: it writes the thread/post/revision and commits the ticket witness atomically. Finalization reads
that committed revision witness and advances the board actor timestamp only for a committed post. A rollback
cancels the permit without moving the interval. Concurrent work for one board actor is serialized; unresolved
work blocks with explicit retryable unavailability until the registered recovery worker fences the target ticket.
Changing an interval advances the security episode, retiring stale preparations. A live post fence prevents an
interval change from overtaking its commit. No foreign checkout is held with the thread transaction and no
application lock is introduced.

Receipts remain the replay authority. If transport fails after commit, a retry of the same authorized immutable
command returns the one stored post; it does not issue a new post. Recovery uses the ticket and the exact revision's
`recorded_transaction_id`, never a new command. The posting journey has no separate Web writer, and service
proposals cannot opt out of native admission. Draft creation, first publication, replies and ordinary revisions
all enter this same boundary.
Imports have no native thread/post creation authority: imported authored-field proposals are a separate service
operation, not ordinary board posts. Service authority cannot be selected by caller input or a skip flag;
any future service posting must explicitly enter this same native admission boundary. Edition publication uses
an already published/protected native source and never inserts or publishes a board post. It cannot evade the
source's creation/revision admission, nor does it charge the same source a second time.

The permit keeps only the keyed actor, command digest/key, home routes, generation, interval episode and terminal
state. It stores no body, account ID or idempotency key. The actor HMAC is secret-keyed and is never returned.
Account erasure removes its current keyed rows in pages of 25 after fencing pending work. Older board-scoped HMACs
cannot be associated with an account after migration; they contain no identifier and age out within seven days.

### Cost: posting admission preparation

- Touches: one preflight authorization/receipt lookup, one fixed board Access explicit check, one board serializable
  reservation, one target-home ticket transaction and one board activation transaction. The legacy hash handoff
  adds at most one actor point read/update/delete. The normal command then uses its existing target-home Access,
  receipt and write path.
- Bound: at most 20 slow-protocol statements over three sequential checkouts, plus the existing bounded Access
  evidence/formula and command executor work; at most one selected actor, one permit and one ticket. The legacy
  handoff may inspect two actor keys. No thread, account, permit-history or board enumeration; indexed blocks are
  logarithmic in unrelated rows. Permit metadata and ticket payloads are fixed-size and contain no body bytes.
- Growth check: controller native acceptance must hold selected board/actor/command fixed and independently grow
  unrelated actors, threads and permit/receipt history at 256, 1024 and 4096, capturing Access and every pool;
  verify strict physical-prefix plans for empty, denied, stale and replay branches.

### Cost: post transaction and finalization

- Touches: the existing single-thread authorization, revision/post writes and command receipt/outbox, plus one
  local ticket update in the same thread-home transaction. Finalization reads that ticket/revision witness, then
  locks and updates one board mode, actor and permit row on a separate board checkout.
- Bound: one target ticket row and one target revision witness; at most six finalization statements after one
  witness query. Thread/post/revision rows remain confined to the command partition. Total query rows are constant
  at fixed command and Access evidence; unrelated board actors, threads, receipts and permits affect indexed blocks
  logarithmically only.
- Growth check: controller native acceptance must capture post and board pools separately at all three scales,
  including successful, rolled-back and uncertain-commit outcomes; no failed outcome may advance `posted_at`.

### Cost: board slow-mode status

- Touches: the route's existing before/after board and Realm disclosure, one mode point read, one actor-key point
  read across current and legacy hashes, one pending-permit existence probe, and the existing explicit Access check.
- Bound: two Content statements and one fixed-size result, in addition to the existing bounded disclosure and
  Access work. At most two actor rows and one boolean pending result are examined; no identity or history scan.
  Retry timestamps and the response body are constant-size.
- Growth check: controller native acceptance must keep the selected board and actor fixed while unrelated actors,
  threads and command history grow at 256, 1024 and 4096; include ready, interval, pending, anonymous and exempt reads.

### Cost: setting changes

- Touches: existing `moderation:takedown` resource authorization and one board setting point read/upsert in the
  board command transaction; a changed interval increments one security episode.
- Bound: one selected board row and at most two setting statements, independent of threads, actors and permit
  history. A live in-flight post returns retryable unavailability before changing the setting.
- Growth check: controller native acceptance must grow unrelated board actors, thread homes and permits while
  keeping the selected setting fixed; verify stale reserved preparations cannot activate after an interval change.

### Cost: permit recovery

- Touches: one recovery-index page (at most 25), one permit point read and fence per candidate, one target-home
  ticket/revision witness transaction, and one board finalization or safe cancellation transaction. Checkouts are
  released between homes; a busy target is restored to pending for a later scheduled pass.
- Bound: at most 25 candidates per call and no more than 25 target and 25 board row groups; all pages and SQL
  results are fixed-size. Work is O(page size × indexed point checks), with logarithmic index blocks as unrelated
  permits, threads and revisions grow. An unfenced or ambiguous ticket is never discarded.
- Growth check: controller native acceptance must capture the registered worker at all three scales, including
  empty, denied, stale, committed-witness, rollback and locked-target branches.

### Cost: account erasure and retention

- Touches: one actor-key indexed permit page, sequential recovery/finalization for pending items, one actor-key
  existence probe, one actor page and one mode-fenced delete per selected row. Retention selects a fixed page of
  terminal permits and actors, then deletes each target ticket and board permit in separate checkouts.
- Bound: page size is 25; one invocation examines at most 25 permits and 25 actor rows and deletes at most 25
  tickets/permits. The existing worker caps each scheduled run at 16 pages. No cross-home joins, unbounded sweep or
  unbounded transaction; unrelated rows affect indexed blocks logarithmically.
- Growth check: controller native acceptance must hold selected account/board/command fixed while unrelated actor,
  thread and retained-history rows grow at 256, 1024 and 4096; assert pages, statements, rows, bytes and all pools.

Focused outcomes are in `test/content/board-slow.test.ts` and
`test/content/board-slow-partition.test.ts`. Worker schedule registration is covered in
`test/content/register.test.ts`.

## Realm Subject structural census

`realm-subject-source.ts:createRealmSubjectSource` owns the population port and its types.
Search adapts its planned port to these exports (prefix/match accept 32 inputs). The separate
`RealmSubjectDisclosure` owns Realm read/ban, reader binding, original/terminal identity,
thread, opening, board and place checks. `RealmSubjectMaintenance` owns live cut coverage
and currentness, including dependencies added by each page. Match resolves original inputs
to their independently readable terminal through disclosure. Without both capabilities,
structural completion remains unavailable.
Decision: retain unresolved originals with null terminals; never assume a self mapping.

`createRealmSubjectCandidates` is the single live writer/coverage seam. Maintenance fences a
thread with its native epoch/position, then reconciles its exact thread keyset and writes
individual current candidates or tombstones under that fence. Old writes lose; baseline is
insert-only and loses to any live fence, including removal before census. `initialize`
installs an empty Realm generation without claiming coverage. Identity repair and
erasure use the same seam. Maintenance reclaims tombstones only after its replay floor permits;
rows and pending handoffs contain structural locators, never author, text or grant data.

`createRealmSubjectCensus` captures an immutable upper thread key and native cut per source
route (all 65,536 routes, including empty routes). Durable thread/opening snapshots and original
ordinals export one reference per step and survive crashes. Both kinds use current opening
references; reviews retain their exact original target. A cut is not a historical snapshot:
later reads can supersede it, while live fences defeat delayed baseline writes. Maintenance
must cover every captured route, subsequent writes, identity dependencies and foreign repairs.
No census-completion flag or empty eligible page can establish population readiness.

Prefix/match inspect at most 32 raw candidates per call. Prefix retains the complete ordered
terminal/original/thread frontier and deduplicates terminal Subjects across continuations.
Sparse rejected rows advance that frontier; withheld/unknown disclosure refuses enumeration.
Match preserves input positions and returns unknown on raw-budget exhaustion, withheld on
incomplete disclosure, and not_published only with complete current readable coverage.
Each call uses the caller's additive ScopeWork root. Native rows and SQL are charged before
disclosure; capabilities declare per-invocation WorkDimensions maxima and charge actual work
to the same root. Prefix adds at most 32 candidate evaluations, two disclosure current checks
and two maintenance current checks; match additionally adds at most 32 Subject checks.
Structural maxima: 34 home checkouts for match, three for prefix, five statements/checkout,
32 candidate rows plus two fixed rows/checkout, 4 KiB/candidate plus 1 KiB/checkout. Census
steps use one source keyset of one thread, two opening/revision points, one board point,
one native Semantic identity mapping and one candidate write; revisions hold at most 128
originals. Each write updates one exact key under a Realm generation lock and a shared native home lock. Homes are
released before another home or disclosure work. Generation/revision/native home epoch, Realm/place, reader
and disclosure dependencies are rechecked after pages; changes refuse the page. Deadlines
and exact LeafOptions reach both capabilities; bigint positions and epochs remain lossless.
Production lifecycle registration belongs to live maintenance.

## Realm Subject live lifecycle and ancestor observations

`realm-subject-lifecycle.ts` is the Content producer for the existing candidate writer and census. The default Content
effect validates each original CloudEvent against its registered schema, exact outbox slot and receipt, then releases
the source home before reading the committed opening thread, first post, head revision and board. Revision events
also prove that the revision row was recorded by the receipt transaction. Event `subjectIds` and the
`subject_thread` projection are never membership evidence. Opening revisions for discussions and reviews are read
from their native rows; replies do not contribute opening links.

The effect fences the exact thread with its source partition epoch and position, writes the current opening links
through `createRealmSubjectCandidates`, and marks removed links inactive. The writer makes duplicate events
idempotent, ignores an event older than the thread fence and rejects a delayed census baseline after any live write.
Post and thread takedown, restoration and post restoration reread the exact current native target before changing
candidate state. The existing default worker owns delivery and keeps a source event open until this effect and its
durable handoff succeed.

Captured-cut work runs on the Content maintenance queue. The minute schedule advances at most 16 route pages per
invocation, with at most 32 census steps per route page; its singleton route cursor and each census route's cut,
generation, keyset and ordinal survive retries. Identity changes enqueue one durable keyed repair and continue in
32-candidate pages. A page that has not finished, has an unavailable mapping, or loses its native home leaves
maintenance unavailable. A scope event is only an invalidation wake and never advances census coverage.

`realm-subject-scope.ts` observes the exact current Realm and Space rows plus monotone invalidation generations. Realm
revision/lifecycle and Space revision/lifecycle are re-read on every observation. Board creation or board takedown
advances the owning Realm's board-set generation, invalidating observations that include either discussion or review
threads without descendant candidate fanout. Realm and Space lifecycle or revision events advance their own
generations. Reader bans and grants remain current disclosure checks and cause no population-wide fanout.

Decision: ancestor scope changes advance a monotone Realm/Space/board-set generation; they do not fan out through descendant candidate rows.

Production worker composition is live: `registerContent` mounts the effect, and Content work registers the identity
continuation workflow and bounded census schedule. `createRealmSubjectLifecycle` exposes the maintenance and scope
capabilities consumed by `createRealmSubjectSource`. The current `realm-subject-disclosure.ts` exports only its
prepared evaluator, not the source adapter required by `RealmSubjectDisclosure`; inject that delivered adapter when
it lands. Until then `createRealmSubjectSource` remains unavailable/preparing and this lifecycle cannot claim a
ready population. The factory and disclosure owners remain the sole owners of their writer and reader contracts.

### Lifecycle operation bounds

#### Live source event

- **Touches:** one indexed outbox event and receipt, one current opening/revision read, one board point, at most 100
  identity mappings per released batch, one fence and at most 256 indexed candidate writes (128 current plus 128
  previous subject IDs).
- **Bound:** subject arrays are schema-capped at 128; each identity read is capped at 100; each candidate update uses
  its exact Realm/original/thread key. No per-event Realm, board or Subject scan is performed.
- **Growth check:** `test/content/realm-subject-lifecycle.test.ts` covers default-worker delivery, revision withdrawal,
  stale replay and native takedown/restoration.

#### Identity continuation

- **Touches:** one indexed original-ID candidate page, one exact mapping batch, up to 32 fences and candidate updates,
  and one cursor update.
- **Bound:** fixed 32-row keyset pages; each durable workflow completes one page and hands the next key to a new
  workflow identity. Sparse and duplicate pages are safe to replay.
- **Growth check:** `test/content/realm-subject-lifecycle.test.ts` covers duplicate and late source delivery; the
  census/disclosure owner tests retain their independent storage bounds.

#### Captured census continuation

- **Touches:** one route cut/cursor, at most 32 exact thread-keyset steps, and at most 32 original candidate writes.
- **Bound:** the schedule commits at most 16 route pages per invocation and the next route is durable. Empty routes
  advance one route at a time; filtered pages do not imply global completion.
- **Growth check:** `test/content/realm-subject-lifecycle.test.ts` crosses a captured cut with a live thread event and
  verifies that the live row survives census completion.

#### Ancestor scope observation

- **Touches:** one Realm point, one Space point, two indexed generation reads; invalidation performs one exact event
  insert and one generation upsert.
- **Bound:** constant point/page work per observation or invalidation, independent of descendant thread count. Each
  generation changes only once for a repeated event key.
- **Growth check:** `test/content/realm-subject-lifecycle.test.ts` observes a board-set reduction invalidate the same
  Realm cut containing discussion and review witnesses.

## Native board watches and private management

Decision: board watch PUT sets an explicit `watching` boolean with `expectedRevision`; management requires
`kind=thread|board`, and an unavailable row retains only its personal removal identity and subscription metadata.
Private watch methods refuse an operator acting as a different account, even with a cursor from that account.
Native watch receipts and private change events enroll their account owner in shared history erasure; the permanent
command-kind assignments are `content.board.watch=8` and `content.watch.remove=9`.
`board_activity` is independent of `thread_watch`, optional, default-on, in-app only, without historical backfill.
Decision: opening fanout uses 20 recipients per durable page, matching the native Inbox's default presentation page.

| Consumer             | Native method and mounted operation                                                                                       | Result                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Web board control    | `readBoardWatchState`; `GET /v1/boards/{id}/watch`                                                                        | `{watching,revision}`, with current board disclosure                                          |
| Web board control    | `setBoardWatch`; `PUT /v1/boards/{id}/watch`, `{watching,expectedRevision}`, `Idempotency-Key`                            | Confirmed state/revision; 409 for stale revision; exact retry reauthorizes before its receipt |
| Performance Settings | `listWatches`; `GET /v1/accounts/{accountId}/watches?kind=thread\|board&limit=&cursor=`                                   | `{items,next}`, limit 1–20/default 20, oldest first in one selected actor-home range          |
| Performance Settings | `removeWatch`; `DELETE /v1/accounts/{accountId}/watches/{id}?kind=thread\|board`, `{expectedRevision}`, `Idempotency-Key` | `{removed:true}`, including an already absent own identity, without resource read access      |
| Performance Inbox    | Existing `notifications.list` with `board_activity`                                                                       | Existing post/thread target identifiers and current native post disclosure                    |

Web board controls and Performance Settings watch management remain unavailable consumer adapters; these methods
are their Content interfaces. Thread watch GET/PUT/DELETE and reply delivery keep their existing shapes and storage.
A thread management row has revision 1 for its unique edge. Board state retains a CAS tombstone; rewatch rotates its
identity and creation cutoff. Neither kind uses common Following. Listing/removal sends no notice.

Available rows contain `{id,kind,revision,createdAt,state:'available',resourceId,title}`. Denied and absent resources
both return `{id,kind,revision,createdAt,state:'unavailable'}`. They contain no title, author, place, owner, destination
or denial reason; the opaque personal `id` permits self-removal after a ban. Concurrent removal skips the row and
advances its raw key. Sparse or empty pages can continue; there is no request refill. Encrypted cursors bind viewer,
selection, page size, client, operator, authentication epoch and actor-home partition generation, retaining database
microsecond keys. Native self-account authority precedes cursor parsing and new receipt lookups.

`registerContent` mounts `content_board_watch_notice` through `contentNoticeEffects` with the default worker's native
Access. It checks the exact original publication partition/epoch/position/event identity in the outbox and current
first post, thread and publication revision. Delayed first publication counts. Historical imports, ordinary revisions
and restores do not emit this original publication. A source refusal commits completed work so restoration cannot
reopen it. Candidate timestamps retain database precision. Range checkouts end before recipient Access. Current
source/board/thread/Realm/place eligibility precedes the delivered preference/finalization path, which additionally
locks the live personal edge and suppresses an already sent reply/mention/thread notice from that source. All optional
finalizers serialize on the same recipient/source advisory transaction key, and thread finalizers also check for an
existing board notice; either worker order produces at most one notice. Refusals
remain final across preference changes. Actor-home and inverse fanout indexes belong to the same original row and
change atomically, so no asynchronous inverse can recreate an unwatched edge. Erasure includes board tombstones;
retention includes board source progress.
The finalizer's current native account point also fences suspension/authentication fencing committed after the
released source Access checks. This is independent of the optional preference; required moderation remains on its
existing mandatory path.

### Cost: board state and self-removal

- Touches: shared current account authority, current board disclosure for read/set-true, an actor-home PK state read,
  at most one row mutation, and the native `runCommand` envelope for writes. False set and removal omit board reads.
- Bound: read is `Q_self + Q_board + Q_point`; set is `Q_self + Q_board + C + 2*Q_point`; removal is
  `Q_self + C + 2*Q_point`. Each domain point is one statement and at most one original row. `C` includes the actual
  shared authorization, time, transaction controls, partition, receipt, outbox, history account guards/locators and write basis. Retry reauthorizes,
  reads its receipt and skips the body. No-op/retry has nonzero cost. Each mutation maintains a fixed set of indexes.
- Growth check: `board-watch-growth.test.ts` runs the real mounted read and same-key set retry at 256/1024/4096
  subscriptions alongside both management selections and durable delivery. Each native operation owns a separate
  bounded capture at all three scales, on a fresh instance of the same connected fixture; their costs remain
  additive. This preserves the harness's fixed telemetry ceiling without dropping native plan evidence.

### Cost: selected management page

- Touches: shared `account:read`, one generation point, one actor-home range of B≤100 raw candidates, existing
  `readThread`/`readBoard` disclosure per examined candidate, and one exact own-edge presence recheck per candidate.
- Bound: `Q_self + Q_partition + Q_range(B) + B*(Q_native_disclosure + Q_point)`. The range is one data statement
  and at most 100 physical subscription rows; presence is one statement/one row. P≤20 outputs are retained. Native
  source, board, Realm/place and presentation dependencies and their transaction controls remain additive, including
  unavailable results. Memory is O(B+P+D); D includes the existing 33-post ancestry ceiling and Access's finite
  membership preparation (at most 1,000 memberships per identity, two identities). No all-partition query is used.
- Growth check: the native growth journey grows both actor-home ranges, verifies physical rows/statements/blocks,
  rejects large sequential scans, and reads both explicit selections with available and unavailable rows. Connected
  outcome tests cover cursor refusal, current denial and exact self-removal.

### Cost: native command envelope used above

- Touches: `runCommand` → `boundedRead`/`mintTime`, `resourceAuthorization.prepare`, the process-local command
  gate, `read-receipt.sql`, the owning body, `guardHistoryAccounts`, `fence.sql` or `no-effect-fence.sql`, and
  `recordCommandHistory`/`record.sql`. The watch authority anchor's validation callback performs zero SQL;
  shared Access preparation and its actual permission formula remain charged. No resource Access runs while the
  command checkout is held. The native process gate performs no SQL and admits at most 64 waiting requests.
- Bound: per successful attempt, excluding the separately charged domain body and shared Access, data statements
  are `3 + 2*A + (1+E)`: one time mint, one receipt lookup, one commit fence, two seal statements for each distinct
  history account A≤64, and one history insert per receipt/event artifact (E≤1). History seal statements seek/upsert
  exactly A keys and read exactly A phase points; the history inserts write at most `(1+E)*A` locator rows. The
  mutating fence reads/updates one partition and writes one event, one write-basis row and one receipt; no-effect
  instead reads one partition and writes one receipt. Receipt lookup seeks only the native retained key-version
  candidates R, not a principal's historical receipts (the version codec is one byte, R≤256). The owning body adds
  one subscription point plus at most one mutation, maintaining its fixed indexes. A matched receipt skips the
  body, history guards, commit fence and locator writes, but retains time mint, shared authorization and lookup.
  The current native executor emits BEGIN twice, three SET LOCAL controls and COMMIT for a successful write,
  in addition to the time mint's BEGIN/SET LOCAL/COMMIT; replay omits the final SET LOCAL. Charge failed attempts'
  controls/ROLLBACK and all their dispatched reads too. Native contention retries multiply the per-attempt work
  by their actual count under the original request deadline; this journey introduces no new retries or deadline.
  Memory adds O(A+R) to the shared Access dependency budget D.
- Growth check: the native journey includes first-time same-state commands, exact receipt retries and removal of
  unavailable entries for both selections; statement/control and physical costs include this real executor rather
  than an injected command port or a fitted allowance.

### Cost: board-opening page

- Touches: `readOpening` runs one partition point and one exact envelope/thread/post/revision query. Its native
  envelope has at most `MAX_COMMAND_EVENTS=1000` events. `loadPage` runs BEGIN, partition fence, work INSERT, work lock,
  B≤20 recipient range and COMMIT. Advancing runs BEGIN, partition fence, progress UPDATE and COMMIT.
- Bound: fixed work is eight data statements and four transaction controls, one bounded original-envelope range,
  three original source points, three load progress/fence points, two advance/fence points and B recipient rows.
  Per recipient add the exact source query/partition point, `postReadableByAccount`, and the delivered finalizer.
  Finalization uses BEGIN/COMMIT and at most nine data statements: partition fence, recipient/source advisory lock, previous decision, terminal
  account, account/preferences join, active edge, three-kind notice overlap, decision INSERT and notice INSERT.
  Those statements touch at most eleven original rows; duplicates, unavailable and suppressed recipients retain all
  dispatched work. Native post disclosure expands to four released snapshots (each BEGIN/COMMIT plus partition),
  two chains (thread, at most H=33 posts, selected revision), two board points, and at most H+4 native
  `accountStandingCheck` invocations (board twice, thread, posts, optional Realm). Each post point joins its current
  revision and optional moderation decision; thread/board/revision points are unique-key reads. Shared Access's
  dependencies and query/control statements remain charged through those original callees.
  Thus each step is `Q_fixed + B*(Q_subscription + Q_current_authority + Q_delivery) + D*Q_dependency`, with the
  fixed/load/advance, raw candidate/active point, exact source/native disclosure and remaining finalization expansions
  above. No suppressed path is charged zero or assigned a fitted allowance. Memory is O(B+D), with one fixed
  30-second deadline per page. Persisted exact raw keys keep progress monotone across unavailable/removed rows.
  A withdrawn source closes an existing work row with one additional point UPDATE in the load transaction and
  skips its recipient range and advance transaction; restoration cannot resume the old partially processed opening.
- Growth check: the same journey executes two native pages per fresh original publication at 256/1024/4096 with
  unchanged B/P/D, positive, preference-suppressed, self-suppressed and missing recipients. It captures physical
  rows/blocks/statements/bytes and transaction controls, rejects large watch-table sequential scans and checks sparse
  durable progress. Connected tests replay the default registered effect and preserve refusal after preference reset.

### Cost: board erasure and retention

- Touches: the durable account erasure's final stage selects/deletes at most 50 board rows including tombstones.
  Compatibility cleanup and source retention share the existing 1000-row total budget with other notice work.
- Bound: one data statement plus the existing BEGIN, partition fence and COMMIT; at most 50 selected and 50 deleted
  original rows with fixed index maintenance. Retention has the same shape at its remaining finite budget. Deleting
  the original row atomically removes the inverse index. Each finite page releases its checkout before continuing.
- Growth check: the same three-scale native journey erases 50 original board rows, including tombstones, per
  measured step using the actual erasure participant's page method. Connected outcomes exhaust cleanup and replay
  prior publication after removal. Integration verification retains the broader account-lifecycle acceptance.

## Private acknowledged drafts

`listOwnDrafts(deps: ContentReadDependencies, accountId, context: ReadContext, input?: OwnDraftInput)`
returns `OwnDraftPage`. `resumeOwnDraft(deps, accountId, threadId, postId, context)` returns the ordinary
anchored native post. `OwnDraftEntry`, `OwnDraftActions` and `OwnDraftInput` are exported from
`own-drafts.ts`; `OwnDraftQuerySchema`, `OwnDraftEntrySchema` and `OwnDraftResponseSchema` are exported
from `schemas.ts`. These are installed in the Kernel route type as `own_drafts.list` and
`own_drafts.resume`, not a new document or producer port.

`GET /v1/accounts/:accountId/drafts?limit=20&cursor=...` returns
`{state, viewer: {accountId, authnEpoch}, drafts, next}`. Each entry identifies the exact native thread,
opening post and current selected post/revision, discussion/review kind and opening/reply document kind,
bounded title, board title/Realm identity, save time, root document language, licence, Subject/media references,
and actual resume/edit/publish/erase paths. Lists read no document bodies. Public author lists still omit drafts.
The acting account must equal the selected account home, including organizations; native account Access retains
current session, scopes, standing and acting-organization consent. No arbitrary editor may list another account.

Decision: private draft pages use creation order, report preparing while source locators are pending, conceal
unreadable Subject context, and reserve document bytes for exact selection. Reply entries omit the thread title
rather than reintroducing retained opening text after deletion. The owning author-item locator has a dedicated
partial draft prefix, so published items, erased history and unrelated author items do not consume its raw budget.
The mixed-direction complete key is creation time descending, post identity ascending; two disjoint seeks share
a single raw budget of at most 20. Withheld or stale rows consume slots without refill. A sparse or empty page
may have `next`; clients follow it until null. A page failure returns the ordinary problem, never an empty list
or a cursor beyond the failed frontier. The opaque encrypted cursor binds home, limit, actual actor, client,
delegating principal, scopes, authentication epoch and home partition epoch.

`state: preparing` means locator coverage is incomplete. The page may already contain usable acknowledged
entries; an empty preparing page must not be rendered as no saved drafts. The source post's pending marker is
written with each revision and cleared only after receiving locator commit for the exact head. A partial
source-author pending prefix prevents delayed delivery from producing a false complete empty page even after
the historical census completes. Missing progress is unavailable. The default Content supervisor registers
`content.ownDrafts.repair` on maintenance every minute, with at most sixteen raw-20 source pages per invocation.
Repair checkpoints advance only after every receiving locator and source acknowledgement completes. Source
failures leave the same frontier retryable; account retirement uses the existing fence and late authored cleanup.
Repair reads native source primary keys and opens each source/author home separately. It does not retain bodies.

`GET /v1/accounts/:accountId/drafts/:id?threadId=...` returns `{post}` and an ETag containing its revision.
It checks private account, native ancestry/board/Realm/Space and original Subject authority before the ordinary
native body read, and repeats account and Subject admission before returning bytes. Concealed/unknown selections
both return 404. There is no new retained-private-data exception. Bodies, SHA, node languages, media claims and
Subject references remain native. Root language in the locator is accepted only when its exact revision matches.
Nested language marks remain in the selected document. Both routes use `private, no-store`.

Resume/edit/publish/erase are navigation and current permission hints; commands independently authorize every
attempt before receipts. Save uses `POST /v1/posts/:id/revisions`, `If-Match: "revisionId"` and the native
idempotency key. To publish, deliberately submit `visibility: published` through that same command. A 412 leaves
the acknowledged server head available for explicit reload/recovery; it never overwrites the other device.
An uncertain write retries the exact body, key and If-Match. Own erase uses the existing DELETE post command.
Current source disclosure suppresses publication/erasure immediately, and locator delivery removes draft
membership without a second store or automatic publication.

Examples: a populated ready page has native entries and action paths; a complete empty page is
`{state:"ready",viewer,drafts:[],next:null}`. A withheld raw page may be empty with an opaque `next`.
An unavailable page is the ordinary 503 problem and retains the client's selection; exact retry repeats its
unconsumed cursor. Preparing is `{state:"preparing",viewer,drafts:[],next:null}` until coverage is repaired.
Web retains the page/composer consumer and its phone/desktop recovery review; this API does not install a page.

### Cost: listOwnDrafts

- Touches: two native account snapshots around one prepared account Access check; one actor-home selection
  snapshot with a partition point, two disjoint draft-index seeks, one progress point and one pending-prefix
  probe. For each of L raw candidates, two ordinary metadata disclosures, one two-action Access snapshot and
  original-Subject identity preparation plus three identity observations. Each metadata disclosure uses two
  source snapshots, two board observations and one final board recheck; its ordinary resource checks retain
  native account, ancestry, Realm/Space and ban work. All source/board/Subject/account checkouts release before
  another home opens.
- Bound: L <= 20, native ancestry H <= 33, Subjects S <= 128 and media IDs <= 32 per item. A metadata source
  chain is one thread, H post/head/decision probes and one revision probe; two chains are observed per disclosure,
  and each prepared thread/post eligibility rechecks its own exact row. Include the existing Access producers'
  permission, account, membership, Realm/Space and ban bounds for each invocation; these are not zero-cost
  callbacks. Each Subject observation uses its original partition and label/reference points and current Access,
  with no redirect substitution. Body bytes are zero throughout list disclosure. Response strings are capped at
  512 title characters, 256 root-language bytes, native SPDX/128 Subject/32 media limits and a 4096-byte cursor.
  Work is O(L * (H + S)) bounded native probes plus nested authority; no author-history residual scan.
- Growth check: native outcome coverage is `test/content/own-drafts-http.test.ts`. Independent 256/1024/4096
  published/draft/erased/revision populations, strict physical-prefix plans, all participating pools and complete
  nested Access counters remain required before claiming the numerical examined-work ceiling. Raw and selected
  byte caps stay fixed; output count alone is not work evidence. Performance review of composed terms is requested.

### Cost: resumeOwnDraft

- Touches: initial/final account snapshots, one metadata disclosure, original-Subject identity preparation and
  three identity observations, then the actual native post disclosure and its final body serialization. The
  ordinary read repeats source signatures, ancestry, board/Realm/Space, account and resource Access checks.
- Bound: one selected identity, H <= 33, S <= 128, one current revision with at most 2 MiB canonical bytes.
  Metadata disclosure reads no bytes; the selected native read loads only that exact current revision. Include
  both disclosures' nested authorization and the native body JSON parse/response serialization. Denied private
  homes stop before source selection; concealed source/Subjects stop before body loading; stale heads return 404.
  The shared native reader may perform rating-question citation disclosure after body selection.
- Growth check: focused coverage pins exact bytes/revision, account isolation and concurrency recovery.
  Independent historical growth and serialization/pool accounting remain required; no scale pass is claimed.

### Cost: repairOwnDraftPage

- Touches: one progress primary-key read and one native post ordered-prefix seek; at most 20 independently
  anchored current post/thread/revision reads, 20 receiving author commands and 20 source acknowledgement
  commands, then one conditional progress command. Fenced authors additionally use the existing late-erasure
  item registration, authored cleanup and resolution. No receiving command holds its source connection.
- Bound: raw keys <= 20 and at most sixteen pages per scheduled invocation. Each source uses exact post,
  thread and current revision keys; only draft source projection parses up to 2 MiB canonical bytes to extract
  root language. Native commands include receipt, partition, event and account-erasure fence work. An erased
  source creates no draft membership. Failed pages do not advance progress; receipts protect completed receiving
  work on retry. Maintenance never enumerates revision history or author history to fill a list page.
- Growth check: native pending/repair outcome coverage is included below. Separate three-scale repair,
  late-erasure cleanup and uncertain receiving/source retry measurement remain required with native seeding.

### Cost: readOwnDraftSource and acknowledgeOwnDraftLocator

- Touches: source projection opens one repeatable-read home, partition point and exact post/thread/head join;
  acknowledgement opens a separate source command with one guarded post update and a registered event.
- Bound: at most three source records and one current document <= 2 MiB, independent of revision history;
  one source command per delivered native state. The update requires the observed revision, so it cannot
  acknowledge a concurrent save. Live author-item delivery includes these terms in addition to its receiving
  locator command, fence, receipt and event work. Exact receipt replay still precedes no required authority:
  these are internal projection commands, never person-write substitutes.
- Growth check: the focused native journey exercises real source delivery and exact retry. Independently grow
  published history and revisions for projection/acknowledgement costs before adopting a physical-work ceiling.

## Current thread reading page

`GET /v1/threads/{id}/reading-page` composes the existing `readThread` and signed-cursor `listThreadPosts` readers.
It returns the opening plus at most 20 raw replies, excluding the opening from the reply list. The first native list
request selects 21 rows to account for the opening's list slot; each continuation selects 20 after its original
cursor. It never concatenates pages or accepts a client-selected post-ID batch. `target` carries the board's current
security revision, and each available post action reference carries the exact disclosed source revision.
The installed composer is `readContentReadingPage(dependencies, threadId, actor, deadline, cursor?)`, mounted as
operation `thread.reading_page`.

Personal data is bounded to the current actor and this page. One deduplicated Accounts summary call admits at most 21
author identities. Existing viewer-reaction and reaction-count readers receive at most 22 targets (thread, opening,
and 20 replies); the opening's post reaction remains distinct from the thread reaction. Watch state uses the native
thread-watch reader. The current board slow-mode summary is included as context; reply eligibility comes only from the
mounted parent-thread action, and the command remains authoritative for admission. Author review citation remains the
existing disclosed `readThread` value; no extra vote or provenance reader is introduced.

Action projection receives the production Kernel's complete mounted resource and binding catalogues. Parent-post
creation is evaluated on `content.thread`, matching the command anchor. Guest sign-in state comes from the mounted
route's security declaration; resource permission comes only from `readViewerActions`. Missing catalogue/security
metadata or a dependency failure makes the action component unavailable. Private reads and operation results are not
used as permission evidence.

The request URL is capped at 8 KiB; the cursor is capped at 4 KiB. Reply, identity, action-reference, and JSON bounds
are checked before identity, watch, slow-mode, and viewer-action hydration. There are at most 22 action/reaction
references and 21 unique author identities. The full JSON cap is
`21 × MAX_DOCUMENT_BYTES × 6 + 21 × 32 KiB + 256 KiB`; the six-byte factor covers JSON escaping. Preflight measures
the actual mounted operation and metadata projection and reserves 16 KiB for reaction fields within the envelope
allowance. A serialized author summary must fit 32 KiB. Native content can scan at most 200 ordered candidates per
`listThreadPosts` call; the reading
composition calls it once for the response and once for its final check. Each exact candidate disclosure retains the
existing maximum of 33 post ancestors, so sparse pages can examine up to 400 candidates and 13,200 candidate ancestry
rows across both calls, in addition to the opening/root and board checks. Reaction counts use one target seek per
target in each represented content partition (at most seven kind rows); own reactions use one viewer-home batch.
Accounts, handle claims, avatars, verified Subjects, Access preparation, mounted bindings, watch state, and slow-mode
admission retain their source owners and may span their represented homes. No table scan or unbounded identifier
fanout is added.

The initial and final thread, board, and selected cursor page must retain their native witnesses after identity and
authority hydration. A changed selected source fails with a safe retry; a concealed target remains not found. Watch
and slow-mode observations are independently rechecked and become unavailable if they changed. Component currentness
is explicit. Content, Accounts, Access, reaction totals, watch, and slow-mode observations do not share a fabricated
cross-home transaction. A continuation certifies only its newly selected page, not entries returned on earlier pages;
commands remain authoritative if a source changes after this response.

Decision: The envelope includes the existing board slow-mode summary as advisory context; only the mounted parent-thread
action represents reply eligibility, and the command remains final for admission.
