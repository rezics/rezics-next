# Owner predicates in shared filters

This document owns the approved owner-predicate wire, private fact semantics and native physical/complete-observation plan. It adopts a specification,
not runtime support. [Library and Collections](library-and-collections.md), [Dynamic Collections](dynamic-collections.md),
[profile consumers](library-profile-consumers.md) and [independent labels](library-labels.md) own their underlying
facts. [Filtered lists](filtered-lists.md) remains the sole authority for indexed execution, disclosure, freshness,
preparation and numeric budgets; [Collection source](collection-source.md) owns source integration.

Semantic owns the shared grammar producer and Collection/dynamic source contract integration. Commerce owns private
fact semantics and native owner plans. There is one shared filter protocol, with no separate Boolean interpreter,
compatibility ABI, personal query parameter, AND-only recipe query or private mirror in the public index.

## Closed additive wire

The following are the exact additive leaves beneath the existing shared `and`, `or` and `not` nodes:

```json
{ "owner": { "presence": true } }
{ "owner": { "state": { "profileId": "PROFILE", "stateSetId": "SET", "in": ["STATE"] } } }
{ "owner": { "label": { "id": "LABEL" } } }
{ "owner": { "session": { "profileId": "PROFILE", "lifecycle": "completed" } } }
{ "owner": { "holding": { "profileId": "PROFILE" } } }
```

These are independent leaf examples, not one JSON request. Uppercase identifiers are logical placeholders, not
valid instantiated wire values. Every object is closed. `owner` contains exactly one family. `presence` accepts
only `true`. State requires exactly `profileId`, `stateSetId` and `in`; `in` contains one or more distinct state IDs
within the accepted descriptor's bounds. Label requires exactly `id`. Session requires exactly `profileId` and
`lifecycle`, whose values are `active`, `completed` or `abandoned`. Holding requires `profileId` and permits only
the optional `kind` and `status` fields, each a released data identifier. Omitting both means any retained holding
accepted by that profile; no additional qualifier is required.

Profile, state-set, state, kind and status IDs use native released-data identifier validation. Label IDs use native
opaque identifier/UUID validation. The existing shared AST bounds apply, including expansion and Boolean nesting;
this document introduces no separate budget. JSON validation stays strict, with no coercion. Unknown fields,
unsupported predicates and operators remain explicit admission errors, never silently ignored successful filters.

There is no account, route, principal, client or pin selector. Release digest and accepting type are not query
fields. Session lifecycle is the fixed native session lifecycle, not a profile entry state. Profile/state/kind/status
vocabularies remain definitions data rather than new kernel enums or vertical-specific flags.

The [shared Filter entry point](../packages/filter/src/index.ts) currently re-exports
[the actual grammar implementation](../packages/filter/src/filter.ts). Its existing type leaf is
`{type:{in:[...]}}`; statement leaves use `property` with `in` or `range`, and optional same-statement qualifiers.
Those spellings, released datatype/unit rules, saved-filter expansion and catalogue unknown semantics remain intact.
The delivered `FilterDocument`/`OwnerLeaf`, `parseFilter`, `admitFilter` and `walkFilter` structurally support
owner leaves. Consumers opt into structural admission with `owner: true`; that option supplies no authentication,
authorization, private SQL or execution plan. Expand saved filters before collecting execution dependencies.

## Viewer-self binding and admission

For a caller-supplied HTTP filter, `owner` implicitly means the current authenticated request principal's own account.
Native subject/delegation rules determine that principal. It never means the Collection curator or an inferred human
behind a delegated client. Another account's facts cannot enter the lookup namespace, even if identifiers coincide.

Admission checks current authentication, the existing scopes and gates for **every** referenced private family,
and source/read/disclosure authority before private SQL. A public source may be personally filtered only by an
authenticated viewer where native owner-plan admission explicitly supports that source. An anonymous owner filter
is denied, never ignored or folded into public results. A readable public source does not itself admit owner plans.
Do not infer a new scope or denial policy from these leaves.

Native suspension fences pre-existing bearers: such a request returns HTTP `401`, a JSON Problem with code
`invalid_credentials`, and `WWW-Authenticate: Bearer error="invalid_token"`; its outcome maps to denied. Auth cannot
mint a valid suspended bearer. Do not fabricate one through SQL account or token edits. Correct-password suspended
sign-in returns `403 ACCOUNT_SUSPENDED` without creating a session; that behavior belongs to Auth. Missing, invalid
or revoked required credentials retain the existing `401` behavior, insufficient scope retains
`403 insufficient_scope`, and active-account admission remains unchanged. This reachable native contract supersedes
the hypothetical valid-suspended-bearer `403 account_suspended` wording in the linked older list documents.

Trusted built-in/publication membership production is a separate owner-authorized source context, not a caller's
account selector. Public saved output uses only its completed published membership, with current subject disclosure;
it never evaluates fresh curator-private facts for a public reader. Anonymous output and public output viewed by an
editor cannot borrow the curator's private query, pins, labels, progress or holdings.

## Exact private meanings

Predicates select unique canonical subjects within the admitted source/population. They do not automatically make
all owner predicates range over Everything. Explicit presence is how a broader source is restricted to that union.
Stored originals and accepted pins remain unchanged and editable; canonical browsing never collapses distinct
sessions, copies or curated occurrences into one fact. Current original support and terminal eligibility both matter.

### Presence

`owner.presence` is Everything's qualifying union: a live explicit non-null entry state, an effective current live
label assignment, retained nondeleted own session/history, or a retained nondeleted own holding. Any surviving
qualifying fact suffices. Clearing state removes only that state contribution; removing the last qualifying fact
removes presence. Completed and abandoned retained sessions still qualify as history.

Empty or cleared entry shells, label definitions without assignments, trash/soft-deleted snapshots, follows,
curated occurrences, catalogue facts, ratings, reactions alone and published-log snapshots alone do not qualify.
There is no independent presence flag or default state. A label-only or holding-only subject needs no fabricated entry.

### Current state

`owner.state` tests the current canonical effective state. Among merged originals, choose the highest **live**
`owner_write_seq`, then match its scoped accepted `(profileId, stateSetId, stateId)` against the requested profile,
set and `in` values. Do not choose an older matching state instead of the current winner. Archived/deleted states
never compete. Preserve conflicts and each original pin's immutable accepted meaning.

[Owner state-write order](library-and-collections.md#owner-state-write-order) owns allocation, clear, Undo, replay,
migration and bigint semantics. Digest order, timestamps and unrelated revisions cannot substitute for that order.
State clear does not invent a live tombstone and does not erase retained completed-session history.

No live entry means state is false when native evidence is complete. `NOT state X` therefore includes no-entry
subjects in the admitted source/population. It is not a test for absence of completed consumption: a cleared entry
can have a retained completed session, and a label-only subject can have no entry at all. Missing profile capability
for a new write does not reinterpret historical pins or remove historic read/clear rights.

### Label

`owner.label` requires an effective current own assignment and its current live same-owner label parent, including
the native reservation rules in [independent labels](library-labels.md). A deleted parent immediately defeats a stale
positive even while child cleanup is paused. No profile lookup or binding is required; name, current subject type
and public classification cannot stand in for the opaque label ID. A foreign label ID conveys no lookup authority.

### Session history

`owner.session` is `EXISTS` a retained, nondeleted own progress session whose native lifecycle equals the requested
value and whose stored accepting pin has the requested `profileId`. Soft-deleted snapshots do not match. Check the
session's actual stored accepting profile, not current type, current release/head, guessed historical type, entry
state, elapsed amount or a published log. Release activation/retirement does not rewrite accepted session meaning.

Any qualifying session suffices even when other sessions have different lifecycles. Alice's completed session
counts for Alice; Bob's completion never does. Clearing Alice's state leaves her completed history effective until
that native session ceases to qualify. No recipe-specific `notCooked` flag or state-to-history inference exists.

### Holding

`owner.holding` is `EXISTS` a retained, nondeleted own copy accepted by the requested profile, matching each supplied
kind/status against that copy's stored accepted data. Both qualifiers, when supplied, must match the same copy.
Copies remain independent identities, including multiple copies of one subject. A holding does not imply an entry,
session, payment, entitlement or platform; kind/status are profile data, not inferred from a purchase or current type.

## Absence, readiness and disclosure

Complete native evidence with no qualifying own fact establishes known absence. Negation of that owner predicate
can therefore match within the admitted population. Unresolved pins, partial producer coverage, missing canonical
mapping, incomplete indexes, failed dependencies or unavailable native observations are readiness, never
manufactured false or a ready empty answer. A failed stale positive does not by itself prove canonical absence.

Existing catalogue unknown stays unknown/not-proven under NOT. For example, unknown diet is not vegetarian and
does not become a proven nonvegetarian fact through negation. The extension changes no catalogue matcher semantics,
same-statement qualifier association, scalar unit meaning or compact/expanded representation conformance.

Private plan output, including preparation and continuation, is private and `no-store`. Private facts do not enter
public indexes, full text, facets, counts or public subject-membership projections. Current source authority,
Access, original and terminal eligibility, consent, foreign dependencies and tuple fences cover membership,
exclusion, order, fields, source metadata and cursor-visible information. Candidate-only checks cannot protect NOT
exclusions or ordering. Complete generations, index revisions, published identity epochs and prepared rows are not grants.

Use the shared native privacy-reduction observation and repair/acknowledgement contract before execution and again
before disclosure, including relevant excluded subjects and foreign dependencies. Missing, changed or unsafe evidence
and pending identity work relevant to the complete source/query dependencies return readiness. Owner writes appear
on the owner's next read; private preparation
cannot hide a committed change behind catalogue lag. Public fields and cursor bases do not change when curator-private
facts change without changing completed published output. Reauthorize every continuation and retain existing opaque
cursor binding/restart behavior; cursor content must not reveal private query facts or cached permission.

Admit filter, source and order together as a direct owner index or prepared owner result, composed with catalogue
plans where supported. Success fills the requested page or proves genuine final exhaustion. Otherwise return preparing
with retained bounded progress, or the existing unavailable outcome when no progress is possible. Finite ready input,
including sparse matches, must reach useful full/final output after finite preparation. Endless preparing or short/empty
success chains over raw candidate windows do not satisfy this contract. All direct, prepared, composed-page and
maintenance work is charged under [Filtered lists cost](filtered-lists.md#cost); no numeric allowances are added here.

## Scoped subject-search consumption (required; runtime pending)

[Search conditions](search-conditions.md) is the sole shared condition authority for universal mixed-kind requests;
existing `subjects:search` is its first producer. Search's README owns its native integration. Consumers use the
actual shared grammar producer as delivered, without another parser.
This section adopts Library consumer requirements only; it creates no alternative grammar, ABI or runtime.
The site's one header field uses existing `POST /v1/subjects:search`, operation `subject.search`. Its chip adds a
shared Boolean subtree to `body.filter`; `text`, `languages`, `sort`, `limit`, `cursor` and subject result DTO remain.
No personal/account parameter, per-scope endpoint, browser filtering, private public-Search mirror or second
Boolean/text interpreter is admitted. Scope, ALL owner leaves, catalogue type/tag/exact quantity and text compose
in ONE native source/filter/order admission, with complete exclusion/order and current original AND terminal privacy.
Never drop nonowner OR branches or conjoin implicit owner presence to make a query fit.

Library uses existing viewer-self `owner.presence` with exactly [the qualifying union](#presence).
Collection uses request-only closed `{"collection":{"id":"UUID"}}`, with one native UUID, no other selectors;
its shared grammar producer is still pending.
Curated membership is canonical eligible-occurrence EXISTS: duplicate occurrences yield one search subject while
retaining every occurrence/note/edit identity. A manual-only subject absent Everything MUST match Collection scope.
Own private dynamic reads use current authorized native facts/pins. Another reader uses complete currently authorized
published/ready output, never fresh curator-private predicates. Count actual own combined private expansion/work
within shared 32 leaves/depth 4/OR 16; public ready output never expands or reveals the hidden private predicate.
Stored saved/dynamic definitions continue rejecting Collection/Zone/Realm resource operands, preventing recursion.
Structural admission grants no source/private SQL authority. Authorize EVERY resource before candidates, including
inside true OR/NOT; concealed missing sources never fold false to make NOT true.

Text keeps actual [parseText](../services/kernel/src/search/text.ts) and
[Search planning](../services/kernel/src/search/README.md#search-planning-and-engine-page) expression limits,
implicit AND, `|` OR, unary `-`, phrases and escapes. Raw validated expression binds the cursor: no transport trim,
NFC or casefold. [Document fields](../services/kernel/src/search/document.ts) and the
[index analyzer](../services/kernel/db/search/indices/subjects.json) define public labels/aliases AND descriptions
in `search_text`: `cjk_bigram_v2` uses ICU NFKC_CF, standard tokenization, Traditional-Simplified/Hiragana-Katakana
folding, CJK bigrams and stopwords. Analyzer normalization does not rewrite transport values. Native owner PostgreSQL
execution must preserve term/phrase/Boolean semantics, default relevance with text/name without text, stable ties
and encrypted cursors. Substring/title-only matching or local relevance is insufficient. Private notes, progress
and label names add no public text fields. Owner-local text/index/analyzer/ranking and complete Source ports remain
REQUIRED missing capabilities; neither public catalogue top-N intersected with owner IDs nor one point per subject
is an owner plan. Missing ports do not make all normal text unsupported or establish completion.

### Native preparation admission

Exactly ONE Library scope may admit the SAME Library derived preparation: one viewer-owned Collection condition OR
one positive viewer-self presence scope, never both/several. Negative/absent/foreign presence, foreign Collections
(public, curated or even co-located), anonymous/string viewers and other shapes take the direct path with its
existing bounded outcome and ZERO derived rows/workflows. Full Boolean population must genuinely be anchored in
the admitted source; presence under OR does not prove the whole query ranges over Everything. Direct capability
remains required; absence of preparation permission neither proves direct fits nor closes mixed-query support.

Endpoint `subject:read` on Global remains its route gate, not operational authority. The operational transaction
receives the REAL verified Actor/native source eligibility and `accessCommandAuthorization` for ACTUAL Collection
`collection:read`; principal/basis come from `principalCommandIdentity`. Resource partition equals owner/preparation
partition, with the same at-most-two-account native active fences (own Collection fences the viewer). No new grant,
override, Actor, resource, Access port, engine or queue. Current Actor/request/source/family grants/gates/consent
precede private work. Search's [actual service](../services/kernel/src/search/service.ts) accepts a viewer STRING;
the REAL verified request authority bridge is missing, must declare its callers/tests/root typecheck, and cannot
reconstruct an Actor from `account:ID` or infer a signature here.

Positive own presence uses REAL logical Everything's ID through
[builtin-identity.ts](../services/kernel/src/library/builtin-identity.ts): existing `derivedId`, owner namespace/route,
`['library.collection.builtin', 1, 'everything']`. Admission NEVER materializes. Actual native logical-owner read
authorization as an operational input is NOT YET delivered; the helper/string account ID supplies no permission.
Until that producer exists this shape retains its direct bounded outcome. Canonicalize only the recognized scope
identity to the SAME Everything Collection ID: presence, `collection.id=Everything` and Members GET reuse ONE
preparation/basis `(viewer, source, filter, text, sort, release)`, quota 32, write rate and fences. This approved
scope equivalence is not arbitrary AST Boolean equivalence or permission to discard user terms. Preserve current
quota/expiry/idempotence/retained-frontier rules. Work-intent locators plus basis key fit 4096 UTF-8 JSON bytes,
with NO raw query text; work-step discloses nothing. Retained Library text/current typed work requires exact
Library/shared-history custody and viewer erasure, without exception.

Authentication is unchanged: public anonymous direct is not 401. Missing required credentials yield
`401 authentication_required` with bare Bearer; invalid/expired/revoked/pre-suspension bearers yield
`401 invalid_credentials` with Bearer `invalid_token` BEFORE the route. Verified-suspension 403 is defensive only;
never fabricate a valid suspended bearer. Operational `LifecycleDeniedError` maps as Access's current account reads,
without HTTP rewrite.

### Native text physical requirements

Keep the ONE structural candidate/support directory, native fact/pin authority, selective dependency repair and
full canonical Library participant/custody below. The adopted physical baseline from the
[current](research/library-scoped-title-plan-current.md) and [deep](research/library-scoped-title-plan-deep.md)
reports is finite retained evaluation over that ONE directory, with native facts as authority, rather than mandatory
persistent owner text copies. This conditional direction establishes neither a native evaluator nor complete
source/provenance, seekable rank or disclosure. Both reports' title-only narrowing is rejected: `search_text`
includes public labels, aliases AND descriptions with the actual shared analyzer/parser/phrase/ranking/defaults.
No second text evaluator is introduced. A copied public text derivative is neither native authority nor permission.
Before runtime derive physical copies/indexes/bytes, inverse affected
dependencies, retention/reclaim/source withdrawals, owner A5/shared-history custody and bootstrap/crash proof.
If text is copied later, every subject text change fans out to holders in paged bounded steps, total LINEAR in
affected owner rows, never synchronously in the subject write.

### Cost: native owner text read

- Touches: owner-partition source/text/predicate/order indexes, native facts/pins, complete original/terminal and
  exclusion/order disclosure, resolution/auth/head/release/control/fields/currentness and cursor work.
- Bound: [Filtered-list budgets](filtered-lists.md#budgets) apply to the WHOLE read: same fixed terms, 12 statements
  per backend or composed `8 + 4R`, no per-leaf allowance. Direct must prove BOTH large owner pool/sparse text AND
  many text matches/small owner pool; neither pool scan nor global-matches scan meets the bound. Otherwise only
  actually authorized retained owner results (same quota 32), or current 422 before enumeration until the required
  port exists. Finite preparation yields filled/final pages, not repeated short/empty success or endless preparing
  under disjoint identity jobs. Another reader's complete Collection output is ready-result read: `2s + 2`
  candidates/2 index reads, with no hidden predicate expansion.
- Growth check: REQUIRED FUTURE native cases below; no direct bound or native pass is claimed.

### Cost: preparation admission

- Touches: verified request/source authority, exact scope recognition, canonical basis lookup, quota/rate/fences,
  derived row plus same-client durable intent, current denial/finalization and retained frontier.
- Bound: same [preparation budgets](filtered-lists.md#budgets) and
  [Kernel job-step authority](../services/kernel/README.md#bounded-job-steps); only the admission above writes.
  Resolution/auth/head/release/control/currentness share the fixed terms; no new allowance or cached permission.
- Growth check: REQUIRED FUTURE same-query alias forms reuse ONE preparation; denied/anonymous and inadmissible
  shapes write ZERO derived rows/DBOS workflows; queued owner terminal T defeats admission/replay.

### Cost: text maintenance

- Touches: actual changed subject text, indexed inverse holder/dependency ranges, owner index/result rows,
  frontier and durable work, withdrawal/reclaim and Library/shared-history erasure custody.
- Bound: [maintenance budgets](filtered-lists.md#cost) and Kernel job-step caps apply per step; total work is linear
  in affected owner rows, charging retries/discarded work. No synchronous holder fanout or unrelated-owner sweep.
- Growth check: REQUIRED FUTURE holder-fanout steps AND total work, bootstrap/crash replay, text edits/reveals
  behind frontiers, withdrawals and erasure; retained progress must converge on finite current input.

### Required future native cases and delivery gaps

Use actual `checkGrowth`, explicit series 64/512/4096, warm-up plus measured repetitions, production-sized growing
relations, `GROWTH_PROFILE`, named needed indexes and rows/blocks/statements plus ALL engine work under
[shared growth checks](filtered-lists.md#three-scale-checks). A fixed small-table scan is not universally banned.
Required FUTURE cases include both text-selectivity axes; manual duplicates/absent Everything; label-only and
completed-session-without-state; mixed type/tag/>1M words/text; raw phrases/CJK/analyzer/ranking conformance;
negative/excluded/order/withheld original AND terminal; text edit/reveal behind frontier; source/release/cursor
changes; queued owner T; holder fanout steps/total work/crash replay; denied/anonymous ZERO writes/DBOS; and
same-query scope aliases sharing ONE preparation. These cases are not asserted written, frozen or passed.
Complete Source2a/privacy/identity, logical-owner authorization bridge, verified request bridge, native index and
runtime remain pending. This adoption creates no readiness, ABI, type or dependency and preserves all existing
first-public outcomes and scoped concurrent identity rules, including no global marker/universal page gate.

## Native candidate support and complete observations

Adopt the independently compared [current investigation](research/library-owner-index-observation-current.md) and
[deep investigation](research/library-owner-index-observation-deep.md) as evidence for this plan. Their earlier
source inventories are historical, not API, database, query or native acceptance. The smaller structural directory
below resolves their physical alternative; exact schema, indexes, transaction design and ABI require native
specification and proof before costly runtime implementation. This adoption activates no plan or release.

### One structural directory over native truth

Maintain one private OWNER candidate/support directory shared by Everything, state, Continue, Liked and admitted
arbitrary owner queries. One canonical candidate key has bounded ORIGINAL-support scope ranges and inverse access
by original/scope. Scopes cover family presence, needed accepted predicate dimensions and seek extrema. Summaries,
first/last counts and ordering locators are access metadata, never fact/pin payload, permission or per-fact witnesses.
Prepared rows are quota-bound query results, not per-built-in subject lists. Do not extend `canonical_source_fact`
or entry-specific built-in reference witnesses into a second fact database.

Choose structural rekeying rather than adding canonical columns to every native fact: epoch work rekeys bounded
structural support ranges, never millions of original session/copy records. Native predicate indexes remain
anchored by owner, original, family, accepted dimensions and exact fact IDs. A structural state-winner ordering
index may retain the needed native sequence locator; exact predicate values and pins always come from native truth.
Canonical ID/order seeks must yield `[c,z]` for stored `[a,c,z]` with `a→z`, not first-seen deduplication.

State seeks select the highest LIVE `owner_write_seq` before testing the requested state. Same-value fresh writes
change winner/order dependencies; clears remove live support without a tombstone, archives never compete, and Undo
is fresh order with original dates/pin. Preserve conflicts. Labels union across current supported originals only
with current live same-owner parents; they need no profile and support no state siblings. Parent deletion records
one parent/range invalidation atomically, without synchronous child fanout; bounded inverse repair covers children.
A parent point rejects stale positives but alone cannot prove complete replacement or absence.

Live entry, retained session and retained copy accepted pins support every relevant sibling, including empty states.
Maintain first/last pin-set support and bounded descriptor expansion proactively, including tuple-to-opaque-reference
recognition. For unmaterialized private presentation only, seek the lexically smallest CURRENT supported digest
CONTAINING the requested state. A digest containing only other states is insufficient. Materialized headers and
completed public generations retain accepted meaning; owner rename wins. Labels/trash support none. Arbitrarily
large distinct scopes or descriptors require bounded retained work, not a claim of constant fanout.

One million sessions on a subject requires native indexed EXISTS/top-one and then the next structural supporter,
not history sorting/counting, raw-session deduplication or an alias sweep. Accepted profile/lifecycle prefixes and
actual activity order must match the seek. Both holding qualifiers constrain the SAME native copy; omitted
qualifiers remain valid through matching indexed paths without scanning unselected prefix values. Keep separate
copy/session identities, exact SQL timestamp precision, active-session ID tie order and sparse BASIC session values;
do not enumerate units/history for display or invent unknown historic activity.

Everything retains the full independent state/label/session-history/holding union. Reactions support only the
always-logical private Liked, including empty 200. Continue uses the chosen pin's active ROLE or an independent
accepted active session; a newer nonactive state defeats an older active state without vetoing that session.
Maintenance must precede the first Continue GET or Everything visit; GET starts no work. Completing the displayed
active session exposes the indexed next one; terminal session activity may still raise subject activity.
Candidate activity from withheld originals is only a discovery bound and cannot order visible results.

Retain potentially qualifying originals even when currently withheld or excluded. A positive needs current native
support AND original AND terminal admission. A readable terminal, cached eligible count or one remembered positive
cannot prove completeness. Loss of the last readable alias invalidates the whole affected query; restoration behind
a frontier requires indexed repair too. Settled eligible-support/order access is bound to covered observations and
revalidated native truth, never cached permission or a repeated per-page walk of every alias.

### Selective dependencies, bootstrap and finite preparation

Use private per-dependency monotone change positions, indexed dependency-to-prepared-result registrations and
retained coalesced old/new affected-input repair work. The delivered broad `readOwnerFactVersion` is only a
same-snapshot native mutation alarm/commit fence: it proves no bootstrap, epoch, negative result or selective
invalidation by itself. Keep its full changed-row hooks and charge each actual row mutation separately.

Expand saved shared Filter ASTs before collecting the COMPLETE closure: NOT, currently false/excluded branches,
population/membership, accepted meaning, identity, order, selected public inputs and foreign dependencies. Reuse
shared Boolean semantics and catalogue unknown under NOT. Record old AND new keys, removals/zero crossings and
same-value sequence/order changes atomically with native facts. Retain removed locators and parent/range work until
all relevant live consumers cover them or expire; high-water positions alone lose intermediate affected inputs.
Private keys stay private and never enter public logs/indexes. Route affected results through indexes, never a scan
of every definition or a broad-head rebuild after unrelated changes.

Direct indexed plans run only where physically examined work fits existing bounds. Other supported legal Boolean,
saved, negative or ordered shapes retain finite indexed input frontiers, settled ordered results and behind-frontier
change custody. No global owner enumeration/sort on a request, unlimited refills, repeated full restart, successful
empty chains, never-ready legal input or population cap of 4096. Everything's ordered candidate index may give its
first useful page when its covered ordered frontier proves that page complete, without complete owner enumeration.
Unsupported shapes reject before enumeration;
missing producers cannot silently narrow the original first-public capability.

Native family bootstrap and concurrent writers share an indexed frontier/CAS boundary. Covered-side old/new deltas,
including behind-frontier insertions, apply once; uncovered inputs belong to the later page. Commit page effects and
frontier together so retry cannot double-count. Final activation shares that writer boundary and cannot lose a
concurrent creation. Quota-bound registration/activation serializes on native owner control, and writers atomically
invalidate affected queries. Parent-wide dirty ranges and epoch changes keep their own coverage gates.

Read native facts and the broad alarm in the same caller-owned RR snapshot. A second read inside that SAME old
REPEATABLE READ cannot observe a later commit. Completion needs a new current observation/serialized native CAS
covering dependency cuts, bootstrap and published epoch; a stale completion cannot replace newer work. Reauthorize
and recheck relevant owner/original/terminal/public/foreign safety around disclosure. A reduction repaired and ACKed
during the request must still be detected. Serialize the actual activation/writer boundary in the native SPEC;
this prose does not claim an implemented lock protocol or global cross-home snapshot. Release each home before
another home/engine checkout. Ordinary complete selected-state/native empty seeks differ from directory
unbuilt/moved/unsequenced readiness; a missing broad head alone proves neither empty nor nonempty.

### Shared operational, identity and disclosure producers

Accounts owns the additive Core fenced event-free owner operational transaction plus atomic durable intent and
its native specification. `runCommand`/`noEffect` and live-CommandTransaction `shareAccount` are not substitutes;
ordinary WorkClient enqueue after commit loses atomic intent custody. Never fabricate an Actor/CommandTransaction,
coordination writes hidden as noEffect, dummy event/receipt, local Core bypass or another queue/process/engine.

The adopted producer uses SERIALIZABLE, the current deadline/contention retry and existing command gate. Request
mode uses actual Access admission and current-T finalization; work-step mode has no Actor and retakes partition
and up to two current active/unfenced account FOR SHARE fences. No receipt, event, write basis or position advance
is permitted. `enqueueIntent` uses pinned DBOS `enqueueInTransaction` on the SAME pg client as the derived row:
no separate intent table, relay leg, new queue or held second connection. DBOS recovers work; only terminal workflows
expire. The consumer owns uniqueness via `INSERT ON CONFLICT DO NOTHING RETURNING` and enqueues ONLY when created,
with deterministic workflowID, no deduplicationID and locators-only input under shared-history custody.
The actual API belongs solely to [Core's operational contract](../services/kernel/src/command/README.md#operational-transactions).
Its executor and frozen contract are now present in inspected source; Library consumer binding, native preparation
transactions and their full custody proof remain REQUIRED pending implementation. This does not activate Members.

The ONE existing Library identity participant `library-private-follow-counts` covers EVERY Library canonical
record, including OWNER candidate/support directories, follows, support, totals and concurrent first-apply rekey
custody. Preserve that identifier; no third participant or independent ACK shortcut. Follow-count completion alone
is incomplete.
The [shared native epoch contract](../services/kernel/src/semantic/identity-epoch-contract.md#complete-library-canonical-coverage-under-the-fixed-participant)
owns the receipt ABI: ACK covers every prior OLD removal, NEW addition, candidate/support change, pending/published
fence and first-apply obligation, bound to exact native transactionId AND component/job/epoch/version/scope.
Current terminal/account/source fences and stale destination rejection apply in the actual effect transaction.
First apply before the gate must enter retained rekey custody; after it, reject/retry current truth or durably
retain responsibility. Source commit before registration cannot fall between enumeration and publication.
Local effects ACK only after durable receiving-control custody; final native barrier/deferred guard is at real handoff.

Consume source-scoped concurrent identity currentness: no global active marker or universal list/page gate.
Observation, publication and cursor currentness cover the ACTUAL source and COMPLETE query dependencies, including
excluded and order originals. A finite unchanged owner source must progress under continuous disjoint identity jobs;
a genuinely all-group catalogue may wait on its broad dependencies without stalling unrelated sources. Changed
relevant basis restarts the existing signed cursor; no guessed vector, new crypto or caller certificate.

The [semantic owner specification](../services/kernel/src/semantic/identity-epoch-contract.md) owns the exact
partitioned changed-group capacity/job/epoch protocol: disjoint jobs run concurrently, busy only on overlap, with
symbolic P and independently progressing partition reclamation. Its scoped concurrent closure, Performance cost
confirmation and coowner review remain required before new types/runtime; existing serialized types are superseded.
Library adds no schema/ABI or duplicate protocol. Births stay source-local; immutable complete group inputs and
native custody remain required, never an inferred readiness or ACK.

Inside a filtered page, mapping joins existing batched owner/epoch/control observations and source candidate points:
TWO probes per page, never per ID, with no extra RR/client/control statement. Existing 12 statements/backend or
8+4R composed ceilings still govern. Standalone same-backend mapping uses one coherent RR/eight statements unless
actual wrong-single-snapshot evidence requires otherwise; remote classification stays with Semantic/Performance.
[Kernel bounded job steps](../services/kernel/README.md#bounded-job-steps) govern durable steps only, never a universal
100-raw public probe cap. Public pages keep actual per-plan raw budgets and useful full/final output.
Accounts owns shared-history operational DBOS intents; Library owns derived preparation/canonical rows. CoreOP adds
no intent table/relay/receipt/event; Access verification/reversal intent remains its own table, outside that rule.

Whole-query original/terminal/public/foreign disclosure remains the separate Source2a prerequisite. Actual point
Access, `subjectSource`, shared public-filter types and projection checkpoints cannot supply complete population,
excluded/order, behind-home selective repair or commit-visible start/end observations. Require its real producer
and receipt; invent no observation signature or public private-key log. Public/foreign-dependent phases remain
individually pending until delivered, without weakening full required outcomes.

Every directory/support/change/registration/frontier/prepared/intent store joins the exact Library
[A5 retention inventory](../services/kernel/src/library/README.md#retention-inventory) and terminal fence.
Shared artifacts join their actual store-owner custody with exact native transactionId/component/job and workflow/
input/output locators. Fence delayed apply, repair, bootstrap and enqueue at terminal T. Erase children first,
heads/counters last after fact hooks cannot recreate them; native exhaustion alone proves no shared payload erasure.
Active-PUBLIC completed A at T retains fixed membership with current disclosure; pending B cannot finish from
private facts. Missing whole-role/custody proof stays pending.

### Sequencing cutover, bounded cuts and native proof

NULL sequence is unknown chronology. Backfill only from complete authoritative native state-write evidence with
verified exact locators and a producer-owned bounded live-write cutover; otherwise affected state winner,
NOT-state and Continue state remain unready pending explicit real owner reassertion. No arbitrary rank, Number,
time, UUID, source position or allocator-by-scan; never silently rank legacy states above already-sequenced writes.
This is a required cutover producer, not a permanent launch exception. Independent original/presence/label/session/
holding paths need not all wait for ordering when their own coverage, pins and privacy are complete.

Split implementation into independently reviewable cuts of at most 400 production lines/eight paths EACH;
split a cut again before dispatch if it exceeds either. Required cuts are directory schema/point access; one actual
family writer plus native predicate index at a time; pin-set/sibling support; one private impact family/registration;
writer-aware bootstrap; the Accounts event-free intent producer and Library consumer; retained prepared plans;
the native identity participant; common built-ins; proactive Continue; Content-backed Liked; and separate terminal/
foreign phases. Set, clear and Undo sequencing/cutover require their own bounded native proofs. Existing full
capability composition stays intact; this is not one giant schema/writer/privacy task, and primitives never close it.

Preserve full dynamic contract/outcomes, Library/profile/source outcomes, native released-profile/population,
owner-state-order, Continue user cases and shared query/source suites. Freeze actual HTTP/native cases using
released roles, two accepted digests, real credentials/scopes/gates and released discovery/population producers.
Retain Book/harem/word-count, same-statement qualifiers/units, saved/OR/NOT/order, unprofiled label-only presence,
all sibling pin sources, independent copies, sparse sessions and own-vs-Bob completion; preserve the exact Recipe
result below. Include owner, another viewer, anonymous, delegated and actual revoked-suspended-token traces.

Required adversarial schedules include first/last support; deleted parent with many assignments and cleanup paused;
millions of sessions and next-active replacement; same-value winner change; last-readable alias loss/restoration;
merge/unmerge/repoint with delayed repair; missing pins/heads; concurrent first apply on both sides of the epoch
gate; source commit/control custody/ACK crashes; behind-frontier insert/remove; first Continue visit; epoch restart;
and terminal T with completed public A/pending B. Full/final/preparing, logical empty Liked, current disclosure,
source/cursor reauthorization and no resurrection remain required, not replaced by primitive proofs.

Document and later measure native 64/512/4096 and legal larger axes independently: population, matches, sparse
exclusions, labels, aliases, owners, sessions/history, distinct scopes/descriptors, index depth, unrelated writes and
reduction arrivals. Charge examined/removed raw inputs, lookahead/duplicates/rejects, native authority/parent points,
expanded dependencies, statements including triggers, blocks, bytes, engines, buffers, background effects, retries
and discarded work. Reuse [filtered-list budgets and composed harness](filtered-lists.md#cost) and
[Kernel bounded job steps](../services/kernel/README.md#bounded-job-steps), including the shared 100 RAW jobpage
where applicable; older reports' generic preparation ceiling never overrides that stronger limit. No second
numeric allowance authority or per-page 4096 sweep. This prose acceptance runs no native probes or growth captures.

## Required Recipe query and controlled outcome

The query uses the [common Collection members filter transport](dynamic-collections.md#one-collection-page),
with `sort=id` and `limit=2`. The target is Alice's Everything through the existing
`GET /v1/collections/{collectionId}/members` surface. Presence is redundant there but deliberately explicit.
The same filter restricts a broader catalogue, curated, TypeList or Zone source only where that authenticated
personalized plan is admitted; it does not make public personalization universally available.

```json
{
  "and": [
    { "type": { "in": ["schema:Recipe"] } },
    { "statement": { "property": "schema:suitableForDiet", "in": ["VEGETARIAN_CONCEPT_ID"] } },
    {
      "statement": {
        "property": "schema:cookTime",
        "range": { "lte": 30, "unit": "http://www.wikidata.org/entity/Q7727" }
      }
    },
    { "owner": { "presence": true } },
    { "not": { "owner": { "session": { "profileId": "RECIPE_PROFILE_ID", "lifecycle": "completed" } } } }
  ]
}
```

This is a logical template, not valid instantiated HTTP input: replace `VEGETARIAN_CONCEPT_ID` with the actual
released VegetarianDiet Concept ID and `RECIPE_PROFILE_ID` with the actual released Recipe accepting profile ID.
Use the fixture's genuine released property/type declarations and accepted pins. The expanded minute IRI is
`http://www.wikidata.org/entity/Q7727`, not a scalar `minute`/`MINUTE` alias. The type leaf above matches the current
source grammar; owner admission and any missing released diet/profile data remain explicit gaps. No placeholder
or rejected query can count as a successful required native case.

The [shared discovery fixture specification](../packages/definitions/src/released-discovery-fixtures.md)
defines quick/25, edge/30, slow/31, meat/nonvegetarian, unknown-diet, cooked/20 and other-cooked/20 controls.
All four diet/time-eligible recipes have actual Alice presence. The complete result across pages is exactly
`{R-quick, R-edge, R-other-cooked}`. Alice's actual completed session excludes `R-cooked`, including after she clears
its entry state. Bob-only completion leaves `R-other-cooked` included. Slow, nonvegetarian and unknown-diet controls
fail catalogue predicates; absent cookTime also fails. No-entry support remains included without default state.
A separate NOT-state control includes complete no-entry cases and must not replace the completed-history test.

## Delivery boundary and required native evidence

This adoption records the native plan and preserves required native-case freezing. It adds no production code, exported
runtime symbol, schema migration, API tests or gate. File presence and document format/link validation establish
**prose delivery only**, not product acceptance.

Current source receipts are narrower than runtime readiness:

- Shared Filter structural grammar and walking are delivered; owner execution is not.
- Common member HTTP filter admission now uses that grammar and release expansion. It validates all owner-family
  list scopes and gates, including OR/NOT branches, against the authenticated viewer before any private-fact SQL.
  Explicit `filter`/`sort` requests reach the same boundary for BASIC and FULL and return dependency unavailability
  until native plans can execute. This is input/admission support, not a successful filtered-members implementation.
  The actual shared `search/current-filter-plan.ts` now exports `compileCurrentOwnerFilter` with tagged owner and
  catalogue leaves. Admission consumes that compiler; the public catalogue compiler continues rejecting owner
  nodes. Native leaf adapters share the Source ledger, preflight variable-width projections, and preserve unknown
  negative evidence. Presence remains independent of profile/pin readiness. All deduplicated observations are
  required before shared Boolean evaluation. Integration still requires complete selective Collection Source
  observations and the native owner candidate/support directory. `prepareCollectionMemberFilter` uses the exact
  existing Source preparation ABI with the caller's context and allowance. No local
  Boolean interpreter, guessed callback, successful empty adapter or duplicate directory substitutes for them.
- [`allocateOwnerWriteSeq`](../services/kernel/src/library/owner-write-sequence.md), nullable positive live/archive
  columns and [`readOwnerFactVersion`](../services/kernel/src/library/owner-fact-version.md) with full changed-row
  hooks are delivered primitives. Actual `entries.ts` allocates and persists sequence order for set, retained clear
  and exact Undo. Complete profiled writer/source coverage and authoritative NULL cutover remain pending.
- `entry-store.ts` now accepts private pins for entry writes and pin/kind for copy writes, and exports
  `readEntryFact`/`readCopyFact`; `progress-store.ts` accepts session pins and exports `readSessionFact`.
  These preserve native accepted data, without proving profile acceptance in every production command or a ready
  directory. Older reports' blanket adapter-absence claims are superseded.
- `collection-source-native.ts` supplies stored-header/raw-original ranges and probes. `createCollectionSource`
  and canonical-source factories still throw unavailable; built-in identity covers Everything/state, while its
  entry-witness reference binder does not establish all sibling/session/copy support or Liked.
- Core's `command/operational.ts` and frozen README now supply the additive operational producer in source, using
  `work/client.ts` atomic DBOS enqueue. This corrects the reports' earlier mechanism gap, not Library integration.
  No callable signature is invented here and no native producer or consumer check is certified by this adoption.
- Content reaction commands are actual native truth. No `readLiked`/`readLikedVersion` implementation is present
  in inspected worktree/dev source; require actual raw reader plus version/DDL receipts before consumption.
  Even delivered raw stored-ID paging would not establish canonical support, completeness or disclosure.
- Semantic identity STORE/mapping/participants/coordinator and Source2a remain native runtime prerequisites;
  their contracts/types, point disclosure and existing `subjectSource` do not implement them.

Owner indexed/prepared plans, Collection/dynamic source integration, full native driver bindings and composed-budget
proof remain required.

The Library-owned native caller now lives in `owner-filter-plan.ts`. It consumes the shared compiler, native fact
points, Source allowance/receipts, selective scope observation, confidential list cursor and existing durable
MembersPreparation reservation. It evaluates all deduplicated leaves before Boolean composition and requires a
full page or actual exhaustion. Complete authorized original/fact closure and the common native read's actual
T/reservation/capture remain explicit unavailable bindings. The Semantic scope and public capture adapters retain
their exact producer declarations and unavailable outcomes. This source stage does not establish native useful
pages, complete privacy coverage, worker convergence or Goal completion.
The shared released-fixture specification exists, but required released data may remain red. Commerce's native
population specification is a real producer requirement, not evidence that its runtime population exists.

After adoption, freeze required raw HTTP cases against existing profile, label, dynamic and source suites, using
actual native commands and released IDs rather than a new fake driver. Cover exact closed shapes and Boolean
composition, viewer/delegation scope and denial, complete absence versus readiness, current label parents, old pins,
state-clear history, independent holdings, canonical uniqueness, public publication isolation, current exclusion/order
privacy, full/final/preparing progress and cursor reauthorization. Bind real SQL/index/preparation counters and the
shared composed growth harness before claiming native acceptance. Specified, native-bound, implemented/exposed,
passed at a revision and promoted remain separate evidence stages. No second protocol engine closes a missing producer.

### Staged native owner implementation

`owner_member_index` and `owner_member_support` now retain one original directory and structural family/pin scopes;
entry/session/copy/assignment SQL triggers maintain first/last scopes in the native writer transaction. Parent
liveness changes advance the existing source head immediately and retain one indexed raw100 child repair frontier.
Native predicate truth always checks the current same-owner live parent. Bounded default maintenance bootstraps
native rows and resolves actual immutable released pin meanings, expanding all supported state siblings through
the existing opaque reference authority. These records are not canonical keys, query results or disclosure evidence.
Native state-reference race binding uses that installed pending-pin metadata page; ready-pin recapture has no installed producer and fails explicitly rather than resetting accepted metadata through fixture writes.

The common Collection reader/routes now recognize logical owner Everything, discriminate dynamic DTOs and reject
occurrence mutations. Empty Everything uses complete independent native absence checks, never an unbuilt directory
or fabricated identity basis. Any possibly nonempty member query remains explicitly unavailable until the delivered
mapping, fixed ALL-Library participant, final coordinator and whole-query privacy observation compose. No successful
empty result or permanent preparation substitutes for those bindings. State discovery/detail and materialized header
presentation still require that integration. Full filters, text/ranking, selective dependency registration/repair,
canonical keyset/prepared useful pages, Liked, Continue, native cost and complete erasure acceptance remain outstanding.
