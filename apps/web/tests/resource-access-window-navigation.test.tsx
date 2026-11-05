import { expect, test } from 'bun:test';
import { AccessRecovery } from '../src/accounts/resource-access/recovery';
import type { AccessIO, AccessSnapshot, AccessState } from '../src/accounts/resource-access/data';
import { snapshot } from '../src/stories/pages/accounts-resource-access/fixtures';

function page(next: string | null) {
  return { ...structuredClone(snapshot), next };
}

function controller(initial: AccessSnapshot, read: AccessIO['read']) {
  return new AccessRecovery(
    { status: 'ready', page: initial },
    { read, save: async () => ({ status: 'saved' }), lookup: async () => null },
  );
}

test('three windows branch from the admitted predecessor and First deliberately reads without a cursor', async () => {
  const reads: (string | undefined)[] = [];
  const opaqueCursor = 'native cursor: /?+%2F Ω';
  const next = new Map<string | undefined, string | null>([
    [undefined, 'cursor-a'],
    ['cursor-a', opaqueCursor],
    [opaqueCursor, 'cursor-c'],
    ['cursor-c', null],
  ]);
  const recovery = controller(page('cursor-a'), async (cursor) => {
    reads.push(cursor);
    const result = page(next.get(cursor) ?? null);
    result.identities[1]!.displayName = cursor ?? 'First';
    return { status: 'ready', page: result };
  });

  await recovery.next();
  await recovery.next();
  await recovery.next();
  expect(recovery.snapshot().page).toMatchObject({
    status: 'ready',
    page: { identities: [{}, { displayName: 'cursor-c' }] },
  });
  next.set(opaqueCursor, 'branch');
  await recovery.previous();
  await recovery.next();
  await recovery.previous();
  await recovery.next();
  await recovery.first();

  expect(reads).toEqual([
    'cursor-a',
    opaqueCursor,
    'cursor-c',
    opaqueCursor,
    'branch',
    opaqueCursor,
    'branch',
    undefined,
  ]);
  expect(recovery.snapshot()).toMatchObject({ canPrevious: false, canFirst: false });
  expect(await recovery.previous()).toBe(false);
});

test('Previous and First keep their exact staged target through preparing, denial and thrown reads', async () => {
  const reads: (string | undefined)[] = [];
  const preparing = Promise.withResolvers<AccessState>();
  let deferPrevious = false;
  let retryingPrevious = false;
  let previousRetries = 0;
  let firstRetry = false;
  const recovery = controller(page('cursor-a'), async (cursor) => {
    reads.push(cursor);
    if (cursor === 'cursor-a' && deferPrevious) {
      deferPrevious = false;
      return preparing.promise;
    }
    if (cursor === 'cursor-a' && retryingPrevious && previousRetries++ === 0) return { status: 'denied' };
    if (cursor === 'cursor-a' && retryingPrevious && previousRetries === 2) throw new Error('Read failed');
    if (cursor === undefined && !firstRetry) {
      firstRetry = true;
      return { status: 'unavailable' };
    }
    return { status: 'ready', page: page(cursor === 'cursor-a' ? 'cursor-b' : 'cursor-a') };
  });

  await recovery.next();
  await recovery.next();
  deferPrevious = true;
  const movingBack = recovery.previous();
  expect(recovery.snapshot().busy).toBe(true);
  expect(await recovery.previous()).toBe(false);
  preparing.resolve({ status: 'preparing' });
  expect(await movingBack).toBe(false);
  expect(recovery.snapshot()).toMatchObject({ canPrevious: true, canFirst: true, page: { status: 'preparing' } });

  retryingPrevious = true;
  await recovery.retryPage();
  expect(recovery.snapshot().page.status).toBe('denied');
  await recovery.retryPage();
  expect(recovery.snapshot().page.status).toBe('unavailable');
  await recovery.retryPage();
  expect(recovery.snapshot()).toMatchObject({ canPrevious: true, canFirst: true, page: { status: 'ready' } });

  await recovery.first();
  expect(recovery.snapshot().page.status).toBe('unavailable');
  await recovery.retryPage();
  expect(recovery.snapshot()).toMatchObject({ canPrevious: false, canFirst: false, page: { status: 'ready' } });
  expect(reads).toEqual(['cursor-a', 'cursor-b', 'cursor-a', 'cursor-a', 'cursor-a', 'cursor-a', undefined, undefined]);
});

test('the retained predecessor stack is bounded to eight admitted coordinates', async () => {
  const reads: (string | undefined)[] = [];
  const recovery = controller(page('cursor-1'), async (cursor) => {
    reads.push(cursor);
    const index = cursor ? Number(cursor.slice('cursor-'.length)) : 0;
    return { status: 'ready', page: page(index < 10 ? `cursor-${index + 1}` : null) };
  });

  for (let index = 0; index < 10; index++) await recovery.next();
  for (let index = 0; index < 8; index++) await recovery.previous();
  expect(recovery.snapshot().canPrevious).toBe(false);
  expect(recovery.snapshot().canFirst).toBe(true);
  expect(reads.slice(-8)).toEqual(Array.from({ length: 8 }, (_, index) => `cursor-${9 - index}`));
});
