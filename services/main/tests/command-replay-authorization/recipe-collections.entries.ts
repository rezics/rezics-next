import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AdmissionDenied } from '../../src/modules/access/admission.ts';
import { deactivateFixtureController, grantFixtureAuthority, provisionFixturePerson }
  from '../../src/modules/access/fixture-authority.ts';
import type { RecipeCollectionOutcome } from '../../src/modules/recipe/collection-import.ts';
import { ReaderImportConflict } from '../../src/modules/library-import/reader-import.ts';
import type { ReplayEntry } from './authority-classes.ts';
import { graphSnapshot, stack } from './fixtures.ts';

export const entries: ReplayEntry[] = [{
  operation: 'POST /v1/recipes/file-imports', authorityClass: 'controller',
  scope: 'baseline:member', action: 'agent.control', family: 'Recipe collection import',
  owners: ['modules/recipe/collection-import.ts#importCollectionRecipe'],
  subcases: ['private Mela recipe'], losses: ['revoked'],
  denied: AdmissionDenied, conflict: ReaderImportConflict, registration: 'turned',
  requestBuilder: async () => {
    const member = await stack.member(randomUUID(), { verified: true });
    await provisionFixturePerson(stack.accessPool, { principalId: member.principalId,
      actor: member.actor, dataEpoch: stack.env.lineage.dataEpoch });
    const spare = await stack.member(randomUUID());
    const authority = () => grantFixtureAuthority(stack.accessPool, {
      scope: 'work:create:root', requireDispatch: true,
      representations: [member, spare].map(controller => ({ principalId: controller.principalId,
        actor: member.actor, action: 'agent.control', lifetime: 'infinity' as const })),
      grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
    });
    const control = (await authority()).representationIds[0]!;
    const source = { id: randomUUID(), title: 'Private replay recipe', inLanguage: 'en',
      ingredients: '1 cup beans', instructions: 'Simmer gently.', notes: 'A private family note.' };
    let saved: RecipeCollectionOutcome;
    const requestKey = randomUUID();
    return {
      command: async (fresh, changed) => {
        const response = await stack.call('POST', `/v1/recipes/file-imports?actingSubject=${encodeURIComponent(member.actor)}&format=melarecipe`, {
          token: member.token, key: fresh ? randomUUID() : requestKey,
          raw: Buffer.from(JSON.stringify({ ...source, ...(changed ? { title: 'Changed source' } : {}) })),
        });
        if (response.status === 403) {
          expect(await response.json()).toMatchObject({ code: 'recipe_import_denied' });
          throw new AdmissionDenied();
        }
        if (response.status === 409) {
          expect(await response.json()).toMatchObject({ code: 'recipe_import_conflict' });
          throw new ReaderImportConflict();
        }
        const page = await response.json() as { items: Array<RecipeCollectionOutcome
          | { status: 'failed'; reason: string }>; total: number; pending: boolean };
        expect(response.status, JSON.stringify(page)).toBe(200);
        expect(page).toMatchObject({ total: 1, pending: false });
        expect(page.items).toHaveLength(1);
        const item = page.items[0]!;
        if (item.status === 'failed') return { status: item.status, reason: item.reason };
        saved ??= item;
        return item;
      },
      lose: () => deactivateFixtureController(stack.accessPool, control),
      restore: async () => { await authority(); },
      snapshot: async () => ({
        graph: await Promise.all([saved.work, saved.structure, saved.content.post].map(resource =>
          graphSnapshot(resource, 'urn:rezics:receipt:absent'))),
        batches: (await stack.contentPool.query(`SELECT to_jsonb(b) AS row
          FROM reader.library_import_batch b WHERE agent = $1 ORDER BY import_key`, [member.actor])).rows,
        outcomes: (await stack.contentPool.query(`SELECT to_jsonb(o) AS row
          FROM reader.library_import_row_outcome o WHERE agent = $1 ORDER BY import_key,row_number`, [member.actor])).rows,
        steps: (await stack.contentPool.query(`SELECT to_jsonb(s) AS row
          FROM reader.library_import_step s WHERE agent = $1 ORDER BY import_key,row_number,step_key`, [member.actor])).rows,
        admissions: (await stack.accessPool.query(`SELECT to_jsonb(a) AS row
          FROM access.admission a WHERE acting_subject = $1 ORDER BY id`, [member.actor])).rows,
      }),
    };
  },
}];
