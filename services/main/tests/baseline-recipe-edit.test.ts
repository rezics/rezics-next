import { expect, test } from 'bun:test';
import { baselineTarget } from '../src/modules/access/baseline.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('the author of a recipe edits its Composition on the same baseline as any Work edit', () => {
  expect(baselineTarget('recipe.edit', `work:edit:${work}`)).toEqual({ kind: 'author-work', id: work });
  expect(baselineTarget('work.edit', `work:edit:${work}`)).toEqual({ kind: 'author-work', id: work });
  // The scope is the Work's edit scope only; no other prefix reaches an author's recipe.
  expect(baselineTarget('recipe.edit', `content:publish:${work}`)).toBeNull();
  expect(baselineTarget('recipe.edit', 'work:edit:not-an-id')).toBeNull();
});
