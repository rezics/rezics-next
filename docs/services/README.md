# Service implementation designs

[Account](account.md), [Access](access.md), [Main](main.md),
[package runtime](package-runtime.md) and [workers](workers.md) have explicit
ownership boundaries. Access initially runs inside Main through an in-process
interface. [Architecture](../architecture/services.md) owns these authority and
placement relationships; sharing an executable does not merge private data ownership.

Each service has typed runtime-validated interfaces, its own credentials,
versioned storage/operation contracts, health, metrics and recovery procedures.
No cross-service call silently bypasses the receiving owner's domain command.
