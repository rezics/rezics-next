# System invariants

Model commands as state transitions with explicit authority, input references,
preconditions, local atomic effects and durable cross-owner work. A failed command
cannot leave an accepted partial state. Each owner proves its transitions preserve
these invariants and includes cross-owner cases when dependencies are available.

| ID | Invariant |
| --- | --- |
| I01 | References preserve the correct resource/component/occurrence grain and resolve or return an explicit unavailable/tombstone state. |
| I02 | Existing identity, immutable revision meaning and sealed selections are never silently retargeted, including by additive mutation of an old revision. |
| I03 | A single-valued selection has at most one effective accepted result; conflict and no-selection are explicit. |
| I04 | Publication/selection does not disclose private heads or undeclared embedded assets. |
| I05 | Current authority, admission fences and delivery rules apply to protected effects and derived disclosures. |
| I06 | Human confirmation and independent support survive unrelated source withdrawal. |
| I07 | Occurrence, reply origin and source correspondence survive rearrangement and correction. |
| I08 | Staging, editorial protection, sealing and topology remain valid under concurrent commands; content and protection/decision bases are checked atomically at their owner. |
| I09 | Votes, membership, quotas and effects obey their declared uniqueness/accountability rules. |
| I10 | Retries have one effective operation; stale workers cannot activate results. |
| I11 | Erasure and retention cover history, projections, delivery and recovery without resurrection. |
| I12 | Foreground and recurring work are bounded; LIMIT is not proof of bounded execution. |
| I13 | Missingness, precision, language, uncertainty, context and source losses remain explicit. |
| I14 | Work, Main Version, external release, contribution, occurrence, account and public Agent remain distinct. |

## Resource capabilities

Logical owners declare identity/lifecycle and admitted capabilities independently
of semantic class and physical placement. Generic operations validate eligible
reference alternatives and current owner state. No universal parent table or
classification-based privilege is introduced. [Semantic model](semantic-model.md)
owns reference/value representation; [placement](../storage/ownership-and-placement.md)
owns writer fencing and movement.

## Transaction, event and job protocols

[Editorial protection](editorial-protection.md) applies I02/I05/I06/I08/I10 to
source takeover, reviewed corrections and immutable histories. Access admission
and owner-local modification protection are distinct checks. Protection does not
assert evidence quality; [verification](information-verification.md) preserves
support, dispute, uncertainty and freshness under I13. Erasure and restoration
must preserve those boundaries under I11 without turning missing protection into
an editable default.

[Commands](commands.md) defines local mutation/receipt/outbox atomicity, explicit
cross-service workflows and authority fences. [Events/jobs](events-and-jobs.md)
defines transport, continuation and recovery. A broker ACK, graph commit counter,
schema declaration or generated SDK alone never establishes a business success.

## Qualification

[Testing](../testing/README.md) maps prospective scenarios to these invariants.
The initial gate targets correctness and bounded behavior on available machines;
large-volume estimates remain separate from executed performance evidence.
