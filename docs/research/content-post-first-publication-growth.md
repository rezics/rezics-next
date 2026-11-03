# Native draft-to-first-publication growth

This private acceptance binds [Content Done-when 1](../goals/content.md#done-when) and its
[three-scale native acceptance](../goals/content.md#acceptance) to the existing revision API.
The source inspected is `7611eb8d97eafcc58b5bcbf410b8fa626386f105`, which contains the native producer and
functional scenarios named by the contract. Its integration reference
`da495f8652249175e14b29192011b208c38cfdf9` is not an ancestor of this retained base; the operation binding below
uses the actual retained source, without merging that reference.
This document describes authored assertions; it does not record a measured pass or notification delivery.
Controller admission owns execution of the native acceptance after integration.

Decision: measure the existing authenticated revision transition independently for openings and replies;
seed expired native grants on an unrelated real post for command-history pressure without changing selected permissions.

## Source and operation binding

Read source:

- [Content Goal](../goals/content.md), Done-when 1 and Acceptance.
- [Content owner](../../services/kernel/src/content/README.md#notifications), Notifications,
  Atomic content commands, Post revision provenance and Cost.
- [Native functional acceptance](../../services/kernel/test/content/post-publication-http.test.ts) and its
  [fixture](../../services/kernel/test/content/support/post-publication-fixture.ts).
- [Native identity composition](../../services/kernel/test/content/support/native-system.ts) and the existing
  thread-transaction and moderation-point growth tests for the observed native HTTP composition.
- [Revision producer](../../services/kernel/src/content/commands.ts), `containerAuthorization`, `chain`,
  `appendRevision`, `revisePost` and `result`; its read-post, read-thread, insert-revision, update-head and
  publish-opening-thread SQL.
- [HTTP revision route](../../services/kernel/src/content/routes.ts), containing-thread lookup, native If-Match,
  revision command and exact response read; [reads](../../services/kernel/src/content/reads.ts), bounded chain,
  initial/final disclosure and exact revision read.
- [Native executor](../../services/kernel/src/command/command.ts) and [fence](../../services/kernel/src/command/fence.sql),
  authorization before receipt lookup, replay, serializable commit and atomic event/receipt/basis writes.
- Shared growth observer, seed, classifier, model, bounds, cost and access-path helpers; the supported
  [SQL observer](../../services/kernel/test/content/support/sql-observer.ts) for exact parameter binding and failure injection.

The [new fixture](../../services/kernel/test/content/support/growth-post-first-publication-fixture.ts) reuses native
Auth credentials, production Access, native Realm/board setup and the same database. A production `createKernel`
uses the instrumented pool, original route/token keys and ordinary receipt keys. Every selected draft and its
first publication goes through authenticated HTTP. The publication uses the exact draft response's current
`revisionId` as the structured native `If-Match` header. No Access substitute, synthetic receipt, selected
visibility SQL, manually emitted event, work runtime substitute or notice driver is involved.

## Independent populations and capture

Each of six checks starts an isolated native fixture, so one axis cannot supply another's pressure.
Scales are exactly 256, 1024 and 4096, with the shared harness's default repetitions and warmups.
The classifier uses constant rows/statements and logarithmic blocks with unchanged shared budgets and planner settings.

| Axis | Population | Fixed selection |
| --- | --- | --- |
| Unrelated threads/posts | Routed bulk rows copy the shape of a real native opening, with independent IDs in the selected home partition; one thread/post/revision per ordinal | Selected draft history, containers, body and ancestry |
| Selected retained revisions | Each fresh selected draft receives exactly N immutable retained revision rows, copied from its own current native revision; its native head and visibility are asserted unchanged | Unrelated population and command history; no synthetic receipts or events |
| Native command history | N disjoint, expired native `POST /v1/grants` commands on a real unrelated post in the selected home, for another real account; transaction joins pin grants to their actual native receipt/outbox/write-basis envelopes | Thread/post populations and selected revision history; no current grant or selected visibility changes |

Opening drafts are routed into the fixture's home by selecting their real creation idempotency keys before
issuing the command. Replies use a fixed native chain: selected draft plus 32 parents, including the opening.
Opening ancestry is one. The canonical body is fixed, small and below the owner's 2 MiB limit; this is a population
experiment, not a maximum-byte benchmark. No population scales ancestry or body size.

`grow` seeds pressure and creates a spare warmup draft outside capture. `prepare` creates a fresh measured draft,
adds its retained history when applicable and records its exact pre-state outside capture. The measured operation
is the complete authenticated publication request through response JSON parsing. It includes authentication,
parent/source/Access preparation, the command, native fence/commit and current exact-response disclosure.
SQL binding assertions operate on already observed records. Evidence queries, exact revision verification and
all setup are outside the measured window, including for warmups. The shared observer captures real executed plans;
no SQL is EXPLAINed as an approximation of another operation.

## SQL-bound envelope

Let H be the selected post and its parents, H <= 33, and B be canonical bytes, B <= 2 MiB.
The route performs one containing-thread point lookup. Command preparation and current transaction validation
read the bounded thread/post chain; each command post lookup joins only its exact current revision by routed IDs.
The response reader repeats bounded initial/final chains and fetches the one requested revision after current
Access checks. All container and ordinary native authorization work is included; it is not replaced by a
public-reader fixture or removed from the cost. At fixed H, B, actor, containers and permission shape, those
probes are independent of retained revisions and unrelated population N. Indexed point/range descents account
for logarithmic blocks. No command step enumerates selected revision history, home receipts or outbox history.

The concrete additional write envelope comes from the current producer and executor, rather than the old
published-edit budget:

| Work in one successful first publication | Exact SQL work |
| --- | --- |
| Revision insertion | One `insert-revision.sql`, bound to the selected post and newly returned revision |
| Head/visibility CAS | One `update-head.sql`, bound to that new revision, exact old head and draft -> published; author, availability and security revision predicates remain native |
| Opening thread publication | One `publish-opening-thread.sql` for openings, zero for replies; the UPDATE acquires the thread row lock and checks opening identity, author, draft state and security revision |
| Native fence | One fence statement: one partition-position update, two outbox rows, one receipt and one editorial write basis in the same transaction |
| Exact event | Revision-created plus the closed `com.rezics.content.post.published.v1`, pinned to the transaction's returned revision |

The tests bind actual statement parameters, not only response status. Per accepted growth repetition, statement
attribution must include revision insertion, post CAS, optional opening update, native fence, receipt, basis,
Access and source/parent reads. Every sample must contain actual rows, plans and blocks. The shared classifier
asserts the three growth families, and the shared access-path assertion checks all captured relations, retaining
its existing tiny-relation rule. These checks fail if the new producer work is omitted from capture.

## Assertions and scope of evidence

For every measured successful publication, post visibility/security/head, thread visibility/security, retained
revision count, native receipt response, write-basis actor/client and the two native outbox events are checked.
The closed publication payload has exactly thread/item/revision, actor, place, kind, subject IDs and activity time;
its revision is fetched through the real exact-revision API and compared with the submitted canonical body.

The same suite captures native replay before and after a later silent published edit; replay retains the
original revision, creates no source writes and leaves all stored state unchanged. The later edit preserves
publication security revisions and emits no second publication. A fresh stale-head request fails with 412.
Two competing native requests select one winner and one event naming that winner. A native parent takedown
refuses child publication without mutation, alongside a successfully published sibling control using the same
actor and permissions.

For opening rollback, the supported one-shot SQL observer fails after the actual native event fence has run.
The real revision insert, post CAS and opening update are reached, followed by ROLLBACK. Revision IDs, post and
thread security/visibility, receipt/basis and outbox evidence, home command counts and partition position must equal pre-state. Anonymous thread visibility
stays concealed; retrying the identical key after the one-shot fault succeeds once and exposes the thread.
Observers and isolated databases are closed in `finally` blocks. No shared fixture, producer, frozen spec or
notice-consumer file changes.

These are source publication and transaction assertions. The independently owned notice consumer and driver
successor must separately prove notification delivery, preferences and send-time disclosure. This suite adds
no proof registration, gate or promotion claim. Native acceptance remains deferred to controller admission;
authored tests and compiler results alone cannot establish the growth verdicts.
