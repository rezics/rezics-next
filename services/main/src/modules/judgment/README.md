# Statement judgment owner

Access migration 230 owns the private principal key, two independent dimension
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

## Cost contract

- A judgment write performs one Account verification, at most two bounded Jena
  reads for Statement and acceptance, and one Access transaction with indexed
  point lookups and constant row mutations. One aggregate-row lock serializes
  concurrent voters on that target and context. No current-voter scan occurs on
  write. A replay uses the Account verifier and one indexed receipt lookup.
- A summary read performs one Account verification, bounded Statement and
  acceptance reads, and two Access point lookups in a consistent snapshot. The
  result has fixed size, independent of voters in the population. The aggregate
  update is O(1) per changed dimension; immutable history storage is O(writes).
- The integration test inspects the aggregate primary-key plan, concurrent
  independent revisions, exact replay and unchanged Global counts after a Realm
  write. Physical Jena work and Account network bytes remain unmetered in this
  scoped test.
