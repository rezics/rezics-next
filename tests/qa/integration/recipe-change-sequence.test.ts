import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

/**
 * The recipe editor writes each section and ingredient line as its own composition
 * change, then edits the first line in place. That edit is the sixth change on
 * the recipe and must keep the line's occurrence and its place among siblings.
 */
test('a recipe line edit after its sections and lines keeps the line in place', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-change-sequence-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  const line = (text: string, lexical: string, numerator: number, denominator: number,
    unitText: string, preparation?: string) => ({
    type: 'ingredient-line' as const,
    originalText: { value: text, language: 'en' },
    amountLexical: lexical,
    amount: { numerator, denominator },
    unitText,
    ...(preparation ? { preparation: { value: preparation, language: 'en' } } : {}),
    optional: false,
    scaling: 'linear' as const,
    substituteFor: [] as string[],
    parseStatus: 'parsed' as const,
  });
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ language: 'en', profile: 'metadata-only-v1', title: 'Lemon poppy muffins',
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: f.actor }, `recipe-${randomUUID()}`), 201);
    const path = `/v1/compositions/${shortId(created.structure)}`;
    let revision = created.revision;
    const change = async (operations: object[]) => {
      const result = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
        `${path}/changes`, { profile: 'recipe-composition', expectedHead: revision,
          actingSubject: f.actor, operations }, `recipe-${randomUUID()}`), 200);
      revision = result.revision;
      return result.occurrences;
    };
    const [cake] = await change([{ op: 'insert', parent: created.structure, position: 'last',
      role: 'group', label: { value: 'Cake', language: 'en' } }]);
    const flour = line('1½ cups flour, sifted', '1½', 3, 2, 'cups', 'sifted');
    const [flourLine] = await change([{ op: 'insert', parent: cake, position: 'last',
      role: 'ingredient', qualifier: flour }]);
    const [cakeButter] = await change([{ op: 'insert', parent: cake, position: 'last', role: 'ingredient',
      qualifier: line('200 g butter, softened', '200', 200, 1, 'g', 'softened') }]);
    const [icing] = await change([{ op: 'insert', parent: created.structure, position: 'last',
      role: 'group', label: { value: 'Icing', language: 'en' } }]);
    const [icingButter] = await change([{ op: 'insert', parent: icing, position: 'last', role: 'ingredient',
      qualifier: line('100 g butter', '100', 100, 1, 'g') }]);
    const edited = line('1 1/2 cups flour, sifted', '1 1/2', 3, 2, 'cups', 'sifted');
    const updated = await change([{ op: 'update', occurrence: flourLine, qualifier: edited }]);
    expect(updated).toEqual([]);
    const cakeLines = await f.json<{ occurrences: Array<{ occurrence: string;
      qualifier?: { originalText: { value: string }; amountLexical?: string } }> }>(await f.call('GET',
      `${path}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(cake!)}`), 200);
    expect(cakeLines.occurrences.map(item => item.occurrence)).toEqual([flourLine, cakeButter]);
    expect(cakeLines.occurrences[0]?.qualifier).toMatchObject({
      originalText: { value: '1 1/2 cups flour, sifted' }, amountLexical: '1 1/2' });
    const icingLines = await f.json<{ occurrences: Array<{ occurrence: string }> }>(await f.call('GET',
      `${path}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(icing!)}`), 200);
    expect(icingLines.occurrences.map(item => item.occurrence)).toEqual([icingButter]);
  } finally { await f.close(); }
}, 180_000);
