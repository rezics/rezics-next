import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { SeedApi } from './api.ts';
import type { LocalOperatorInput } from './operator.ts';

// Fixture-only authority for the official Realms' public profiles. Main has no
// site UI or grant API for `realm.profile.publish` and `realm.moderator.choose`
// yet (apps/web/features/auth/scopes.ts leaves `realm:profile` unrequested),
// so the demo grants them to exact Realm scopes, as operator.ts does for Zone
// edits. The profile and each moderator's public choice still go through Main.

const PROFILE_CLIENT = 'Local official Realm profile seed';
const PROFILE_SCOPE = 'openid realm:profile realm:public-role';

function loopback(value: string) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Seed Realm profile setup requires a loopback database');
  }
}

/**
 * A native OAuth client that may ask for the Realm profile scopes, registered
 * once by the fixture operator and reused by later seed runs.
 */
export async function realmProfileClient(input: LocalOperatorInput): Promise<SeedApi> {
  loopback(input.accountDatabaseUrl);
  const signed = await new SeedApi(input.endpoints).signInOrUp(input.credentials);
  if (signed.id !== input.accountSubject) throw new Error('Seed fixture operator identity changed');
  const pool = new Pool({ connectionString: input.accountDatabaseUrl });
  try {
    const scopes = JSON.stringify(PROFILE_SCOPE.split(' '));
    const reused = await pool.query<{ clientId: string }>(`SELECT c."clientId" FROM "oauthClient" c
      JOIN rezics_oauth_installation i ON i.client_id = c."clientId" AND i.state = 'active'
      WHERE c.name = $1 AND c."userId" = $2 AND c.disabled IS NOT TRUE
        AND c."redirectUris" @> jsonb_build_array($3::text) AND c.scopes @> $4::jsonb AND i.scopes @> $4::jsonb
      ORDER BY c."createdAt" DESC LIMIT 1`, [PROFILE_CLIENT, signed.id, input.endpoints.redirectUri, scopes]);
    let clientId = reused.rows[0]?.clientId;
    if (!clientId) {
      const auth = createAccountAuth({ baseURL: input.endpoints.account, secret: input.accountSecret,
        resource: input.endpoints.resource, pool, operatorUserIds: new Set([signed.id]) });
      const client = await auth.api.adminCreateOAuthClient({
        headers: new Headers({ cookie: signed.cookie, origin: input.endpoints.account }),
        body: { client_name: PROFILE_CLIENT, application_type: 'native', redirect_uris: [input.endpoints.redirectUri],
          token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], skip_consent: true,
          require_pkce: true, scope: PROFILE_SCOPE } });
      clientId = client.client_id;
    }
    if (!clientId) throw new Error('Account did not register the Realm profile seed client');
    return new SeedApi({ ...input.endpoints, clientId, scope: PROFILE_SCOPE });
  } finally { await pool.end(); }
}

/** One Agent's grant: publish a Realm's profile, or make its own public moderator choice there. */
export type RealmProfileGrant = { action: 'realm.profile.publish'; realm: string }
  | { action: 'realm.moderator.choose'; realm: string; agent: string };

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const scopeOf = (grant: RealmProfileGrant) => grant.action === 'realm.profile.publish'
  ? `realm:profile:${grant.realm}` : `realm:moderator-choice:${grant.realm.slice(-36)}:${grant.agent.slice(-36)}`;

/** Grants `input.actingSubject`, represented by `input.ownerAccountSubject`, the exact Realm profile actions. */
export async function grantRealmProfileSeed(input: LocalOperatorInput, grants: readonly RealmProfileGrant[]) {
  loopback(input.accessDatabaseUrl);
  if (grants.length > 8 || grants.some(grant => !native.test(grant.realm)
    || grant.action === 'realm.moderator.choose' && (grant.agent !== input.actingSubject || !native.test(grant.agent)))) {
    throw new Error('Realm profile seed grant is outside the official Realms');
  }
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    const issuer = `${input.endpoints.account}/api/auth`;
    const found = await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`, [issuer, input.ownerAccountSubject]);
    const principal = found.rows[0]?.id ?? randomUUID();
    if (!found.rows[0]) await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3)`, [principal, issuer, input.ownerAccountSubject]);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
      ON CONFLICT (id) DO NOTHING`, [input.actingSubject]);
    for (const grant of grants) {
      const scope = scopeOf(grant);
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      const gate = await client.query<{ open: boolean }>('SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [scope]);
      if (gate.rows[0]?.open !== true) throw new Error(`Realm profile seed gate is closed: ${scope}`);
      const represented = await client.query(`SELECT 1 FROM access.representation WHERE principal_id = $1
        AND subject_id = $2 AND action = $3 AND active AND valid_until > now() FOR SHARE`,
      [principal, input.actingSubject, grant.action]);
      if (!represented.rowCount) await client.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,now() + interval '8 hours')`,
      [randomUUID(), principal, input.actingSubject, grant.action]);
      const granted = await client.query(`SELECT 1 FROM access.permission_grant WHERE recipient_subject = $1
        AND scope_id = $2 AND action = $3 AND active AND valid_until > now() FOR SHARE`,
      [input.actingSubject, scope, grant.action]);
      if (!granted.rowCount) await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), input.actingSubject, scope, grant.action]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}
