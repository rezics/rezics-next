# Proposal execution

The first executable proposal capability is `access.org.roster.policy`. The
client supplies the complete G-017 payload and exact proposal, revision and
resolution. Canonical JSON SHA-256 binds the payload and Access policy state to
the approved graph revision. Access migration 072 stores the executor mandate
and body's active capability grant; migration 220 reserves one execution per
proposal revision. The G-017 receipt is recovered before any mutable state read.
The graph completion validates the registered proposal profile, records the
resulting policy revision and seals the Access admission. A retry with the same
operation ID returns the saved policy revision and graph receipt.

## Cost contract

One execution reads one proposal revision and resolution, one body mandate and
capability grant, one organization policy row, one managed grant and recipient
representation, one G-017 history/receipt row and one graph execution receipt.
All selections use exact keys. It does not visit voters, organization members
or other proposals. Admission is O(1) in corpus size; the graph command matches
one proposal, poll and resolution. The GOV23 integration case exercises denied,
stale, concurrent and recovered calls and asserts one policy history write per
accepted effect. The manager's wave should include native plan/counter evidence
at larger background sizes before full workload qualification.
