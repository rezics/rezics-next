# Kernel

The kernel workspace owns the database records and adapters used by the service.

## Development database

Run `bun run db up` from `services/kernel` to create or start the local PostgreSQL database, apply migrations, and write
its connection string to `.env`. Use `bun run db down` to stop it while keeping its volume, `bun run db reset` to remove
and recreate the database, and `bun run db dump` to update the committed schema dump. Dumps run `pg_dump` inside the
running database container, using its PostgreSQL version. The check command uses its disposable database container;
the development dump command uses the local development container. Callers that do not set `KERNEL_DATABASE_CONTAINER`
retain the `docker run` fallback.

## Development search node

Run `bun run search up` from this workspace to create or start the local OpenSearch node and write `OPENSEARCH_URL`
to `.env`. Use `bun run search down` to stop it while keeping its volume, or `bun run search reset` to remove and
recreate it. The check command starts its own disposable OpenSearch node.

## Run the kernel

Run `bun run db up`, then `bun run dev` from this workspace to serve the API locally. The server reads
`DATABASE_URL` (required), `KERNEL_ROUTE_KEY` (required), and `KERNEL_SESSION_KEYS` (required) from the environment.
`KERNEL_HOSTNAME` defaults to `127.0.0.1` and `KERNEL_PORT` defaults to `4100`. `db up` generates the development
secrets once and keeps them in `.env` across restarts.

Bearer tokens are verified against the Auth service. The first request that carries one reads `AUTH_ISSUER`
(the Auth service's canonical origin), `AUTH_AUDIENCE` (the API's HTTPS URL) and `AUTH_JWKS_URL` (the Auth
service's public JWKS URL, on the exact issuer origin). Without them the kernel still starts and serves anonymous
requests, and refuses every bearer token.

Issuers require HTTPS except for canonical HTTP origins on exactly `127.0.0.1`,
`localhost` or `[::1]`, including the configured port. Issuers have no userinfo,
path, trailing slash, query or fragment. Numeric aliases, suffix tricks, other
private/LAN addresses and `0.0.0.0` are rejected. HTTP public JWKS is permitted
only for an approved HTTP issuer on the exact same origin and port, with no
userinfo, query or fragment. Token issuer identity includes the port; request
Host headers do not configure it. The API audience remains HTTPS, including for
local issuers: `https://api.rezics.com` in production without a trailing slash,
and `https://api.rezics.test` in tests. Verification still uses standard JOSE,
cached public keys and current account state, epoch floor and fence checks;
failures retain the `invalid_token` response.

## Check

Run `bun run check` from this workspace. It starts a disposable PostgreSQL database, applies migrations and checks the
schema dump, runs TypeScript, lint and formatting checks, then runs each test file on its own copy of the migrated
database. A plain `bun test` shares one database across files, so run a single file when not running the check. The test
database is removed at the end.

## HTTP contract

When the HTTP contract changes, regenerate both `contracts/openapi.json` with `bun run openapi` and the client
declarations with `bun run client` while the development database is up. Tests fail while either generated contract is
stale.

Register AIP-136 custom methods with `customMethod(resourcePath, verb)` from `src/http/custom-method.ts`, then use
that path with `.post(...)`. The resource path must not end in `/` and the verb must match `^[a-z][A-Za-z0-9]*$`
(lowerCamelCase). For example, `customMethod('/v1/media/:id', 'complete')` registers `/v1/media/:id/$complete`
internally and serves `POST /v1/media/{id}:complete`; `customMethod('/v1/subjects', 'merge')` serves
`POST /v1/subjects:merge`. Every app from `createApp` translates the last literal colon in the last path segment
when its suffix is a registered custom verb. Parameters can contain colons; `%3A` never acts as the separator.
Internal `/$` paths return `404 not_found`. OpenAPI uses the public AIP paths. Eden exposes custom methods as
`client.media({ id }).$complete.post(body)` or `client.subjects.$merge.post(body)` and the client fetcher sends
them to their public AIP paths.

## Database changes

Kernel-owned migrations live in `db/migrations/` and their dump lives in `db/schema.sql`. Each module has its code and
authoritative SQL statements in `src/<module>/`, its migrations in `db/<module>/migrations/`, and its dump in
`db/<module>/schema.sql`. A module exists when its migrations directory exists, and its tables live in the PostgreSQL
schema with the module's name. The module owner edits `src/<module>/`, `db/<module>/`, and that module's tests.

Migration versions use UTC timestamps in `YYYYMMDDHHMMSS_<name>.sql` form and are unique across all migration
directories. `0001_core_partition.sql` keeps its name and sorts first. Dbmate applies pending migrations from every
directory in version order, so a module migration may merge behind a newer migration from another directory. Once a
migration is merged, never rename or edit it. Run `bun run db dump` to update and commit every schema dump.

Only kernel migrations create PostgreSQL extensions. A module that needs an extension asks the kernel to install it;
module migrations may use extensions but must not create them.

DBOS Transact keeps its system tables in the `dbos` schema, created and upgraded by its own migrations when `migrate`
runs, and left out of the schema dumps.

A 16-bit route value maps to its partition by taking the top 12 bits.

Every SQL statement is stored in one reylo-typed `.sql` file and run through `pg` from an adapter module (ADR-0026).
Every statement the kernel sends is a `.sql` file under `src/`, typed by reylo and checked for partition binding.
TypeScript sends only transaction control (`BEGIN ISOLATION LEVEL …`, `SET LOCAL …`, `COMMIT`, `ROLLBACK`).
