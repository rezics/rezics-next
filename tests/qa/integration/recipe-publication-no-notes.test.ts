import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

test('a no-notes Recipe Structure stays private without Work read authority', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-publication-no-notes-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (fixture.env as typeof fixture.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await fixture.json<{ work: string; mainVersion: string }>(await fixture.call(
      'POST', '/v1/works', await fixture.authoredBody({ language: 'en',
        profile: 'metadata-only-v1', title: 'Private flour pancakes',
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: fixture.actor })), 201);
    await fixture.grant(`work:edit:${work.work}`, 'recipe.edit');
    const path = `/v1/recipes/works/${shortId(work.work)}`;
    const authorPath = `${path}?actingSubject=${encodeURIComponent(fixture.actor)}`;
    const created = await fixture.json<{ structure: string; revision: string }>(await fixture.call(
      'POST', '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: fixture.actor }, `recipe-${randomUUID()}`), 201);
    const changed = await fixture.json<{ revision: string }>(await fixture.call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, { profile: 'recipe-composition',
        expectedHead: created.revision, actingSubject: fixture.actor, operations: [
          { op: 'insert', parent: created.structure, position: 'last', role: 'ingredient',
            qualifier: { type: 'ingredient-line', originalText: { value: '2 cups flour', language: 'en' },
              amountLexical: '2', amount: { numerator: 2, denominator: 1 }, unitText: 'cups',
              optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed' } },
          { op: 'insert', parent: created.structure, position: 'last', role: 'step',
            qualifier: { type: 'recipe-step', instructionText: { value: 'Cook until golden.', language: 'en' },
              usesIngredient: [], media: [], scaling: 'linear' } },
        ] }, `recipe-${randomUUID()}`), 200);

    expect((await fixture.call('GET', authorPath)).status).toBe(404);
    expect((await fixture.call('GET', path, undefined, randomUUID(), null)).status).toBe(404);
    expect((await fixture.call('GET', authorPath, undefined, randomUUID(), fixture.account.tokenB)).status).toBe(404);
    expect((await fixture.call('GET', `/v1/compositions/${shortId(created.structure)}`,
      undefined, randomUUID(), null)).status).toBe(404);

    await fixture.grant(`work:read:${work.work}`, 'work.read');
    const page = await fixture.json<{ profile: string; revision: string;
      occurrences: Array<{ role: string }> }>(await fixture.call('GET', authorPath), 200);
    expect(page).toMatchObject({ profile: 'recipe-work-page-v1', revision: changed.revision });
    expect(page.occurrences.map(occurrence => occurrence.role)).toEqual(['ingredient', 'step']);
  } finally { await fixture.close(); }
}, 180_000);
