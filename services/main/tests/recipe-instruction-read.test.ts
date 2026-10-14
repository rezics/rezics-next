import { expect, test } from 'bun:test';
import { readRecipeInstructions } from '../src/modules/recipe/instructions.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

test('exact Post text stays available and duplicate uses share a read while retaining their order', async () => {
  const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const revision = '00000000-0000-4000-8000-000000000002';
  const variantId = `urn:rezics:variant:${revision}`;
  const first: OccurrenceRecord = { occurrence: target, parent: target, state: 'active', role: 'instruction',
    labels: [], target, introducedBy: target, selection: { mode: 'fixed-revision', revision,
      selector: { grain: 'content', revision, variantId } } };
  const second = { ...first, occurrence: target.replace(/001$/, '003') };
  let reads = 0;
  const session = { deps: { content: { readExactBatch: async (ids: string[]) => {
    reads++; expect(ids).toEqual([revision]);
    return [{ revisionId: revision, status: 'available', reference: { resourceId: target, variantId },
      body: { body: 'Exact original method.' } }];
  } } }, observeDependency() {} } as unknown as WorkReadSession;
  const instructions = await readRecipeInstructions(session, [first, second]);
  expect(reads).toBe(1);
  expect(instructions.map(item => item.occurrence)).toEqual([first.occurrence, second.occurrence]);
  expect(instructions.map(item => ({ status: item.status, text: item.text }))).toEqual([
    { status: 'available', text: 'Exact original method.' }, { status: 'available', text: 'Exact original method.' },
  ]);
});
