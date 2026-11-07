# Vote and Semantic application boundary

Decision: Rating owns counted preparation/read/finish, exact own-vote review and vote admission orchestration.
Its required `application/index.ts` port supplies Semantic identity mappings, ordinary original/terminal disclosure,
released snapshots, published-home epochs, exact review operands and the native commit participant. Semantic owns
`adapters/rating-votes.ts`; composition binds it once through Rating's public entry for server, default worker and
test preload. Construction starts no work. Missing installation throws; no synthetic currentness is available.
Explicit factory injection is the test seam, with the same required operations as ordinary installed composition.

One reader/command instance retains its supplied port. The original actor, Pool, ordered requested keys, request
deadline and exact original/canonical pair cross unchanged. Rating retains all three counted phases, instance-local
identity/visibility/epoch witnesses, bounded pages and final account/question/slot/row rechecks. The Semantic
participant prepares immutable intent and admits only on the original live command transaction; question admission
remains Rating-local, with both fences held through executor completion. Current authority precedes receipt disclosure;
review observations confer none. Closed stale/pending/unavailable reasons and wire shapes are unchanged.
Rating produces its own durable vote event in that transaction. The old Semantic event producer is removed.
Semantic contract exports own the immutable operand and admission vocabulary without loading a native reader.

Decision: extend the existing vote-review acceptance with supplied-port actor/Pool/deadline and original transaction
witnesses, exact pair and bounded mapping checks; receive existing installed repair producer/default-worker acceptance
unchanged. No new stories. Implementation acceptance is typing; native/browser/growth receiving belongs to sole Goal walks.

## Internal own-vote batch

`readOwnVotes(client, actor, questionId, targetIds)` enriches shelves using the caller's repeatable-read client and
snapshot. It requires the same current native account, authentication epoch and `rating:vote` scope as the own-vote
GET. It rejects more than 100 raw targets before deduplication and rejects unroutable question or target IDs. Empty
input still admits the caller. The Map uses exact requested target keys and GET values `{ units, revision, at }`;
clears and missing votes are absent, while zero remains a vote. It does not resolve redirects or select a controller,
population or shelf membership. This internal helper adds no HTTP endpoint or scope.

`readOwnCountedVotes(client, actor, questionId, targetIds)` is the bounded read for canonical pages. It seeks the
same viewer/question through Rating's partial `(route,voter_id,question_id,counted_target)` index and returns only
the viewer's current native counted vote for each supplied Content terminal. It accepts at most 100 IDs before
dedupe, uses the caller's repeatable-read client, preserves zero and omits absent or cleared votes. The caller must
resolve and revalidate Content identity and visible question meaning; this helper does not admit a result row or
expose aggregate ratings.
`createOwnCountedVoteReader({ pool, access }).prepare(request, deadline)` admits at most 100 requested Subject keys,
requires the current native actor account, authentication epoch and `rating:vote` scope, checks the standard question,
captures current Subject mappings and verifies ordinary Subject
readability before the owner starts its checkout. A pending identity mapping returns `preparing`; an absent,
concealed or unavailable Subject is retained as `unavailable` without exposing its terminal. The fixed measurement is
question `00000000-0000-7000-8000-000000000001`, revision 1, units 0 through 20 in steps of 1.

The caller retains one reader instance and the exact same actor and ordered requested IDs through all three phases;
preparations are instance-local and must not be serialized or reconstructed. The caller starts its own repeatable-read
transaction on the account's native home and passes that `PoolClient` to `read(client, request, preparation)`. The
read phase checks the same account standing and selects `rating.vote.counted_target` rows for the admitted
terminal IDs. It also probes the exact requested and canonical original slots for review evidence, including explicit
missing rows. Those slots never decide which source vote wins or replace counted-target truth. After releasing the owner checkout,
the caller invokes `finish(request, preparation, readResult, deadline)`. Finish rechecks the actual account, question,
identity mapping, published epochs on both identity homes, Subject disclosure, original slots and selected counted rows. It returns `current` only when those observations
match; otherwise it returns `preparing` with a same-input retry. This composition spans native snapshots and is not
one atomic snapshot.

Each current observation correlates `requestedTargetId`, the selected row's `originalTargetId`, and the native
`countingTargetId`. A present row with `units: 0` is a real score; `state: 'clear'` preserves a counted tombstone with
its original `revision` and separate `countedRevision`; `state: 'absent'` means no counted row exists at the current
destination. `unavailable` remains distinct from pending identity coverage. Callers keep their existing Library gate,
source witnesses, owner fencing and exact request on retry. The reader adds no route, derivative, writer or repair.

Decision: native own-score reads prepare identity and disclosure before the caller checkout, read only counted-target
truth plus exact original-slot witnesses in the caller snapshot, then return `preparing` with the same input when final native observations differ.

The mounted factory signature is
`createOwnCountedVoteReader(deps: OwnCountedVoteReaderDependencies): OwnCountedVoteReader`, where dependencies
are `{ pool: Pool; access: Access; semantic?: RatingVoteSemantic }`. Omitted `semantic` consumes the installed native port. Its public protocol is:

```ts
prepare(request: OwnCountedVoteRequest, deadline: number): Promise<OwnCountedVotePrepareResult>;
read(client: Pick<PoolClient, 'query'>, request: OwnCountedVoteRequest,
     preparation: OwnCountedVotePreparation): Promise<OwnCountedVoteReadResult>;
finish(request: OwnCountedVoteRequest, preparation: OwnCountedVotePreparation,
       readResult: OwnCountedVoteReadResult, deadline: number): Promise<OwnCountedVoteResult>;
```

`request` is `{ actor: Actor; targetIds: readonly string[] }`; deadlines are absolute milliseconds. Duplicate keys
keep their first occurrence, but all raw keys count toward the 100-key cap. The canonical Subject is the mapping's
terminal and equals `countingTargetId`; `originalTargetId` identifies the selected native vote, which can differ
from both the requested and canonical Subject. `sourceEpoch` is a decimal string. Fingerprints are SHA-256 hex
digests of JSON observations; the request digest binds account, client, sorted scopes, authentication epoch,
requested-by identity and ordered raw keys. Native account observations bind route, standing and transaction
identity; instance-local witnesses also bind published epochs on the requested and canonical homes.

Dependency errors propagate: callers retain their cursor and exact input, without publishing empty or refreshed
observations. A changed `countedRevision` invalidates final confirmation even when units and original `revision`
are unchanged. Display values are units divided by two; `null` remains clear. The [conditional review](README.md#conditional-provider-vote-review) witness encoding and byte limit apply to these
observations, but confer no atomic conditional write admission.

Decision: publish the named reader and dependency types from the generated mounted module so consumers never infer
the protocol from private source; the account-page `createOwnVotesReader` remains a separate authority.
