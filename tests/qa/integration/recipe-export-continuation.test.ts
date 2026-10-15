import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { assembleRecipeExport, continueRecipeExport, recipeExportCheckpoint,
  type RecipeExportCheckpoint, type RecipeExportPage } from '@rezics/model/recipe-export';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, clearVerifiedImmutableObjectCache, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { exportRecipe } from '../../../services/main/src/modules/recipe/export.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';
import { ensureFixtureScopeGate } from '../../../services/main/src/modules/access/fixture-authority.ts';

test('Recipe exports at 4097 and 8193 occurrences complete, resume, and read bounded cold neighbourhoods', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `recipe-export-continuation-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  let gets = 0;
  const get = objects.get.bind(objects);
  objects.get = async digest => { gets++; return get(digest); };
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ language: 'en', profile: 'metadata-only-v1', title: 'A complete Recipe export',
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor })), 201);
    await ensureFixtureScopeGate(f.accessPool, `work:edit:${work.work}`);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: f.actor,
    }, `recipe-export-${randomUUID()}`), 201);
    const composition = `/v1/compositions/${shortId(created.structure)}`;
    const path = `/v1/recipes/${shortId(created.structure)}/export`;
    let head = created.revision;
    const samples: number[][] = [];
    const records: OccurrenceRecord[] = [];
    for (const size of [4097, 8193]) {
      while (records.length < size) {
        const operations = Array.from({ length: Math.min(16, size - records.length) }, (_, index) => ({
          op: 'insert', parent: created.structure, position: 'last', role: 'ingredient',
          qualifier: { type: 'ingredient-line' as const,
            originalText: { value: `water ${records.length + index} ` + 'x'.repeat(200), language: 'en' },
            optional: false, scaling: 'linear' as const, substituteFor: [], parseStatus: 'parsed' as const },
        }));
        const changed = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST', `${composition}/changes`, {
          profile: 'recipe-composition', expectedHead: head, actingSubject: f.actor, operations }), 200);
        records.push(...changed.occurrences.map((occurrence, index): OccurrenceRecord => ({ occurrence,
          parent: created.structure, role: 'ingredient', state: 'active', labels: [], introducedBy: changed.revision,
          qualifier: operations[index]!.qualifier })));
        head = changed.revision;
      }
      f.account.tokenA = await f.account.tokenFor(f.account.a);
      const selectedRevision = head;
      let checkpoint = recipeExportCheckpoint(created.structure);
      const costs: number[] = [];
      let requests = 0;
      const read = async (parent: string, after?: string) => {
        if (++requests === 4) throw new Error('export interrupted');
        const query = new URLSearchParams({ actingSubject: f.actor, revision: selectedRevision, page: 'true', parent,
          ...(after ? { after } : {}) });
        clearVerifiedImmutableObjectCache(); gets = 0;
        const page = await f.json<RecipeExportPage>(await f.call('GET', `${path}?${query}`), 200);
        costs.push(gets);
        expect(page.occurrences.length).toBeLessThanOrEqual(64);
        expect(page.cost.occurrences).toBe(page.occurrences.length);
        expect(gets).toBeLessThan(128);
        return page;
      };
      const noCredits = async () => { throw new Error('Ingredients must not read Content'); };
      await expect(continueRecipeExport(checkpoint, read, noCredits)).rejects.toThrow('export interrupted');
      expect(checkpoint.pages).toHaveLength(3);
      checkpoint = JSON.parse(JSON.stringify(checkpoint)) as RecipeExportCheckpoint;
      // Advancing the head must not change a resumed revision's bytes.
      const advanced = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST', `${composition}/changes`, { profile: 'recipe-composition', expectedHead: head,
        actingSubject: f.actor, operations: [{ op: 'insert', parent: created.structure, position: 'last', role: 'equipment' }] }), 200);
      await continueRecipeExport(checkpoint, read, noCredits);
      const joined = assembleRecipeExport(checkpoint.pages, [], 'schema-org');
      expect(JSON.stringify(joined)).toBe(JSON.stringify({ profile: 'recipe-schema-org-export-v1', structure: created.structure,
        revision: selectedRevision, rights: checkpoint.pages[0]!.rights, ...exportRecipe(records, created.structure) }));
      expect(Buffer.byteLength(JSON.stringify(joined))).toBeGreaterThan(1_048_576);
      const native = assembleRecipeExport(checkpoint.pages, [], 'native');
      const fields = (value: unknown) => {
        const { occurrence, parent, role, state, labels, qualifier, introducedBy } = value as OccurrenceRecord;
        return { occurrence, parent, role, state, labels, qualifier, introducedBy };
      };
      expect('occurrences' in native && native.occurrences.map(fields)).toEqual(records.map(fields));
      samples.push(costs);
      records.push({ occurrence: advanced.occurrences[0]!, parent: created.structure, role: 'equipment', state: 'active',
        labels: [], introducedBy: advanced.revision });
      head = advanced.revision;
    }
    // Each selected record may acquire a distinct index leaf as the tree spreads.
    // The allowance follows the 64-record neighbourhood, never the inventory size.
    expect(Math.max(...samples[1]!)).toBeLessThanOrEqual(Math.max(...samples[0]!) + 64);
    f.account.tokenB = await f.account.tokenFor(f.account.b);
    const deniedQuery = new URLSearchParams({ actingSubject: f.actor, revision: head, page: 'true' });
    expect((await f.call('GET', `${path}?${deniedQuery}`, undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
  } finally { await f.close(); }
}, 600_000);
