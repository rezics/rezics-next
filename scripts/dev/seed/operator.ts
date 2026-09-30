import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { setClientDisabled } from '../../../services/account/src/admin-actions.ts';
import { PLATFORM_ACTION, PLATFORM_SCOPE } from '../../../services/main/src/modules/suitability/store.ts';
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

/** Reuse the newest seed client whose installation, callback and scopes still match. */
export async function reusableSeedClient(pool: Pool, ownerId: string, redirectUri: string,
  scope: string): Promise<string | undefined> {
  const reused = await pool.query<{ clientId: string }>(`SELECT c."clientId" FROM "oauthClient" c
    JOIN rezics_oauth_installation i ON i.client_id = c."clientId" AND i.state = 'active'
    WHERE c.name = 'Local official Zone seed' AND c."userId" = $1 AND c.disabled IS NOT TRUE
      AND c."redirectUris" @> jsonb_build_array($2::text)
      AND c.scopes @> $3::jsonb AND i.scopes @> $3::jsonb
      AND c."grantTypes" @> '["authorization_code"]'::jsonb
    ORDER BY c."createdAt" DESC, c."clientId" DESC LIMIT 1`,
  [ownerId, redirectUri, JSON.stringify(scope.split(' '))]);
  return reused.rows[0]?.clientId;
}

/** Retire only this operator's superseded seed clients through the audited API. */
export async function disableSupersededSeedClients(pool: Pool, ownerId: string, keptId: string,
  disable: (clientId: string) => Promise<unknown>) {
  const duplicates = await pool.query<{ clientId: string }>(`SELECT "clientId" FROM "oauthClient"
    WHERE name = 'Local official Zone seed' AND "userId" = $1 AND "clientId" <> $2 AND disabled IS NOT TRUE
    ORDER BY "clientId"`, [ownerId, keptId]);
  for (const duplicate of duplicates.rows) await disable(duplicate.clientId);
}

/** Reuse the fixture operator's installed seed client across repeated seed runs. */
export async function operatorSeedSession(input: LocalOperatorInput) {
  for (const value of [input.accountDatabaseUrl, input.accessDatabaseUrl]) loopback(value);
  const signed = await new SeedApi(input.endpoints).signInOrUp(input.credentials);
  if (signed.id !== input.accountSubject) throw new Error('Seed fixture operator identity changed');
  const pool = new Pool({ connectionString: input.accountDatabaseUrl });
  const lock = await pool.connect();
  try {
    // Serialize selection, creation and retirement across repeated seed processes.
    await lock.query("SET lock_timeout = '5s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`zone-seed:${signed.id}`]);
    const scope = 'openid owner:operate zone:edit theme:approve theme:read source:acquire source:convert source:propose source:adopt source:read work:create work:edit work:read governance:decide';
    const auth = createAccountAuth({ baseURL: input.endpoints.account,
      secret: input.accountSecret, resource: input.endpoints.resource,
      pool, operatorUserIds: new Set([signed.id]) });
    const headers = new Headers({ cookie: signed.cookie, origin: input.endpoints.account });
    let clientId = await reusableSeedClient(pool, signed.id, input.endpoints.redirectUri, scope);
    if (!clientId) {
      const client = await auth.api.adminCreateOAuthClient({
        headers,
        body: { client_name: 'Local official Zone seed', application_type: 'native',
          redirect_uris: [input.endpoints.redirectUri], token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'], skip_consent: true, require_pkce: true,
          scope } });
      clientId = client.client_id;
    }
    if (!clientId) throw new Error('Account did not register the seed operator client');
    await disableSupersededSeedClients(pool, signed.id, clientId, duplicate =>
      setClientDisabled(auth, pool, new Request(input.endpoints.account, { headers }), duplicate,
        { action: 'disable', reason: 'Superseded local Zone seed client', commandId: randomUUID() }));
    const api = new SeedApi({ ...input.endpoints, clientId, scope });
    return { api, token: await api.token(signed.cookie), cookie: signed.cookie,
      issuedAt: Date.now() };
  } finally { lock.release(true); await pool.end(); }
}

type ImportedGrant = { action: string; scope: string };

async function grantImportedSeedScopes(input: LocalOperatorInput,
  grants: readonly ImportedGrant[]): Promise<void> {
  loopback(input.accessDatabaseUrl);
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    const operator = await principal(client, `${input.endpoints.account}/api/auth`, input.accountSubject);
    const owner = await principal(client, `${input.endpoints.account}/api/auth`, input.ownerAccountSubject);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
      ON CONFLICT (id) DO NOTHING`, [input.actingSubject]);
    for (const { action, scope } of grants) {
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(
        'SELECT open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
      if (gate.rows[0]?.open !== true || gate.rows[0]?.dispatch_open !== true) {
        throw new Error(`Seed grant gate is closed: ${scope}`);
      }
      await ensureRepresentation(client, operator, input.actingSubject, action);
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

/** Local fixture moderation authority; closed gates remain an operator decision. */
export async function grantPlatformModerationSeed(input: LocalOperatorInput): Promise<void> {
  return grantImportedSeedScopes(input, [{ action: PLATFORM_ACTION, scope: PLATFORM_SCOPE }]);
}

const nativeSeedId = (value: string) => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value);

/** Bound classic creation, editing and public text authority to imported resources. */
export async function grantImportedWorkSeedAuthority(input: LocalOperatorInput,
  work?: string, mainVersion?: string): Promise<void> {
  if (!work && !mainVersion) return grantImportedSeedScopes(input,
    [{ action: 'work.create', scope: 'work:create:root' }]);
  if (!work || !mainVersion || !nativeSeedId(work) || !nativeSeedId(mainVersion)) {
    throw new Error('Imported Work seed authority requires a Work and Main Version');
  }
  return grantImportedSeedScopes(input, [
    { action: 'work.edit', scope: `work:edit:${work}` },
    { action: 'contribution.create', scope: `contribution:create:${work}` },
    { action: 'publication.select', scope: `publication:select:${mainVersion}` },
  ]);
}

export async function grantImportedContributionSeedAuthority(input: LocalOperatorInput,
  contribution: string): Promise<void> {
  if (!nativeSeedId(contribution)) throw new Error('Imported Work contribution must be native');
  return grantImportedSeedScopes(input,
    [{ action: 'contribution.publish', scope: `contribution:publish:${contribution}` }]);
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

/** Fixture-only authority for a theme owner and an independent demo-account reviewer. */
export async function grantOfficialThemeSeed(input: LocalOperatorInput, theme: string,
  reviewer: { accountId: string; actingSubject: string }) {
  loopback(input.accessDatabaseUrl);
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(theme)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(reviewer.actingSubject)
    || reviewer.accountId === input.accountSubject) {
    throw new Error('Official theme grant requires a native theme and a separate reviewer account');
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
    const operator = await principal(client, issuer, input.accountSubject);
    const reviewerPrincipal = await principal(client, issuer, reviewer.accountId);
    for (const actor of [input.actingSubject, reviewer.actingSubject]) {
      await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
        ON CONFLICT (id) DO NOTHING`, [actor]);
    }
    for (const [action, scope, actor, principalId] of [
      ['theme.create', 'theme:create:root', input.actingSubject, operator],
      ['theme.revise', `theme:revise:${theme.slice(-36)}`, input.actingSubject, operator],
      ['theme.activate', `theme:activate:${theme.slice(-36)}`, input.actingSubject, operator],
      ['theme.review', `theme:review:${theme.slice(-36)}`, reviewer.actingSubject, reviewerPrincipal],
    ]) {
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      const gate = await client.query<{ open: boolean }>(
        'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
      if (gate.rows[0]?.open !== true) throw new Error(`Official theme gate is closed: ${scope}`);
      await ensureRepresentation(client, principalId, actor, action);
      const grant = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
          AND valid_until > now() FOR SHARE`, [actor, scope, action]);
      if (!grant.rowCount) await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`,
      [randomUUID(), actor, scope, action]);
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
  grants: readonly { action: 'work.edit' | 'recipe.edit' | 'work.read' | 'content.draft'
    | 'content.publish' | 'content.search-eligibility' | 'publication.adopt'
    | 'rating.context.create' | 'rating.observation.set' | 'context.create'
    | 'classification.proposition.define' | 'classification.context.configure'
    | 'classification.decision.set' | 'recommendation.generation.manage'; scope: string }[]) {
  loopback(input.accessDatabaseUrl);
  const scopePrefix = { 'work.edit': 'work:edit:https://rezics.com/id/',
    'recipe.edit': 'work:edit:https://rezics.com/id/',
    'work.read': 'work:read:https://rezics.com/id/',
    'content.draft': 'content:draft:https://rezics.com/id/',
    'content.publish': 'content:publish:https://rezics.com/id/',
    'content.search-eligibility': 'content:search-eligibility:https://rezics.com/id/',
    'publication.adopt': 'publication:adopt:https://rezics.com/id/',
    'rating.context.create': 'rating:context:https://rezics.com/id/',
    'rating.observation.set': 'rating:observe:https://rezics.com/id/',
    'context.create': 'context:create:root',
    'classification.context.configure': 'classification:context:https://rezics.com/id/',
    'classification.decision.set': 'classification:decide:https://rezics.com/id/',
    'classification.proposition.define': 'classification:define:global',
    'recommendation.generation.manage': 'recommendation:manage' } as const;
  if (grants.length > 10 || grants.some(({ action, scope }) => {
    if (action === 'classification.decision.set' && scope === 'classification:decide:global') return false;
    if (action === 'context.create' || action === 'classification.proposition.define'
      || action === 'recommendation.generation.manage') return scope !== scopePrefix[action];
    return !scope.startsWith(scopePrefix[action])
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        scope.slice(scopePrefix[action].length));
  })) {
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
