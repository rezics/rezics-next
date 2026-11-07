# Maintenance

Use the newest feasible dependency versions. Prereleases are eligible when compatible and useful. Production
PostgreSQL uses an accepted RC or GA; betas belong in development or staging.

Check current upstream guidance before adopting an upgrade. Pin the result, inspect its changes and verify affected
contracts. Coordinate broad lockfile changes with other writers.

Decision: when a failure traces to an outdated dependency, fix it by upgrading that dependency. This needs no further
approval at any scope: a major version, the toolchain, the runtime, a container image or a database engine within the
PostgreSQL rule above. Brief it as an urgent repair that names the failure, the version the fix needs and the
upstream change that provides it. Do not add a local workaround for a defect that a newer release fixes.

Prefer an upstream fix to a local patch. A necessary patch identifies its defect, reproducer, acceptance and removal
condition. Apply dependency patches through the package manager. Never modify cache-shared node_modules in place.

A recurring chore has:

- repository state recording the last completion;
- an idempotent overdue check;
- one deduplicated issue;
- a procedure in its owner's README;
- an ordinary reviewed task that closes the issue.

Scheduled automation may detect work; it does not silently perform the upgrade. The UI shadcn process is the existing
example.

Keep hosts, credentials, accounts, allowances, contacts and local process configuration outside Git. Document supported
configuration interfaces without private values.

Stop processes through owned task handles or a verified PID and start identity. Do not kill pattern matches or other
tasks' containers. A lost tool handle is not proof that a process ended.

Escalate a repeated infrastructure signature: two attempts, or one attempt plus another manager's matching report
within an hour. Include the exact error and affected environment through the private operating channel. Product work
integrating into dev is retried without waiting for that escalation; other work waits for it before further retries.

Functional Goals deliver the repository's complete scoped behaviour. Record external launch conditions without
scheduling private provisioning or account work. Product safety, disclosure and erasure remain functional requirements.
