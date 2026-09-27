import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { SeedApi, type Credentials, type SeedEndpoints } from './api.ts';

export interface LocalOperatorInput { endpoints: SeedEndpoints; credentials: Credentials;
  accountDatabaseUrl: string; accountSecret: string; accessDatabaseUrl: string;
  accountSubject: string; ownerAccountSubject: string; actingSubject: string }

function loopback(value: string) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Seed operator setup requires a loopback database');
  }
}

/** Register a short-lived local OAuth client with the existing fixture operator. */
export async function operatorSeedSession(input: LocalOperatorInput) {
  for (const value of [input.accountDatabaseUrl, input.accessDatabaseUrl]) loopback(value);
  const signed = await new SeedApi(input.endpoints).signInOrUp(input.credentials);
  if (signed.id !== input.accountSubject) throw new Error('Seed fixture operator identity changed');
  const pool = new Pool({ connectionString: input.accountDatabaseUrl });
  try {
    const auth = createAccountAuth({ baseURL: input.endpoints.account,
      secret: input.accountSecret, resource: input.endpoints.resource,
      pool, operatorUserIds: new Set([signed.id]) });
    const client = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: signed.cookie, origin: input.endpoints.account }),
      body: { client_name: 'Local official Zone seed', application_type: 'native',
        redirect_uris: [input.endpoints.redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], skip_consent: true, require_pkce: true,
        scope: 'openid owner:operate zone:edit' } });
    if (!client.client_id) throw new Error('Account did not register the seed operator client');
    const api = new SeedApi({ ...input.endpoints, clientId: client.client_id,
      scope: 'openid owner:operate zone:edit' });
    return { api, token: await api.token(signed.cookie) };
  } finally { await pool.end(); }
}

async function principal(client: PoolClient, issuer: string, accountSubject: string) {
  const existing = await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
  [issuer, accountSubject]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3)`, [id, issuer, accountSubject]);
  return id;
}

async function ensureRepresentation(client: PoolClient, principalId: string,
  actor: string, action: string) {
  const existing = await client.query(`SELECT id FROM access.representation
    WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active
      AND valid_until > now() FOR SHARE`, [principalId, actor, action]);
  if (existing.rowCount) return;
  await client.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,$4,now() + interval '8 hours')`,
  [randomUUID(), principalId, actor, action]);
}

/** Fixture-only grants. Realms and Zones themselves are still created through Main APIs. */
export async function grantOfficialZoneSeed(input: LocalOperatorInput, zone: string) {
  loopback(input.accessDatabaseUrl);
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(zone)) {
    throw new Error('Seed Zone id must be native');
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
    const owner = await principal(client, issuer, input.ownerAccountSubject);
    const operator = await principal(client, issuer, input.accountSubject);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
      ON CONFLICT (id) DO NOTHING`, [input.actingSubject]);
    for (const [action, scope] of [
      ['zone.edit', `zone:edit:${zone}`], ['zone.official', `zone:official:${zone}`],
      ['semantic.read', `semantic:read:${zone}`],
    ] as const) {
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      const gate = await client.query<{ open: boolean }>(
        'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
      if (gate.rows[0]?.open !== true) throw new Error(`Seed grant gate is closed: ${scope}`);
      if (action !== 'semantic.read') await ensureRepresentation(client, operator, input.actingSubject, action);
      if (action !== 'zone.official') await ensureRepresentation(client, owner, input.actingSubject, action);
      const grant = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
          AND valid_until > now() FOR SHARE`, [input.actingSubject, scope, action]);
      if (!grant.rowCount) await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`,
      [randomUUID(), input.actingSubject, scope, action]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}

/** Give the seed owner a bounded Collection edit grant for API curation. */
export async function grantCuratedCollectionSeed(input: LocalOperatorInput, collection: string) {
  loopback(input.accessDatabaseUrl);
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(collection)) {
    throw new Error('Seed Collection id must be native');
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
    const owner = await principal(client, `${input.endpoints.account}/api/auth`, input.ownerAccountSubject);
    const scope = `collection:edit:${collection}`;
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
      ON CONFLICT (id) DO NOTHING`, [input.actingSubject]);
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
    const gate = await client.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
    if (gate.rows[0]?.open !== true) throw new Error('Collection edit gate is closed');
    await ensureRepresentation(client, owner, input.actingSubject, 'collection.edit');
    const grant = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'collection.edit' AND active
        AND valid_until > now() FOR SHARE`, [input.actingSubject, scope]);
    if (!grant.rowCount) await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'collection.edit',now() + interval '8 hours')`,
    [randomUUID(), input.actingSubject, scope]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}

/** Dev fixture authority for the seed's exact Work, Content and Realm targets.
 * Authoring and reader progress still use the ordinary Main commands. */
export async function grantHomeSeedAuthority(input: LocalOperatorInput,
  grants: readonly { action: 'work.edit' | 'work.read' | 'content.draft'
    | 'content.publish' | 'content.search-eligibility' | 'publication.adopt'
    | 'rating.context.create'; scope: string }[]) {
  loopback(input.accessDatabaseUrl);
  const scopePrefix = { 'work.edit': 'work:edit:https://rezics.com/id/',
    'work.read': 'work:read:https://rezics.com/id/',
    'content.draft': 'content:draft:https://rezics.com/id/',
    'content.publish': 'content:publish:https://rezics.com/id/',
    'content.search-eligibility': 'content:search-eligibility:https://rezics.com/id/',
    'publication.adopt': 'publication:adopt:https://rezics.com/id/',
    'rating.context.create': 'rating:context:https://rezics.com/id/' } as const;
  if (grants.length > 10 || grants.some(({ action, scope }) =>
    !scope.startsWith(scopePrefix[action])
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      scope.slice(scopePrefix[action].length)))) {
    throw new Error('Home seed grant is outside the serial fixture');
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
    const owner = await principal(client, `${input.endpoints.account}/api/auth`, input.ownerAccountSubject);
    for (const { action, scope } of grants) {
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      const gate = await client.query<{ open: boolean }>(
        'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
      if (gate.rows[0]?.open !== true) throw new Error(`Home seed grant gate is closed: ${scope}`);
      await ensureRepresentation(client, owner, input.actingSubject, action);
      const found = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
          AND valid_until > now() FOR SHARE`, [input.actingSubject, scope, action]);
      if (!found.rowCount) await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`,
      [randomUUID(), input.actingSubject, scope, action]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}

/** An official Realm accepts member reports only while its governance gate is open. */
export async function openRealmReportScope(input: LocalOperatorInput, realm: string) {
  loopback(input.accessDatabaseUrl);
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(realm)) throw new Error('Seed Realm id must be native');
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  try {
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [`governance:realm:${realm}`]);
  } finally { await pool.end(); }
}
