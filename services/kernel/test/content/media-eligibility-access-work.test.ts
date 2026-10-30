import { expect, test } from 'bun:test';
import type { ResourceEligibilityVerifyContext } from '../../src/access/eligibility.ts';
import {
  AccessWorkAccounting,
  EMPTY_ACCESS_WORK,
  accessOwnerWork,
  type AccessWork,
} from '../../src/access/work.ts';
import {
  COVER_MEDIA_WORK_DEPENDENCY,
  MEDIA_DOWNLOAD_WORK_DEPENDENCY,
  REALM_MEDIA_WORK_DEPENDENCY,
  mediaEligibilityCallbacks,
} from '../../src/content/media-eligibility-access-work.ts';

const id = '01900000-0000-7000-8000-000100000001';
const row = {
  kind: 'post' as const,
  id,
  parent_id: null,
  thread_id: id,
  board_id: null,
  realm_id: null,
  purpose: null,
  visibility: 'published',
  security_revision: '0',
  availability: 'available',
};
function context(): ResourceEligibilityVerifyContext<typeof row> {
  return {
    // Unit cases exercise only the callback's explicit native dispatch seams.
    // No fake query client is used as evidence of native SQL behavior.
    client: { query: async () => { throw new Error('Unexpected query'); } },
    actor: { kind: 'anonymous' },
    action: 'post:read',
    resource: { route: 1, id },
    evidence: row,
    at: new Date().toISOString(),
    deadline: Date.now() + 10_000,
  };
}
function accounting(refuse = false) {
  const admitted: AccessWork[] = [];
  const settled: AccessWork[] = [];
  const work = new AccessWorkAccounting({
    reserve(_operation, bound) {
      if (refuse) return null;
      admitted.push(bound);
      return { settle(actual) { settled.push(actual); } };
    },
  }, Date.now() + 10_000);
  return { work, admitted, settled };
}

test('Native media public eligibility work receipts retain independent image and container authority', async () => {
  // Accounting a current parent never replaces the separate current image
  // check, nor can an image floor override this parent's negative result.
  for (const containerVisible of [true, false]) {
    const { work, admitted, settled } = accounting();
    const callbacks = mediaEligibilityCallbacks({
      evidence: row,
      parent: { kind: 'post', route: 1, id, author: false },
      async verify(input, reads) {
        expect(input.evidence).toBe(row);
        const current = await reads.parent(async () => {
          expect(admitted).toHaveLength(1);
          expect(work.usage().rows).toBe(6);
          return [row];
        });
        return current[0] === row && containerVisible;
      },
    });
    const input = context();
    const result = await work.capture(() => accessOwnerWork(
      work, 'parent', callbacks.work!.verify, input, () => callbacks.verify(input),
    ));
    expect(result.state).toBe('complete');
    if (result.state === 'complete') expect(result.value).toBe(containerVisible);
    expect(result.usage).toEqual(settled[0]!);
    expect(result.usage).toMatchObject({ keys: 2, points: 2, rows: 6, witnesses: 0, emptySeeks: 0 });
    expect(callbacks.work!.verify.actual(input, containerVisible)).toBeUndefined();
    expect(callbacks.work!.verify.actual(context(), containerVisible)).toBeUndefined();
  }
});

test('captured initial evidence is pure preparation with exact invocation and result identity', async () => {
  const callbacks = mediaEligibilityCallbacks({ evidence: row, async verify() { return true; } });
  const input = context();
  const prepareInput = {
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    deadline: input.deadline,
    pool: {} as Parameters<typeof callbacks.prepare>[0]['pool'],
  };
  expect(callbacks.work!.prepare.bound(prepareInput)).toEqual(EMPTY_ACCESS_WORK);
  const result = await callbacks.prepare(prepareInput);
  expect(result).toBe(row);
  expect(callbacks.work!.prepare.actual({ ...prepareInput }, result)).toBeUndefined();
  expect(callbacks.work!.prepare.actual(prepareInput, { ...result })).toBeUndefined();
  const next = { ...prepareInput };
  await callbacks.prepare(next);
  expect(callbacks.work!.prepare.actual(next, result)).toEqual(EMPTY_ACCESS_WORK);
  expect(callbacks.work!.prepare.actual(next, result)).toBeUndefined();
});

test('empty parent seeks retain native plan rows and do not manufacture a public floor', async () => {
  const { work } = accounting();
  const callbacks = mediaEligibilityCallbacks({
    evidence: row,
    parent: { kind: 'thread', route: 1, id, author: false },
    async verify(_input, reads) {
      return (await reads.parent(async () => [] as typeof row[])).length > 0;
    },
  });
  const input = context();
  const result = await work.capture(() => accessOwnerWork(
    work, 'parent', callbacks.work!.verify, input, () => callbacks.verify(input),
  ));
  expect(result.state).toBe('complete');
  if (result.state === 'complete') expect(result.value).toBe(false);
  expect(result.usage).toMatchObject({ keys: 1, points: 1, rows: 4, emptySeeks: 1 });
});

test('draft author work is charged only when dispatched and failed work retains the entire admission', async () => {
  for (const failure of [false, true]) {
    const { work, admitted, settled } = accounting();
    const callbacks = mediaEligibilityCallbacks({
      evidence: row,
      parent: { kind: 'post', route: 1, id, author: true },
      async verify(_input, reads) {
        await reads.parent(async () => [row]);
        await reads.author(async () => {
          if (failure) throw new Error('Native author read failed');
          return { author_account_id: id };
        });
        return false;
      },
    });
    const input = context();
    const result = await work.capture(() => accessOwnerWork(
      work, 'parent', callbacks.work!.verify, input, () => callbacks.verify(input),
    ));
    expect(result.state).toBe(failure ? 'failed' : 'complete');
    expect(result.usage.rows).toBe(7);
    expect(result.usage).toEqual(settled[0]!);
    if (failure) {
      expect(result.usage).toEqual(admitted[0]!);
      expect(callbacks.work!.verify.actual(input, false)).toBeUndefined();
    }
  }
});

test('unproved media projections and nested subject authority refuse before their callbacks', async () => {
  for (const dependency of [MEDIA_DOWNLOAD_WORK_DEPENDENCY, REALM_MEDIA_WORK_DEPENDENCY, COVER_MEDIA_WORK_DEPENDENCY]) {
    const { work, admitted } = accounting();
    let called = false;
    const callbacks = mediaEligibilityCallbacks({
      evidence: row,
      dependency,
      async verify() { called = true; return true; },
    });
    const input = context();
    const result = await work.capture(() => accessOwnerWork(
      work, 'media', callbacks.work!.verify, input, () => callbacks.verify(input),
    ));
    expect(result).toEqual({ state: 'unavailable', dependency, usage: EMPTY_ACCESS_WORK });
    expect(called).toBe(false);
    expect(admitted).toHaveLength(0);
    // Ordinary, unmetered delivery still executes the original callback.
    expect(await callbacks.verify(input)).toBe(true);
    expect(called).toBe(true);
  }
  const { work } = accounting(true);
  let called = false;
  const callbacks = mediaEligibilityCallbacks({
    evidence: row,
    parent: { kind: 'board', route: 1, id, author: false },
    async verify(_input, reads) {
      await reads.parent(async () => { called = true; return row; });
      return true;
    },
  });
  const input = context();
  expect((await work.capture(() => accessOwnerWork(
    work, 'parent', callbacks.work!.verify, input, () => callbacks.verify(input),
  ))).state).toBe('unavailable');
  expect(called).toBe(false);
  expect(work.usage()).toEqual(EMPTY_ACCESS_WORK);
});
