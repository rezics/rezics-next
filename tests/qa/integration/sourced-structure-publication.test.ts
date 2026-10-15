import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { originalRecipe, type RecipeWork }
  from '../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { importedRightsAssessments } from '../../../services/main/src/modules/rights/import-policy.ts';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let recipe: RecipeWork;

beforeAll(async () => {
  sessions = await personaSessions('public');
  recipe = await originalRecipe(sessions.owner, 'Sourced publication authority boundary');
});
afterAll(async () => { await sessions?.close(); });

// A syntactically valid sourced request must reach the existing identity and
// Access boundary before attempting to resolve its private Source evidence.
for (const [persona, status] of [['visitor', 401], ['stranger', 403]] as const) {
  test(`sourced structured publication preserves the ${persona} refusal`, async () => {
    const response = await sessions[persona].main('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish',
      work: recipe.work, actingSubject: sessions[persona].actingSubject ?? sessions.owner.actingSubject,
      expectedWorkHead: recipe.workRevision, expectedMainVersion: recipe.mainVersion,
      structure: recipe.structure, expectedStructureHead: recipe.revision,
      expectedPublicationHead: null, disclosure: 'public', rightsBasis: 'public-domain',
      sourceObservation: `https://rezics.com/id/${randomUUID()}`,
    });
    const body = await response.text();
    expect(response.status, body).toBe(status);
  });
}

interface SourceFixture { work: string; workRevision: string; mainVersion: string; structure: string;
  revision: string; observation: string; record: string; otherObservation: string; unknownObservation: string }
let imported: Promise<SourceFixture> | undefined;
async function json<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}
async function sourceFixture() {
  return imported ??= (async () => {
    const actingSubject = sessions.operator.actingSubject;
    const grants = await json<{ authorityEpoch: string; items: Array<{ permission: string;
      active: boolean; recipient: { principalId?: string } }> }>(sessions.operator.main('GET',
      `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(actingSubject!)}`));
    const principalId = grants.items.find(item => item.permission === 'platform:grant' && item.active)!.recipient.principalId!;
    const grant = async (permission: string, scopeId?: string) => {
      const listing = await json<{ authorityEpoch: string }>(sessions.operator.main('GET',
        `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(actingSubject!)}`));
      await json(sessions.operator.main('POST', '/v1/access/grant-changes', {
        profile: 'platform-grant-change-v1', action: 'create', issuerSubject: actingSubject,
        expectedAuthorityEpoch: listing.authorityEpoch, grantId: randomUUID(), permission,
        ...(scopeId ? { scopeId } : {}), recipient: { principalId }, validUntil: null,
      }));
    };
    await grant('platform:use:catalogue-import');
    await grant('platform:resource:work.create', 'work:create:root');
    const retained = async (basis: 'public-domain' | 'unknown', text = 'Mix flour.') => {
      const document = { '@context': 'https://schema.org', '@type': 'Recipe', name: 'Public source recipe',
        inLanguage: 'en', url: 'https://www.gutenberg.org/ebooks/65061',
        author: { '@type': 'Person', name: 'Fannie Merritt Farmer' },
        recipeIngredient: ['1 cup flour'], recipeInstructions: [{ '@type': 'HowToStep', text, inLanguage: 'en' }] };
      return (await json<{ observation: { observation: string; record: string } }>(sessions.operator.main('POST',
        '/v1/sources/intakes', { profile: 'source-manual-intake-v1', provider: 'gutenberg', namespace: 'recipe-extract',
          externalId: `65061/${randomUUID()}`, sourceRevision: 'pinned-test-extract', mediaType: 'application/ld+json',
          retention: 'retained', rawBytesBase64: Buffer.from(JSON.stringify(document)).toString('base64'),
          coverage: { scope: 'complete-recipe', complete: true, omittedFields: [] },
          rightsEvidence: { basis, note: 'Bounded public-domain source text from Project Gutenberg.' } }), 201)).observation;
    };
    const source = await retained('public-domain');
    const other = await retained('public-domain', 'Different copied text.');
    const unknown = await retained('unknown');
    const candidate = await json<{ candidateReceipt: string }>(sessions.operator.main('POST', '/v1/catalogue/candidates', {
      profile: 'catalogue-candidates-v1', originalTitle: { value: 'Public source recipe', language: 'en' },
      aliases: [], romanizations: [], creators: ['Fannie Merritt Farmer'], dates: [], identifiers: [],
    }));
    const work = await json<{ work: string; workRevision: string; mainVersion: string }>(sessions.operator.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'catalogue', grain: 'new-creative-scope',
      candidateReceipt: candidate.candidateReceipt, title: 'Public source recipe', language: 'en',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject,
    }), 201);
    const structure = await json<{ structure: string; revision: string }>(sessions.operator.main('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject,
    }), 201);
    const result = await json<{ revision: string }>(sessions.operator.main('POST', `/v1/recipes/${structure.structure.slice(-36)}/imports`, {
      expectedHead: structure.revision, sourceObservation: source.observation, actingSubject,
    }));
    await grant('platform:resource:work.publish', `work:publish:${work.work}`);
    const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
    const client = await accessPool.connect();
    try {
      await client.query('BEGIN');
      await grantFixtureAuthority(client, { scope: 'rights:assess', requireDispatch: true,
        representations: [{ principalId, actor: actingSubject!, action: 'rights.assess', lifetime: '8 hours' }],
        grant: { actor: actingSubject!, action: 'rights.assess', lifetime: '8 hours' } });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); await accessPool.end(); }
    return { ...work, ...structure, revision: result.revision, observation: source.observation, record: source.record,
      otherObservation: other.observation, unknownObservation: unknown.observation };
  })();
}
function sourcedInput(source: SourceFixture) {
  return { profile: 'work-structure-publication-v1', operation: 'publish', work: source.work,
    actingSubject: sessions.operator.actingSubject, expectedWorkHead: source.workRevision,
    expectedMainVersion: source.mainVersion, structure: source.structure, expectedStructureHead: source.revision,
    expectedPublicationHead: null, disclosure: 'public', rightsBasis: 'public-domain', sourceObservation: source.observation };
}

test('public-domain publication refuses a missing source, unassessed evidence and an unrelated observation', async () => {
  const source = await sourceFixture(), input = sourcedInput(source);
  const { sourceObservation: _observation, ...missing } = input;
  await json(sessions.operator.main('POST', '/v1/work-publications', missing), 400);
  for (const sourceObservation of [source.otherObservation, source.unknownObservation])
    await json(sessions.operator.main('POST', '/v1/work-publications', { ...input, sourceObservation }), 404);
  await json(sessions.operator.main('POST', '/v1/work-publications', { ...input, expectedStructureHead: recipe.revision }), 409);
  await json(sessions.operator.main('POST', '/v1/work-publications', { ...input, expectedWorkHead: recipe.workRevision }), 409);
  await json(sessions.operator.main('POST', '/v1/work-publications', { ...input, expectedMainVersion: recipe.mainVersion }), 404);
  const { sourceObservation: _copied, ...original } = input;
  const falseOriginal = await sessions.operator.main('POST', '/v1/work-publications', { ...original, rightsBasis: 'original-contribution' });
  expect([403, 404]).toContain(falseOriginal.status);
});

test('public-domain publication binds replay, rejects stale heads, and withdraws public delivery for every persona', async () => {
  const source = await sourceFixture(), input = sourcedInput(source), key = `source-publication:${randomUUID()}`;
  const write = await json<{ publicationDecision: string; replayed: boolean }>(sessions.operator.main('POST', '/v1/work-publications', input, key), 201);
  expect(write.replayed).toBe(false);
  expect(await json(sessions.operator.main('POST', '/v1/work-publications', input, key))).toMatchObject({ ...write, replayed: true });
  await json(sessions.operator.main('POST', '/v1/work-publications', { ...input, sourceObservation: source.otherObservation }, key), 409);
  await json(sessions.operator.main('POST', '/v1/work-publications', input), 409);
  for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[persona], query = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const header = await json<{ rights: unknown }>(person.main('GET', `/v1/works/${source.work.slice(-36)}${query}`));
    expect(header.rights).toMatchObject({ basis: 'public-domain', source: { record: source.record,
      observation: source.observation, provider: 'gutenberg', license: 'https://www.gutenberg.org/policy/license.html' } });
    await json(person.main('GET', `/v1/recipes/works/${source.work.slice(-36)}${query}`));
  }
  const assessment = importedRightsAssessments({ provider: 'project-gutenberg',
    url: 'https://www.gutenberg.org/ebooks/65061', credit: 'Fannie Merritt Farmer' }, source.work)[0]!;
  const assess = (outcome: 'supported' | 'not_supported', expectedAssessment: string | null) => {
    const idempotencyKey = `source-rights:${randomUUID()}`;
    return json<{ assessmentId: string }>(sessions.operator.main('POST', '/v1/rights/use-assessments', {
      profile: 'rights-use-assessment-v1', actingSubject: sessions.operator.actingSubject,
      ...assessment, outcome, expectedAssessment, idempotencyKey,
    }, idempotencyKey), 201);
  };
  const denied = await assess('not_supported', null);
  for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[persona], query = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    await json(person.main('GET', `/v1/works/${source.work.slice(-36)}${query}`), 404);
    await json(person.main('GET', `/v1/recipes/works/${source.work.slice(-36)}${query}`), 404);
  }
  await assess('supported', denied.assessmentId);
  await json(sessions.visitor.main('GET', `/v1/recipes/works/${source.work.slice(-36)}`));
  const withdrawal = { profile: 'work-structure-publication-v1', operation: 'withdraw', work: source.work,
    actingSubject: sessions.operator.actingSubject, expectedPublicationHead: write.publicationDecision };
  const withdrawalKey = `source-withdrawal:${randomUUID()}`;
  const withdrawn = await json<{ publicationDecision: string }>(sessions.operator.main('POST', '/v1/work-publications', withdrawal, withdrawalKey), 201);
  expect(withdrawn.publicationDecision).not.toBe(write.publicationDecision);
  expect(await json(sessions.operator.main('POST', '/v1/work-publications', withdrawal, withdrawalKey)))
    .toMatchObject({ ...withdrawn, replayed: true });
  await json(sessions.operator.main('POST', '/v1/work-publications', input, key));
  for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[persona], query = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const header = await json<{ rights?: unknown; publicationState: string }>(person.main('GET', `/v1/works/${source.work.slice(-36)}${query}`));
    expect(header.rights).toBeUndefined();
    expect(header.publicationState).toBe('unpublished');
    if (persona !== 'operator') expect(await json(person.main('GET', `/v1/recipes/works/${source.work.slice(-36)}${query}`))).toBeNull();
  }
});
