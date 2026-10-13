import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { sourceFieldOccurrence } from '../../../services/main/src/modules/source/support-attach.ts';
import { ensureFixtureScopeGate } from '../../../services/main/src/modules/access/fixture-authority.ts';

type Occurrence = { occurrence: string; parent: string; role: string; sourceKey: string;
  labels: Array<{ value: string; language: string }>;
  qualifier?: { originalText?: { value: string; language: string };
    instructionText?: { value: string; language: string } } };
type RecipePage = { revision: string; next?: string; occurrences: Occurrence[];
  ingredients: Array<{ originalText: string; amount?: { numerator: number; denominator: number } }> };
type Imported = { revision: string; sourceObservation: string; supports?: string[];
  unboundSourceKeys?: string[]; receipts: string[]; replayed?: boolean };

test('Recipe imports preserve retained parents, interleaved siblings and empty groups through HTTP', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-section-parents-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  // Authored fixture text; these headings express transcriber layout only.
  const ingredientTexts = ['  1 cup flour\n', '7/8 cup water'];
  const step = (text: string) => ({ '@type': 'HowToStep', text });
  const section = (name: string, itemListElement: unknown[], inLanguage = 'en') =>
    ({ '@type': 'HowToSection', name, inLanguage, itemListElement });
  const emptyLabels = Array.from({ length: 17 }, (_, index) => `Empty sibling ${index}`);
  const recipe = { '@context': 'https://schema.org', '@type': 'Recipe', inLanguage: 'en',
    recipeIngredient: ingredientTexts,
    recipeInstructions: [section('Transcriber layout', [step('  Begin.\n'),
      section('Continuation', [step(' Mélanger.\n'), section('Deep empty', [], 'fr'),
        step('Terminer.  ')], 'fr'), step('Finish outer.\n'), section('Empty annotation', [])]),
    step('Root continuation.\n'), section('Other layout', [step('Other step.  ')]),
    ...emptyLabels.map(label => section(label, []))] };
  const bytes = Buffer.from(JSON.stringify(recipe));
  try {
    for (const mode of ['observation', 'file'] as const) {
      const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
        await f.authoredBody({ profile: 'metadata-only-v1', title: `Retained Recipe layout ${mode}`,
          language: 'en', semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor })), 201);
      await f.grant(`work:edit:${work.work}`, 'recipe.edit');
      await f.grant(`work:edit:${work.work}`, 'work.edit');
      await f.grant(`work:read:${work.work}`, 'work.read');
      const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
        '/v1/compositions', { profile: 'recipe-composition', work: work.work,
          mainVersion: work.mainVersion, actingSubject: f.actor }), 201);
      const recipePath = `/v1/recipes/${shortId(created.structure)}`;
      const readPath = `/v1/recipes/works/${shortId(work.work)}?actingSubject=${encodeURIComponent(f.actor)}`;
      const readRecipe = async () => {
        const page = await f.json<RecipePage>(await f.call('GET', readPath), 200);
        let cursor = page.next;
        const cursors = new Set<string>();
        while (cursor) {
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
          const next = await f.json<RecipePage>(await f.call('GET',
            `${readPath}&cursor=${encodeURIComponent(cursor)}`), 200);
          expect(next.revision).toBe(page.revision);
          page.occurrences.push(...next.occurrences);
          page.ingredients.push(...next.ingredients);
          cursor = next.next;
        }
        return page;
      };
      const importKey = `recipe-layout-${randomUUID()}`;
      let observation: { observation: string; record: string } | undefined;
      if (mode === 'observation') {
        observation = (await f.json<{ observation: { observation: string; record: string } }>(
          await f.call('POST', '/v1/sources/intakes', { profile: 'source-manual-intake-v1',
            provider: 'recipe-fixture', namespace: 'recipe', externalId: randomUUID(), sourceRevision: '1',
            mediaType: 'application/ld+json', retention: 'retained', rawBytesBase64: bytes.toString('base64'),
            coverage: { scope: 'complete-recipe', complete: true, omittedFields: [] },
            rightsEvidence: { basis: 'original', note: 'Fixture author confirmed these exact lines' },
          }), 201)).observation;
      }
      const importRecipe = (expectedHead: string, key = importKey, token: string | null = f.account.tokenA) =>
        mode === 'observation' ? f.call('POST', `${recipePath}/imports`, {
          sourceObservation: observation!.observation, expectedHead, actingSubject: f.actor,
        }, key, token) : f.callRaw('POST', `${recipePath}/file-imports`
          + `?actingSubject=${encodeURIComponent(f.actor)}&expectedHead=${encodeURIComponent(expectedHead)}`,
        bytes, 'application/ld+json', key, token);
      expect((await importRecipe(created.revision, importKey, f.account.noScope)).status).toBe(401);
      const imported = await f.json<Imported>(await importRecipe(created.revision), mode === 'file' ? 201 : 200);
      const retained = await f.json<{ rawBytesBase64: string }>(await f.call('GET',
        `/v1/sources/observations/${shortId(imported.sourceObservation)}`), 200);
      expect(retained.rawBytesBase64).toBe(bytes.toString('base64'));
      const page = await readRecipe();
      expect(page.revision).toBe(imported.revision);
      const groups = page.occurrences.filter(row => row.role === 'group');
      const group = (label: string) => groups.find(row => row.labels[0]?.value === label)!;
      expect(groups.map(row => row.labels)).toEqual([
        ['Transcriber layout', 'en'], ['Continuation', 'fr'], ['Deep empty', 'fr'],
        ['Empty annotation', 'en'], ['Other layout', 'en'], ...emptyLabels.map(label => [label, 'en']),
      ].map(([value, language]) => [{ value, language }]));
      expect(groups.map(row => row.parent)).toEqual([created.structure,
        group('Transcriber layout').occurrence, group('Continuation').occurrence,
        group('Transcriber layout').occurrence, created.structure, ...emptyLabels.map(() => created.structure)]);
      const text = (row: Occurrence) => row.labels[0]?.value
        ?? row.qualifier?.instructionText?.value ?? row.qualifier?.originalText?.value;
      expect(page.occurrences.map(text)).toEqual(['Transcriber layout', '  Begin.\n', 'Continuation',
        ' Mélanger.\n', 'Deep empty', 'Terminer.  ', 'Finish outer.\n', 'Empty annotation',
        'Root continuation.\n', 'Other layout', 'Other step.  ', ...emptyLabels, ...ingredientTexts]);
      const steps = page.occurrences.filter(row => row.role === 'step');
      expect(steps.map(row => row.parent)).toEqual([group('Transcriber layout').occurrence,
        group('Continuation').occurrence, group('Continuation').occurrence,
        group('Transcriber layout').occurrence, created.structure, group('Other layout').occurrence]);
      expect(steps.map(row => row.qualifier?.instructionText?.language)).toEqual(['en', 'fr', 'fr', 'en', 'en', 'en']);
      for (const label of ['Deep empty', 'Empty annotation', ...emptyLabels])
        expect(page.occurrences.filter(row => row.parent === group(label).occurrence)).toEqual([]);
      expect(page.ingredients.map(row => row.originalText)).toEqual(ingredientTexts);
      expect(page.ingredients.map(row => row.amount)).toEqual([
        { numerator: 1, denominator: 1 }, { numerator: 7, denominator: 8 },
      ]);
      if (mode === 'observation') {
        expect(imported.unboundSourceKeys).toEqual([]);
        expect(imported.supports).toHaveLength(8);
        const lines = [...page.occurrences.filter(row => row.role === 'ingredient'), ...steps];
        const pointers = ['/recipeIngredient/0', '/recipeIngredient/1',
          '/recipeInstructions/0/itemListElement/0/text', '/recipeInstructions/0/itemListElement/1/itemListElement/0/text',
          '/recipeInstructions/0/itemListElement/1/itemListElement/2/text', '/recipeInstructions/0/itemListElement/2/text',
          '/recipeInstructions/1/text', '/recipeInstructions/2/itemListElement/0/text'];
        for (const [index, support] of imported.supports!.entries()) {
          const binding = await f.json<{ occurrence: string; sourceOccurrence: string; nativeRevision: string }>(
            await f.call('GET', `/v1/sources/field-supports/${shortId(support)}`), 200);
          expect(binding).toMatchObject({ occurrence: lines[index]!.occurrence, nativeRevision: imported.revision,
            sourceOccurrence: sourceFieldOccurrence(observation!.observation, 'recipe',
              index < 2 ? 'recipeIngredient' : 'recipeInstructions', pointers[index]!) });
        }
      }
      expect(await f.json<Imported>(await importRecipe(created.revision), 200))
        .toMatchObject(mode === 'file' ? { ...imported, replayed: true } : imported);
      expect((await readRecipe()).occurrences).toEqual(page.occurrences);
      expect((await importRecipe(created.revision, `stale-${randomUUID()}`)).status).toBe(409);
      if (mode === 'file') {
        // Ordinary flat imports still append their own groups/content and replay
        // without disturbing an existing retained hierarchy.
        const flatBytes = Buffer.from(JSON.stringify({ '@type': 'Recipe', recipeIngredient: ['1 cup salt'],
          recipeInstructions: [section('Flat layout', [step('Mix the salt.')])] }));
        const flatKey = `recipe-flat-${randomUUID()}`;
        const flatImport = () => f.callRaw('POST', `${recipePath}/file-imports`
          + `?actingSubject=${encodeURIComponent(f.actor)}&expectedHead=${encodeURIComponent(imported.revision)}`,
        flatBytes, 'application/json', flatKey);
        const flat = await f.json<Imported>(await flatImport(), 201);
        const flatPage = await readRecipe();
        expect(flatPage.occurrences.slice(0, page.occurrences.length)).toEqual(page.occurrences);
        expect(flatPage.occurrences.slice(page.occurrences.length).map(text))
          .toEqual(['Flat layout', 'Mix the salt.', '1 cup salt']);
        expect(await f.json<Imported>(await flatImport(), 200)).toMatchObject({ ...flat, replayed: true });
        expect((await readRecipe()).occurrences).toEqual(flatPage.occurrences);
      }
      await ensureFixtureScopeGate(f.accessPool, `work:edit:${work.work}`, { open: false });
      expect((await importRecipe(created.revision)).status).toBe(403);
    }
  } finally { await f.close(); }
}, 240_000);
