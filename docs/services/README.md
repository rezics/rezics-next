# Service implementation designs

[Account](account.md), [Access](access.md), [Main](main.md),
[package runtime](package-runtime.md) and [workers](workers.md) are the initial
independent boundaries. [Architecture](../architecture/services.md) owns their
authority relationships; deployment can co-locate them without merging ownership.

Each service has typed runtime-validated interfaces, its own credentials,
versioned storage/operation contracts, health, metrics and recovery procedures.
No cross-service call silently bypasses the receiving owner's domain command.
