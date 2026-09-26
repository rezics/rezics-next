# Statement judgment owner

Access migrations 230–231 own the private principal key, two independent dimension
heads, one immutable revision family, idempotency receipts and bounded aggregates.
Main verifies an Account assertion and the exact active, accepted Statement through
the Statement owner's Jena read API before an initial write. An exact retry reads
the Access receipt first, so a lost response does not require the original
Statement decision to remain current. Access checks current Realm private
membership on new writes. The aggregate is scoped by Statement ID and Global or
Realm population key; private principal IDs never leave Access.

The initial `wilson-v1` policy fixes `z = 1.96`. Changing `z` requires a new
policy generation. Fit and spoiler sample sizes exclude null dimensions. A
single-level small sample reports its level with low confidence; a mixed sample
without a majority lower bound is disputed. Protection and status are returned
separately with the full distribution and the viewer's own judgment. The declared
default concept hint is `unknown`, which protects unseen Statements as hide-any.
An authorized Statement-decision curator can declare a Global or Realm concept
hint through the API. That declaration is versioned and used only when the
spoiler sample is empty. A Global hint never enters a Realm population.

Each successful judgment revision advances one aggregate generation and inserts
one immutable Access outbox invalidation in the same transaction. The bounded
badge projection consumes the latest invalidation for one Statement/population
through `content-publication/projection-recipes.ts`. It records the source event,
aggregate generation, concept hint generation and policy generation. The read
API invokes that consumer; search can call `checkJudgmentProtection` from
`protection.ts` for an exact supporting Statement before showing a derived match
or snippet. It returns protection with its source generation and fails closed if
the aggregate's latest event is missing.
Migration 231 inserts one baseline event per nonempty migration-230 aggregate;
it does not infer a historical event order. Later writes emit individual events.

## Cost contract

- A judgment write performs one Account verification, at most two bounded Jena
  reads for Statement and acceptance, and one Access transaction with indexed
  point lookups and constant row mutations. One aggregate-row lock serializes
  concurrent voters on that target and context. No current-voter scan occurs on
  write. A replay uses the Account verifier and one indexed receipt lookup.
- A summary read performs one Account verification, bounded Statement and
  acceptance reads, a latest-event badge projection (one indexed aggregate,
  outbox and hint lookup, one upsert), and two Access point lookups in a
  consistent snapshot. The result has fixed size, independent of voters in the
  population. The aggregate update is O(1) per changed dimension; immutable
  history and outbox storage are O(writes).
- Hint declaration uses one Account verification, indexed Access curator proof,
  and one concept/head CAS with an immutable idempotency receipt. Badge checks
  for search are one exact target and population, with no voter scan. A search
  caller must cap supporting Statements per response and carry the returned
  generation with each protected derived result.
- The integration test inspects the aggregate primary-key plan, concurrent
  independent revisions, exact replay, one outbox event per generation, badge
  consumption, no-vote hint use and unchanged Global counts after a Realm write.
  Physical Jena work and Account network bytes remain unmetered in this scoped test.
