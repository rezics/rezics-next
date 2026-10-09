import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { grantFixtureAuthority, rethrowFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { SeedApiError, type SeedApi } from './api.ts';
import { catalogueResourceId, loadCatalogue, type CatalogueResponse } from '../../../tests/fixtures/catalogue/load.ts';
import { grantCuratedCollectionSeed, grantHomeSeedAuthority, type LocalOperatorInput } from './operator.ts';
import { relationLexiconSeed } from './relation-lexicon-data.ts';
import { seedRelationLexicon, seedVariantKindConcepts, seedCanonicity, seedWorkFormat } from './relation-lexicon.ts';
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
    await seedWorkFormat(vocabularyClient, session.actingSubject);
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

const RELEASE_PATH = /^\/v1\/works\/([0-9a-f-]{36})\/releases\/([0-9a-f-]{36})$/;
const RELEASE_FACTS = ['kind', 'status', 'titleLanguage', 'tracklistLanguage', 'title', 'editionStatement', 'publisher',
  'publicationYear', 'isbn13', 'originalUrl', 'fixedRelease', 'platform', 'territory'] as const;
type ReleaseBody = Record<string, unknown> & { id: string; expectedHead: string | null;
  coverage: { realization: string }[] };

type Row = Record<string, unknown>;
const byJson = (rows: unknown[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** The facts a release write and its public read share, in one order and shape. */
export function releaseFacts(release: Row) {
  const list = (value: unknown) => (value as Row[] | undefined) ?? [];
  return { ...Object.fromEntries(RELEASE_FACTS.map(field => [field, release[field] ?? null])),
    identifiers: byJson(list(release.identifiers).map(({ provider, value }) => ({ provider, value }))),
    coverage: byJson(list(release.coverage).map(({ realization, revision, completeness, portion }) =>
      ({ realization, revision, completeness, portion: portion ?? null }))) };
}

/** A closed release changes only as a correction citing evidence, so a plan that
 * differs from the stored facts is sent against the current head, and one that
 * matches sends nothing. The covered realization is the evidence: the release
 * facts are that realization's published edition. */
export async function convergeRelease(api: Pick<SeedApi, 'get' | 'put'>, token: string, path: string, planned: ReleaseBody,
  key: string, reconciled: () => void): Promise<CatalogueResponse | null> {
  const ids = path.match(RELEASE_PATH);
  let current: Row;
  try {
    current = await api.get(`${path}?${new URLSearchParams({ actingSubject: String(planned.actingSubject) })}`, token);
  } catch (error) {
    if (error instanceof SeedApiError && error.status === 404) return null;
    throw error;
  }
  const revision = String(current.revision);
  if (JSON.stringify(releaseFacts(planned)) === JSON.stringify(releaseFacts(current))) {
    reconciled();
    return { status: 200, body: { work: `https://rezics.com/id/${ids![1]}`, release: planned.id, revision, replayed: true } };
  }
  const correction = { ...planned, expectedHead: revision, evidence: planned.coverage[0]!.realization };
  const digest = createHash('sha256').update(JSON.stringify(correction)).digest('hex').slice(0, 24);
  return { status: 200, body: await api.put(path, correction, token, `${key}:correction:${digest}`) };
}

async function seedRequest(state: SeedState, token: string, method: string, path: string,
  body?: unknown, key?: string): Promise<CatalogueResponse> {
  try {
    if (method === 'GET') return { status: 200, body: await state.api.get(path, token) };
    const release = method === 'PUT' && RELEASE_PATH.test(path) ? body as ReleaseBody : null;
    if (release?.profile === 'release-v2' && release.expectedHead === null) {
      const converged = await convergeRelease(state.api, token, path, release, key ?? 'catalogue:v1:write',
        () => { if (state.endpoints.writeCounts) state.endpoints.writeCounts.reconciled++; });
      if (converged) return converged;
    }
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

export async function grantSeedAuthority(pool: Pool, input: LocalOperatorInput, scope: string, action: string) {
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
    try {
      await grantFixtureAuthority(client, {
        scope, requireDispatch: false,
        representations: [{ principalId: owner, actor: input.actingSubject, action, lifetime: '8 hours' }],
        grant: { actor: input.actingSubject, action, lifetime: '8 hours' },
      });
    } catch (error) {
      rethrowFixtureAuthority(error, { gate: `Franchise seed grant gate is closed: ${scope}` });
    }
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
