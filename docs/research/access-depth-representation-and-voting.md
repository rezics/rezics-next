# Access depth, organizational representation and voting authority

Reviewed 2026-09-22. The selected design combines typed relationship
authorization, scoped representation and separately conserved voting entitlements.
The [identity/access](../contracts/identity-and-access.md),
[Realm participation](../contracts/realm-participation.md),
[voting](../contracts/votes-and-references.md) and
[governance](../contracts/governance-rules.md) contracts own the semantics. The
[identity acceptance](../testing/identity-and-access.md) and
[governance acceptance](../testing/governance-and-delivery.md) pages own detailed
outcomes; the [recorded backend qualification](../plan/qualification.md)
identifies their tested scope. Current API paths live under
`services/main/src/modules/access/` and `services/main/src/modules/vote/`.

## Why representation and voting remain separate

An organization can hold rights on another organization. A person may exercise
them only through an admitted representation path for the named operation and
target. Membership, profile editing, an administrative title and a Realm's local
moderation role do not themselves grant that path. This preserves independent
organizations even when they participate in or are managed by a Realm. A Realm
may govern its publication context without acquiring the organization's global
identity, roster or ballot. Explicit managed grants can confer selected powers.

Authorization asks whether a complete valid proof exists. Voting asks which
holder owns each unit, whether a representative may operate its ballot, and
whether those units were already allocated or counted. If an organization owns
100 units, two representatives still operate one entitlement; neither receives
100 new units. Allocation and proxy voting require separate electorate and
charter choices. Ordinary administration cannot silently create voting weight.

This distinction follows the separate mechanisms in
[RT](https://www.cs.purdue.edu/homes/ninghui/papers/rt_discex03.pdf) for
autonomous institutional roles and
[SPKI](https://www.rfc-editor.org/rfc/rfc2693.html) for attenuated delegation.
Neither supplies our ordered deny policy or voting ledger. Theoretical
[liquid-democracy limits](https://ojs.aaai.org/index.php/AAAI/article/download/11468/11327)
and a [historical deployment study](https://arxiv.org/abs/1503.07723) give
different perspectives on concentrated delegation. We therefore select one
organizational ballot by default; full liquid routing needs its own governance
and scale qualification. [OpenZeppelin Votes](https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.4.0/contracts/governance/utils/Votes.sol)
also demonstrates that delegation need not recursively forward received votes.

## Alternatives and evidence limits

| Alternative | Why it was not selected as the general default |
| --- | --- |
| Universal Realm → Organization → Team → Person inheritance | Conflates participation, sovereignty, management and representation. |
| Recursive administrator closure | Makes unrelated management grants compose into authority without an admitted representation path. |
| Flatten all effective rights onto accounts | Loses institutional provenance and makes controller changes broad rewrites. |
| Distributed capability chains or a specialized ReBAC engine | Remain credible for qualified needs, but neither defines ordered policy, revocation, organizational governance or conserved voting units. |

The [2026-09-22 depth probe](../../scripts/research/access_backend_comparison/expanded.py)
ran 15 repeated positive checks per depth with reused clients. At depths 1 and
16, median milliseconds were respectively PostgreSQL 0.064/0.113,
SpiceDB/PostgreSQL 0.453/0.460, OpenFGA/PostgreSQL 0.763/3.772 and the now
retired Fluree/Main path 0.661/0.729. The
[raw results](../../scripts/research/access_backend_comparison/evidence/2026-09-22/expanded-original-query.json)
and [environment](../../scripts/research/access_backend_comparison/evidence/2026-09-22/environment.json)
are retained. This small, local, tmpfs, linear-chain probe did not test
Fuseki/TDB2, branching, cycles, current production policies, concurrent load or
p99 latency. Its numbers do not rank the engines for REZICS capacity.

Depth alone cannot bound work: breadth, alternate paths, policy states, reads,
freshness and invalidation cost also matter. The
[Access workload profile](../storage/workloads/identity-access-capacity.md)
records starting experimental limits and the dimensions still requiring
measurement. [Zanzibar](https://www.usenix.org/system/files/atc19-pang.pdf),
[SpiceDB](https://authzed.com/docs/spicedb/modeling/recursion-and-max-depth)
and [OpenFGA](https://openfga.dev/docs/best-practices/running-in-production)
show why traversal guards, concurrency controls and indexing are useful; their
published numbers do not qualify this application's latency or freshness.

The requested **99% task coverage is a product target, not a measured result**.
There is no representative REZICS task distribution or usability observation to
establish it. Measure weighted legitimate tasks completed with supported semantics
against attempted tasks, broken down by task family and tenant size; measure
latency and availability separately. Security and entitlement conservation apply
to every admitted operation, regardless of that coverage target. Fully liquid
delegation, live fractional routing and arbitrary multi-parent authority remain
prospective profiles requiring distinct semantic and load qualification.
