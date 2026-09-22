# Resource lifecycle and platform operation

## Lifecycle contracts

Every owner declares creation, activation, publication where applicable,
withdrawal, retirement, tombstone, recovery and erasure states. A Resource type
does not select one universal state machine. Capability retirement preserves
identity and other admitted capabilities. Missing, private, retired and erased
results have explicit disclosure-safe semantics.

## Installation and reserved identities

Fresh installation creates the selected vocabulary/profile registry, platform
authority, necessary service identities and initial policy through idempotent
provisioning. Reserve stable platform identifiers and verify their meaning before
reuse. Do not infer user content from bootstrap defaults or reset user-owned
policy on ordinary startup. Secrets are provisioned separately and never printed
as routine health or installation output.

## Operations

Create and activate with owning commands; change ownership with current control
and continuity checks; retire with bounded dependent-impact discovery; recover
through a new validated transition. Platform intervention is a separate permission
and attributable case, not an unrestricted impersonation shortcut.

Readiness checks required owner dependencies and installed contract versions;
liveness does not require downstream network calls. Search/delivery degradation
is separate from durable-write availability. New installation and disaster recovery
have independent runbooks and must not be conflated.

## Erasure and replay

Erasure advances a durable suppression epoch before asynchronous deletion from
graph history where supported, payloads, derivatives, caches and deliveries.
The recovery manifest and replay checks preserve that frontier. Retraction alone
does not prove byte erasure. See [recovery](../operations/recovery.md).
