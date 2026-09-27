# REZICS Main service

The [service boundary](../architecture/services.md) explains why Main hosts
semantic, [Access](../contracts/identity-and-access.md) and Content owners. The [application](../../services/main/src/app.ts)
registers routes; its [typed dependencies](../../services/main/src/routes/dependencies.ts)
and [storage adapters](../../services/main/src/infrastructure/) carry request
and failure contracts. [Readiness qualification](../../tests/qa/integration/main-readiness.test.ts)
exercises the deployed command module and dependent stores.

## Runtime and framework

The [toolchain lock](../development/toolchain.md) pins Bun, Elysia and the
runtime images. The [stack comparison](../research/application-stack.md)
records their selection and qualification limits.
