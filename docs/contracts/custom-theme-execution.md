# Executable Zone themes

Declarative Zone presentations remain useful and accessible when code cannot
run. Executable code needs a separate approval because it can affect readers,
performance and the host application's authority.

The current `worker-isolated-v1` activation pins a digest, bounded capabilities,
an HTTPS origin and an expiry. Its approval is monotone and cannot be restored
by rolling back an older revision. It does not yet execute a package or prove
that the named bytes passed an independent review.

The `first-party-bundle-v1` manifest bounds files, slots and origins and binds
one host Zone. Its revision is immutable. A different subject records a review
decision and an evidence digest before the owner can activate that revision.
The public Zone read evaluates the reviewed revision, host binding, expiry,
revocation and global execution generation on each request. Active responses
are not cached; the declarative presentation remains available for safe mode
and reader opt-out. Killing and later reopening execution requires a fresh
activation; an old approval cannot resume.

The backend records manifest digests and the review decision. It does not
fetch built assets or prove that their bytes match the manifest. The reviewer
must verify those bytes before recording a decision. An in-page package shares
the reader's application origin, so the host must check each fetched asset
against its approved digest before execution. Partner code needs an isolated
origin or worker and a separate qualification.

The [theme review and incident runbook](../operations/custom-theme-review-and-incident-response.md)
records the human checks and response decisions.
