# Service boundaries and dependency contracts

Account remains a separate process because credentials, sessions and OAuth
protocol grants are private identity authority.
[Access](../contracts/identity-and-access.md) remains a separately owned private
model inside Main: extracting it needs a measured consumer,
isolation or scaling reason, not an assumption that every logical boundary
needs RPC. [Access placement research](../research/access-storage-and-policy.md)
records that threshold.

Content is a Main-owned PostgreSQL module. Main's semantic owner writes Jena;
workers and package runtime submit owner commands instead of editing those
facts. Derived search and other projections have no independent editorial
authority. These boundaries allow each owner to commit its own receipt and
outbox while cross-owner publication reconciles exact references. The
[storage placement decision](../storage/ownership-and-placement.md) explains
the initial one-dataset choice.

The executable process and route topology lives in
[Main](../../services/main/src/app.ts),
[Account](../../services/account/src/app.ts),
[Content](../../services/content/src/index.ts) and
[AppHost](../../apphost/). Typed dependencies in
[Main's route interface](../../services/main/src/routes/dependencies.ts)
and the repository's import rules carry module boundaries. No cross-service
call bypasses the receiving owner's domain command, and sharing an executable
does not merge private data ownership. A polling outbox inside an owner process
is enough for the first relay and workers; Redis, a broker or an independent
worker fleet are later additions when fan-out or isolation needs them. The
[Account service](../services/account.md) records its own operating procedures.

Service separation is independent of machine placement. The
[deployment assessment](../operations/deployment.md) selects a starting host
layout. Moving a process does not move its authority or make a private table
an implicit cross-owner API.
