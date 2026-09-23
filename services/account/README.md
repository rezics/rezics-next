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
# Enable authenticated account deletion after Access migrations 001–006:
export ACCOUNT_ACCESS_DATABASE_URL=postgres://user:password@127.0.0.1:5432/access
corepack yarn workspace @rezics/account exec bun src/migrate.ts
corepack yarn account:dev
```

Set `ACCOUNT_OPERATOR_USER_IDS` to a comma-separated list of verified private
Better Auth user IDs allowed to manage OAuth clients and resources. Its default
is empty and denies those mutations. Register and verify an operator identity
before setting this value. Dynamic client registration is disabled. Clients
requesting Main access must be registered by an operator; the first resource
profile admits `openid`, `offline_access`, `work:create`, `work:edit` and
`work:read`; Main resource access tokens expire after five minutes. Main must
be configured with the issuer from OIDC discovery, its JWKS
URL, the Main resource audience and a confidential introspection client linked
to that resource. OAuth scope does not replace Access representation or grants.

Authenticated `/api/auth/delete-user` is enabled only when
`ACCOUNT_ACCESS_DATABASE_URL` is configured. Better Auth's
[user deletion path](https://better-auth.com/docs/concepts/users-accounts)
requires a fresh session or the user's password. Its `beforeDelete` hook first writes Access's
durable principal deactivation fence; an unavailable Access owner returns 503
and leaves the Account user intact. Operator IDs and users owning OAuth clients
must transfer those responsibilities before deletion. The pinned Better Auth
deletion path removes the user, sessions and OAuth token rows. Main's current
introspection and Access checks then deny old assertions. A Work reconciliation
pass must still seal any pending admissions under the Access fence. This is a
first logical credential deletion path, not physical removal from WAL/backups
or complete cross-owner erasure. Better Auth's [OAuth provider documentation](https://better-auth.com/docs/plugins/oauth-provider)
states that `offline_access` refresh tokens can survive sign-out; the local
deletion test checks their removal separately.

`GET /health/live` checks the process and `GET /health/ready` checks PostgreSQL.
The Better Auth handler serves `/api/auth/*`, including OIDC discovery at
`/api/auth/.well-known/openid-configuration` and JWKS at `/api/auth/jwks`.
The [integration result](tests/evidence/2026-09-24-account.xml) runs disposable
PostgreSQL, applies the version-pinned schema, creates a session, registers two
operator-managed clients, issues service and user resource-bound JWTs, and has
Main verify them against live JWKS and introspection. An authorization code with
PKCE is exchanged; signing out makes the user's still signed token inactive
at introspection. A separate member's deletion removes an offline refresh token;
an unavailable Access fence and attempted operator/client owner deletion keep
their users intact. This qualifies a first Account/Main protocol path, not the
remaining recovery, consent UI, method linking, multi-product SSO, physical
erasure or full Access admission lifecycle. The [plan](../../docs/plan/README.md#active-execution)
tracks those gates.

The [Account WAL recovery result](tests/evidence/2026-09-24-account-pitr.xml)
restores a verified PostgreSQL 18.6 base backup after sign-out and a separate
member deletion. A separately archived WAL segment preserves both mutations:
Main's current introspection denies both still-signed resource tokens after the
isolated Account service restarts, and the deleted member's user and offline
refresh rows remain absent. Omitting that segment makes both old tokens active
again and restores the deleted member and refresh row in the isolated drill.
The shared [PostgreSQL frontier CLI](../main/src/pg-recovery-frontier.ts)
rejects the incomplete replay and accepts the full replay.
The [Account recovery manifest CLI](src/recovery-manifest.ts) also digests all
12 pinned Better Auth 1.7.5 public tables in a UTC repeatable-read snapshot.
It rejects an unexpected table set, missing sign-out WAL, or restored rows that
differ from the retained snapshot. Its HMAC envelope rejects modified content
and the wrong key. Stop Account and other database writers before capture; store
the private JSON and an independent random 32-byte hex key in separate protected
custody outside the owner and backup, then verify only against an isolated
completed restore:

```sh
export RECOVERY_MANIFEST_HMAC_KEY=replace-with-64-random-hex-characters
ACCOUNT_RECOVERY_DATABASE_URL="$ACCOUNT_DATABASE_URL" bun services/account/src/recovery-manifest.ts capture > "$RECOVERY_MANIFEST_DIR/account.json"
ACCOUNT_RECOVERY_DATABASE_URL="$RESTORED_ACCOUNT_DATABASE_URL" bun services/account/src/recovery-manifest.ts verify "$RECOVERY_MANIFEST_DIR/account.json"
```

Keep Account unrouted until the retained current revocation/deletion frontier and
archive coverage are verified. The deletion hook in this Account-only WAL drill
uses a recorded Access callback; the separate full Work test exercises the real
Access fence. A coordinated two-owner restore and erasure replay remain untested.
This local test does not qualify off-host WAL custody or a production recovery objective.

The [two-owner deletion recovery result](tests/evidence/2026-09-24-account-access-recovery.xml)
records a separate Account and Access PostgreSQL WAL drill. After an authenticated
member deletion, the [recovery set CLI](src/deletion-recovery-set-cli.ts) captures
both owners' WAL frontiers, Account/Access row coverage and the matching private principal
fence. It requires no pending admissions for that principal. An older copy of
either owner fails verification; full replay of both passes. The CLI requires
`RECOVERY_MANIFEST_HMAC_KEY`, a retained random 32-byte hex key stored separately from
the private recovery set, to detect manifest changes. Access retains a separate
private deletion intent, and graph hold release requires one authenticated set
for each retained intent. Run `capture` only
after both owners are quiesced, retain its private JSON outside their backups,
and run `verify` on isolated completed restores before routing. The commands and
remaining graph/journal limits are in the [recovery runbook](../../docs/operations/recovery.md#postgresql-wal-recovery-boundary).
With `REZICS_FUSEKI_HOME` and `REZICS_JAVA_HOME` set, this drill also restores a
stopped Fuseki graph control cut, verifies its recovery hold, releases it against
the authenticated two-owner set and a separate relay checkpoint, then verifies
graph admission reopens. That graph cut has no Work outcomes.
Graph hold release now compares the restored Account database's complete pinned
Better Auth row digest with the authenticated source coverage on every release.
The two-owner drill rejects an older Account cut before graph release even when
Access and the retained relay journal are current.
