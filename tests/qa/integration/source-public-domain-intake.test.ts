import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { launchRecipeSources } from '../../../scripts/load/launch-corpus.ts';
import type { StagedSourceObservation } from '../../../services/main/src/modules/source/intake.ts';
import { personaSessions } from '../support/personas.ts';

test('Source public-domain intake retains exact evidence under revocable platform authority over HTTP', async () => {
  const sessions = await personaSessions('public');
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const operator = sessions.operator;
  const source = launchRecipeSources().find(value => value.pinId === 'boston-cookbook'
    && value.recipeId === 'quick-puff-paste')!;
  const retained = { '@context': 'https://schema.org', '@type': 'Recipe',
    name: source.title, inLanguage: source.language,
    url: 'https://www.gutenberg.org/ebooks/65061',
    author: { '@type': 'Person', name: 'Fannie Merritt Farmer' },
    recipeIngredient: source.ingredients, recipeInstructions: source.methods };
  const bytes = Buffer.from(JSON.stringify(retained));
  const body = { profile: 'source-manual-intake-v1', provider: 'gutenberg', namespace: 'recipe-extract',
    externalId: '65061/quick-puff-paste', sourceRevision: source.sourceSha256,
    mediaType: 'application/ld+json', retention: 'retained', rawBytesBase64: bytes.toString('base64'),
    coverage: { scope: 'bounded-recipe-extract', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'public-domain',
      note: `Bounded pinned extract; ${retained.url}; source-stated author ${retained.author.name}. Retention is not clearance.` } };
  async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
    const response = await request, raw = await response.text();
    expect(response.status, `${response.status}: ${raw}`).toBe(status);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return JSON.parse(raw) as T;
  }
  async function grants() {
    return answer<{ authorityEpoch: string; items: Array<{ id: string; generation: string;
      permission: string; active: boolean; recipient: { principalId?: string } }> }>(operator.main('GET',
      `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(operator.actingSubject!)}`));
  }
  async function revoke(grant: { id: string; generation: string }) {
    await answer(operator.main('POST', '/v1/access/grant-changes', {
      profile: 'platform-grant-change-v1', action: 'revoke', issuerSubject: operator.actingSubject,
      expectedAuthorityEpoch: (await grants()).authorityEpoch, grantId: grant.id,
      expectedObjectGeneration: grant.generation,
    }));
  }
  try {
    const listing = await grants();
    const principalId = listing.items.find(value => value.active && value.permission === 'platform:grant')!
      .recipient.principalId!;
    for (const grant of listing.items.filter(value => value.active
      && value.permission === 'platform:resource:work.create')) await revoke(grant);
    async function mandate(permission: string, scopeId?: string) {
      return answer<{ grant: { id: string; generation: string } }>(operator.main('POST', '/v1/access/grant-changes', {
        profile: 'platform-grant-change-v1', action: 'create', issuerSubject: operator.actingSubject,
        expectedAuthorityEpoch: (await grants()).authorityEpoch, grantId: randomUUID(), permission,
        ...(scopeId ? { scopeId } : {}), recipient: { principalId },
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }));
    }
    await mandate('platform:use:catalogue-import');
    await answer(sessions.visitor.main('POST', '/v1/sources/intakes', body), 401);
    await answer(sessions.member.main('POST', '/v1/sources/intakes', body), 403);
    await answer(operator.main('POST', '/v1/sources/intakes', body), 403);
    const resource = await mandate('platform:resource:work.create', 'work:create:root');
    const key = randomUUID();
    const first = await answer<{ observation: StagedSourceObservation; replayed: boolean }>(
      operator.main('POST', '/v1/sources/intakes', body, key), 201);
    console.info('Public-domain Source intake HTTP evidence', JSON.stringify({ request: body, idempotencyKey: key,
      status: 201, response: first }));
    expect(first.replayed).toBe(false);
    expect(first.observation).toMatchObject({ profile: body.profile, state: 'staged',
      provider: body.provider, namespace: body.namespace, externalId: body.externalId,
      sourceRevision: body.sourceRevision, mediaType: body.mediaType, retention: body.retention,
      byteDigest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
      rawBytesBase64: body.rawBytesBase64, coverage: body.coverage, rightsEvidence: body.rightsEvidence });
    expect(JSON.parse(Buffer.from(first.observation.rawBytesBase64!, 'base64').toString())).toEqual(retained);
    const path = `/v1/sources/observations/${first.observation.observation.split('/').at(-1)}`;
    expect(await answer(operator.main('GET', path))).toEqual(first.observation);
    await answer(sessions.visitor.main('GET', path), 401);
    await answer(sessions.stranger.main('GET', path), 404);
    expect(await answer(operator.main('POST', '/v1/sources/intakes', body, key)))
      .toEqual({ observation: first.observation, replayed: true });
    for (const change of [
      { provider: 'substitute' }, { namespace: 'book' }, { externalId: 'substitute' },
      { sourceRevision: 'other-edition' },
      { rightsEvidence: { ...body.rightsEvidence, basis: 'original' } },
      { rightsEvidence: { ...body.rightsEvidence, note: 'Substituted rights evidence' } },
      ...[{ ...retained, url: 'https://example.test/substitute' },
        { ...retained, author: { '@type': 'Person', name: 'Importer' } },
        { ...retained, recipeInstructions: ['Substituted expression'] }]
        .map(value => ({ rawBytesBase64: Buffer.from(JSON.stringify(value)).toString('base64') })),
    ]) {
      expect(await answer(operator.main('POST', '/v1/sources/intakes', { ...body, ...change }, key), 409))
        .toMatchObject({ code: 'idempotency_conflict' });
    }
    for (const change of [{ rightsEvidence: { ...body.rightsEvidence, basis: 'original-contribution' } },
      { rawBytesBase64: 'a===' }, { retention: 'not-retained' }]) {
      await answer(operator.main('POST', '/v1/sources/intakes', { ...body, ...change }), 400);
    }
    const uncredited = { ...retained, author: null };
    const unknownRights = { basis: 'unknown', note: 'Rights and authorship are unknown.' };
    const unknown = await answer<{ observation: StagedSourceObservation }>(operator.main('POST',
      '/v1/sources/intakes', { ...body, rawBytesBase64: Buffer.from(JSON.stringify(uncredited)).toString('base64'),
        rightsEvidence: unknownRights }), 201);
    expect(unknown.observation.rightsEvidence).toEqual(unknownRights);
    expect(JSON.parse(Buffer.from(unknown.observation.rawBytesBase64!, 'base64').toString())).toEqual(uncredited);
    expect(unknown.observation.record).toBe(first.observation.record);
    expect(unknown.observation.observation).not.toBe(first.observation.observation);
    expect(await answer(operator.main('GET', path))).toEqual(first.observation);
    await expect(pool.query('UPDATE source.observation SET rights_evidence = $2 WHERE id = $1',
      [first.observation.observation.split('/').at(-1), JSON.stringify(unknown.observation.rightsEvidence)]))
      .rejects.toThrow('immutable source evidence');
    await revoke(resource.grant);
    await answer(operator.main('POST', '/v1/sources/intakes', body), 403);
    await answer(operator.main('POST', '/v1/sources/intakes', body, key), 403);
    expect(await answer(operator.main('GET', path))).toEqual(first.observation);
  } finally {
    await pool.end();
    await sessions.close();
  }
}, 180_000);
