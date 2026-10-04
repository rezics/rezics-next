import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { SeedApiError } from './api.ts';
import { catalogueResourceId, loadCatalogue, type CatalogueResponse } from '../../../tests/fixtures/catalogue/load.ts';
import { grantCuratedCollectionSeed, grantHomeSeedAuthority, type LocalOperatorInput } from './operator.ts';
import { relationLexiconSeed } from './relation-lexicon-data.ts';
import { seedRelationLexicon, seedVariantKindConcepts, seedCanonicity } from './relation-lexicon.ts';
import type { SeedState } from './state.ts';
import type { DefinitionState } from '../../../services/main/src/modules/semantic/change.ts';

const COLLECTIONS = ['sao.franchise', 'index.franchise', 'index.original.reading'];
const LEXICON = ['rewrite', 'reboot', 'sequel', 'spin-off', 'adaptation',
  'correspondence-equivalent', 'correspondence-partial', 'correspondence-revised',
  'credit-illustrator', 'credit-concept-supervision', 'variant-of', 'holds-title', 'represents', 'in-continuity'];

/** Load the catalogue fixture through the same public API the acceptance test uses. */
export async function seedFranchises(state: SeedState): Promise<void> {
  const session = state.sessions[0];
  if (!state.operatorInput || !session) {
    throw new Error('Franchise seed needs the operator database and a seed session');
  }
  const input: LocalOperatorInput = { ...state.operatorInput, ownerAccountSubject: session.accountId,
    actingSubject: session.actingSubject };
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  try {
    for (const id of COLLECTIONS.map(catalogueResourceId)) {
      await grantCuratedCollectionSeed(input, id);
      await grantSeedAuthority(pool, input, `semantic:read:${id}`, 'semantic.read');
    }
    await grantSeedAuthority(pool, input, 'semantic:create:root', 'semantic.change');
    await ensureCatalogueLexicon(state, input, pool, session.token, session.actingSubject);
    await grantSeedAuthority(pool, input, 'classification:define:global', 'classification.proposition.define');
    const vocabularyClient = {
      post: <T>(path: string, body: object, key: string) => state.api.post<T>(path, body, session.token, key),
      authorizeDefinition: async (receipt: { component: string }) => {
        await grantSeedAuthority(pool, input, `semantic:read:${receipt.component}`, 'semantic.read');
        await grantSeedAuthority(pool, input, `semantic:edit:${receipt.component}`, 'semantic.change');
      },
    };
    await seedVariantKindConcepts(vocabularyClient, session.actingSubject, 'catalogue-dev');
    await seedCanonicity(vocabularyClient, session.actingSubject, 'catalogue-dev');
    await loadCatalogue({ actingSubject: session.actingSubject,
      request: (method, path, body, key) => seedRequest(state, session.token, method, path, body, key),
      grant: async (scope, action) => {
        if (action === 'collection.edit') {
          await grantCuratedCollectionSeed(input, scope.slice('collection:edit:'.length));
          return;
        }
        if (action === 'work.edit' || action === 'work.read') {
          await grantHomeSeedAuthority(input, [{ action, scope }]);
          return;
        }
        await grantSeedAuthority(pool, input, scope, action);
      } });
  } finally { await pool.end(); }
}

async function ensureCatalogueLexicon(state: SeedState, input: LocalOperatorInput, pool: Pool,
  token: string, actingSubject: string) {
  const specs = LEXICON.map(key => {
    const definition = relationLexiconSeed.find(item => item.key === key);
    if (!definition) throw new Error(`catalogue lexicon key ${key} is not in the seed catalogue`);
    return { ...definition, labels: definition.labels.filter(label => label[0] === 'en') };
  });
  for (const spec of specs) {
    try {
      await seedRelationLexicon({
        post: (path, body, key) => state.api.post(path, body, token, key),
        currentDefinition: async key => {
          try {
            const current = await state.api.get<{ definition: string }>(
              `/v1/lexicon/definitions/${key}?actingSubject=${encodeURIComponent(actingSubject)}`, token);
            const retained = await state.api.get<{ revision: string; state: DefinitionState }>(
              `/v1/semantic/resources/${current.definition.split('/').at(-1)}?actingSubject=${encodeURIComponent(actingSubject)}`, token);
            return { component: current.definition, revision: retained.revision, state: retained.state };
          } catch (error) {
            if (error instanceof SeedApiError && error.status === 404) return null;
            throw error;
          }
        },
        authorizeDefinition: async receipt => {
          await grantSeedAuthority(pool, input, `semantic:read:${receipt.component}`, 'semantic.read');
          await grantSeedAuthority(pool, input, `semantic:edit:${receipt.component}`, 'semantic.change');
          await grantSeedAuthority(pool, input, `semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
        } }, actingSubject, 'catalogue-dev', [spec]);
    } catch (error) {
      if (error instanceof SeedApiError && (error.status === 409 || error.status === 422)) {
        throw new Error(`lexicon key ${spec.key} exists but the seed actor cannot read it`);
      }
      throw error;
    }
  }
}

async function seedRequest(state: SeedState, token: string, method: string, path: string,
  body?: unknown, key?: string): Promise<CatalogueResponse> {
  try {
    if (method === 'GET') return { status: 200, body: await state.api.get(path, token) };
    const written = method === 'PUT'
      ? await state.api.put(path, body, token, key ?? 'catalogue:v1:write')
      : await state.api.post(path, body, token, key ?? 'catalogue:v1:write');
    return { status: 200, body: written };
  } catch (error) {
    if (!(error instanceof SeedApiError)) throw error;
    try { return { status: error.status, body: JSON.parse(error.detail) as unknown }; }
    catch { return { status: error.status, body: error.detail }; }
  }
}

async function grantSeedAuthority(pool: Pool, input: LocalOperatorInput, scope: string, action: string) {
  const url = new URL(input.accessDatabaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Franchise seed grants require a loopback database');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    const owner = await principal(client, `${input.endpoints.account}/api/auth`, input.ownerAccountSubject);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
      ON CONFLICT (id) DO NOTHING`, [input.actingSubject]);
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
    const gate = await client.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
    if (gate.rows[0]?.open !== true) throw new Error(`Franchise seed grant gate is closed: ${scope}`);
    await ensureRepresentation(client, owner, input.actingSubject, action);
    const grant = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > now() FOR SHARE`, [input.actingSubject, scope, action]);
    if (!grant.rowCount) await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`,
    [randomUUID(), input.actingSubject, scope, action]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the first error */ }
    throw error;
  } finally { client.release(); }
}

async function principal(client: PoolClient, issuer: string, accountSubject: string) {
  const existing = await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`, [issuer, accountSubject]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [id, issuer, accountSubject]);
  return id;
}

async function ensureRepresentation(client: PoolClient, principalId: string, actor: string, action: string) {
  const existing = await client.query(`SELECT id FROM access.representation
    WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active
      AND valid_until > now() FOR SHARE`, [principalId, actor, action]);
  if (existing.rowCount) return;
  await client.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), principalId, actor, action]);
}
