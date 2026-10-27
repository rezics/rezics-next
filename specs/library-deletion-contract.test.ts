import { expect, test } from 'bun:test';
import type { LibraryDeletionDriver, PageTrace, Target, Values } from './library-deletion-driver.ts';

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
  ? true
  : false;
type Assert<Value extends true> = Value;

// Pure wire/fixture checks only. These construct no Access, storage, clock, or
// lifecycle runtime and make no product-success claim.
test('deletion fixture distinguishes stable source incarnation from a replacement at the same subject slot', () => {
  const original: Target = {
    kind: 'entry', id: 'subject-fixture', subjectId: 'subject-fixture', ownerId: 'owner-fixture',
    collectionId: null, incarnation: 'original-source', revision: 3, generation: 1,
    deletedAt: '2026-01-01T00:00:00.000Z', restoreUntil: '2026-01-31T00:00:00.000Z',
    values: { state: 'completed', note: 'private' }, profilePin: { release: 'accepted-release' },
  };
  const replacement: Target = { ...original, incarnation: 'replacement-source', revision: 4, deletedAt: null, restoreUntil: null };
  expect(replacement.id).toBe(original.id);
  expect(replacement.incarnation).not.toBe(original.incarnation);
  expect(Date.parse(original.restoreUntil!) - Date.parse(original.deletedAt!)).toBe(30 * 24 * 60 * 60 * 1000);
});

test('terminal account deletion contract has only deletedAt and no account restore port', () => {
  type AccountDeleteResult = Awaited<ReturnType<LibraryDeletionDriver['accountDelete']>>;
  type AccountRestorePort = Extract<
    keyof LibraryDeletionDriver,
    'restoreAccount' | 'accountRestore' | 'accountGeneration'
  >;
  const exactResult: Assert<Equal<AccountDeleteResult, { deletedAt: string }>> = true;
  const noRestorePort: Assert<Equal<AccountRestorePort, never>> = true;
  const result: AccountDeleteResult = { deletedAt: '2026-01-01T00:00:00.000Z' };

  expect(exactResult).toBe(true);
  expect(noRestorePort).toBe(true);
  expect(Object.keys(result)).toEqual(['deletedAt']);
});

test('permitted reference fixture contains identity and tombstone only without personal payload', () => {
  const reference: Values = { id: 'public-collection-fixture', kind: 'collection', state: 'deleted' };
  expect(Object.keys(reference).sort()).toEqual(['id', 'kind', 'state']);
  for (const field of ['title', 'note', 'label', 'stateValue', 'profilePin', 'accountId', 'sessionId']) expect(reference).not.toHaveProperty(field);
});

test('page evidence fixture counts examined held sources rather than only changed rows', () => {
  const page: Pick<PageTrace, 'sourceLimit' | 'examinedKeys' | 'after' | 'effects' | 'selection'> = {
    sourceLimit: 3, examinedKeys: ['held-source', 'due-source', 'lookahead-source'],
    after: 'lookahead-source', effects: 1, selection: 'source-page-before-filter',
  };
  expect(page.examinedKeys.length).toBe(page.sourceLimit);
  expect(page.examinedKeys.length).toBeGreaterThan(page.effects);
  expect(page.after).toBe(page.examinedKeys.at(-1)!);
});
