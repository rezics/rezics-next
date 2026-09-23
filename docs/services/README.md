# Service implementation designs

[Account](account.md), [Access](access.md), [Main](main.md),
[package runtime](package-runtime.md) and [workers](workers.md) have explicit
ownership boundaries. Access initially runs inside Main through an in-process
interface. [Architecture](../architecture/services.md) owns these authority and
placement relationships; sharing an executable does not merge private data ownership.

Each service has typed runtime-validated interfaces, its own credentials,
versioned storage/operation contracts, health, metrics and recovery procedures.
No cross-service call silently bypasses the receiving owner's domain command.

The target graph dependency is Apache Jena Fuseki + TDB2 + jena-text/Lucene.
Main uses TypeScript/Elysia 2 on Bun and accesses Fuseki over HTTP; Account/Access retain private
PostgreSQL. The [graph quickstart](../operations/installation.md) can be followed
independently, but this checkout does not yet include these runnable business
services. A polling outbox and participating owner processes are sufficient for
bootstrap; Redis and a broker are optional later additions.
