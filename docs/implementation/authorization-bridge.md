# Access-to-Jena authorization bridge

Account authenticates the principal. Main's Access module owns current
representation, grants, policy decisions and admission fences in PostgreSQL.
Main selects content and enforces disclosure; Jena commits guarded graph effects.
These owners have separate transactions even when they share a host. A verified
Account assertion, a historical graph receipt or Fuseki endpoint authentication
cannot stand in for current Access authority. Raw Fuseki query and update surfaces
must remain internal.

An admitted command binds its actor, scope, authority proof, request identity,
content target and finite execution boundary. Jena can test graph preconditions
and commit an effect receipt, but cannot transactionally lock PostgreSQL authority.
The Access admission registry therefore fences new dispatch and retains uncertain
work until a terminal graph receipt or cancellation is reconciled. Strong
revocation closes new admission and waits for affected work to reach that terminal
state; a timeout or missing reply cannot prove that an effect did not commit.
See the [Work revocation owner](../../services/main/src/modules/work/strong-revoke.ts)
and [fault tests](../../tests/qa/fault-recovery/sys-revocation.test.ts).

Queries need current authority for every protected value that can influence
matching, ranking, counts or output. A content revision does not preserve the
reader's old permission. Private delivery also has a separate network boundary:
an armed send with no matching peer receipt is possible delivery, including
after a socket closes. The [search contract](../contracts/search.md) describes
the currently supported private Contribution phrase profile and its limits.

The remaining general private-field and mixed-scope query profiles require
their own pre-match disclosure, freshness, and recovery qualification. The
[identity cases](../testing/identity-and-access.md) and
[search cases](../testing/search.md) retain those acceptance requirements.
