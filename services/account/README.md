# Account startup and first OAuth boundary

Account uses Bun 1.4.2, Elysia 2.0.0-beta.16, Better Auth 1.7.5 with the
OAuth provider plugin and a separate PostgreSQL database. The service listens
on loopback. `ACCOUNT_BASE_URL` is its externally visible issuer origin;
`ACCOUNT_MAIN_RESOURCE` is the absolute Main resource identifier that clients
request in the OAuth `resource` parameter. For a local disposable database:

```sh
export ACCOUNT_BASE_URL=http://127.0.0.1:3002
export ACCOUNT_MAIN_RESOURCE=https://main.rezics.test
export ACCOUNT_SECRET=replace-with-a-random-secret-of-at-least-32-characters
export ACCOUNT_DATABASE_URL=postgres://user:password@127.0.0.1:5432/account
corepack yarn workspace @rezics/account exec bun src/migrate.ts
corepack yarn account:dev
```

Set `ACCOUNT_OPERATOR_USER_IDS` to a comma-separated list of verified private
Better Auth user IDs allowed to manage OAuth clients and resources. Its default
is empty and denies those mutations. Register and verify an operator identity
before setting this value. Dynamic client registration is disabled. Clients
requesting Main access must be registered by an operator; the first resource
profile admits `openid`, `work:create`, `work:edit` and `work:read`, and Main resource access tokens expire
after five minutes. Main must be configured with the issuer from OIDC discovery, its JWKS
URL, the Main resource audience and a confidential introspection client linked
to that resource. OAuth scope does not replace Access representation or grants.

`GET /health/live` checks the process and `GET /health/ready` checks PostgreSQL.
The Better Auth handler serves `/api/auth/*`, including OIDC discovery at
`/api/auth/.well-known/openid-configuration` and JWKS at `/api/auth/jwks`.
The [integration result](tests/evidence/2026-09-24-account.xml) runs disposable
PostgreSQL, applies the version-pinned schema, creates a session, registers two
operator-managed clients, issues service and user resource-bound JWTs, and has
Main verify them against live JWKS and introspection. An authorization code with
PKCE is exchanged; signing out makes the user's still signed token inactive
at introspection. This qualifies a first Account/Main protocol path, not the
remaining recovery, consent UI, method linking, multi-product SSO, erasure or
full Access admission lifecycle. The [plan](../../docs/plan/README.md#active-execution)
tracks those gates.

The [Account WAL recovery result](tests/evidence/2026-09-24-account-pitr.xml)
restores a verified PostgreSQL 18.6 base backup after sign-out. A separately
archived WAL segment preserves the sign-out: Main's current introspection denies
the still-signed resource token after the isolated Account service restarts.
Omitting that segment makes the old token active again in the isolated drill.
The shared [PostgreSQL frontier CLI](../main/src/pg-recovery-frontier.ts)
rejects the incomplete replay and accepts the full replay.
The [Account recovery manifest CLI](src/recovery-manifest.ts) also digests all
12 pinned Better Auth 1.7.5 public tables in a UTC repeatable-read snapshot.
It rejects an unexpected table set, missing sign-out WAL, or restored rows that
differ from the retained snapshot. Stop Account and other database writers before
capture; store the JSON outside the owner and backup, then verify only against an
isolated completed restore:

```sh
ACCOUNT_RECOVERY_DATABASE_URL="$ACCOUNT_DATABASE_URL" bun services/account/src/recovery-manifest.ts capture > "$RECOVERY_MANIFEST_DIR/account.json"
ACCOUNT_RECOVERY_DATABASE_URL="$RESTORED_ACCOUNT_DATABASE_URL" bun services/account/src/recovery-manifest.ts verify "$RECOVERY_MANIFEST_DIR/account.json"
```

Keep Account unrouted until the retained current revocation frontier and archive
coverage are verified. This local test does not qualify off-host WAL custody,
cross-owner erasure, or a production recovery objective.
