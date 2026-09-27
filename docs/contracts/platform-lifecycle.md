# Resource lifecycle and platform operation

Each owner defines its own creation, activation, withdrawal, retirement,
recovery and erasure transitions. Capability retirement preserves identity and
other admitted capabilities. Missing, private, retired and erased reads need
distinct disclosure-safe results. Platform intervention requires an attributable
permission, not unrestricted impersonation.

Fresh provisioning must verify reserved platform identities and installed
profiles before reuse, without resetting user-owned policy. Secrets are
provisioned separately. Liveness does not prove owner readiness; search
degradation must be visible separately from durable-write availability. New
installation and disaster recovery follow distinct procedures.

Erasure must advance a durable suppression frontier before asynchronous
deletion. Restores and replay check that frontier; retraction alone does not
prove byte destruction. See [erasure](../operations/erasure.md) and
[recovery](../operations/recovery.md).

These cross-owner lifecycle and reserved-identity obligations remain prospective
where an owner has no executable transition or bootstrap assertion yet.
