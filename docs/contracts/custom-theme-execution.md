# Executable Zone themes

Declarative Zone presentations remain useful and accessible when code cannot
run. Executable code needs a separate approval because it can affect readers,
performance and the host application's authority.

The current `worker-isolated-v1` activation pins a digest, bounded capabilities,
an HTTPS origin and an expiry. Its approval is monotone and cannot be restored
by rolling back an older revision. It does not yet execute a package or prove
that the named bytes passed an independent review.

The `first-party-bundle-v1` manifest bounds files, slots and origins and binds
one host Zone; it does not grant execution. An in-page package shares the
reader's application origin, so
staff review, named slots, byte budgets, a complete declarative fallback,
reader opt-out and immediate revoke controls are prerequisites. Partner code
needs an isolated origin or worker and a separate qualification.

The [theme review and incident runbook](../operations/custom-theme-review-and-incident-response.md)
records the human checks and response decisions.
